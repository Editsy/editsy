/**
 * The editsy HTTP API as a fetch-style handler (Request → Response), so the
 * exact same code serves `editsy edit`'s local server (via a node adapter)
 * and a framework route handler in a deployed site (v2, @editsy/next).
 */
import { createTwoFilesPatch } from "diff";
import picomatch from "picomatch";
import {
  checkLogin,
  clearSessionCookie,
  createLoginToken,
  createSession,
  findEditor,
  sessionCookie,
  sessionFromRequest,
  verifyLoginToken,
  type AuthConfig,
  type SessionUser,
} from "./auth.js";
import { AssetExistsError, ConflictError, type ContentBackend } from "./backend.js";
import type { Mailer } from "./mailer.js";
import { RateLimiter, clientKey } from "./rate-limit.js";
import { readContent } from "./ast/read.js";
import { applyValues, WriteError } from "./ast/write.js";
import { toValues, type Value } from "./model.js";

export interface ApiOptions {
  backend: ContentBackend;
  /** When set, every endpoint except the auth ones requires a valid session. */
  auth?: AuthConfig;
  /** Enables magic-link login when set alongside auth. */
  mailer?: Mailer;
  /**
   * The site's canonical origin (e.g. "https://www.example.com"). Magic-link
   * emails build their URLs from it. Without it they fall back to the
   * request's own URL, whose host comes from the Host header, which, behind
   * a proxy that doesn't pin that header, an attacker can choose, redirecting
   * a victim's login link to a domain they control. Set it on any deployment
   * that sends login emails.
   */
  baseUrl?: string;
}

export type ApiHandler = (req: Request, pathname: string) => Promise<Response | null>;

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/**
 * Build the API handler. `pathname` is the request path relative to wherever
 * the API is mounted (e.g. "/api/state" whether served from localhost:4499
 * or yoursite.com/editsy). Returns null for non-API paths.
 */
export function createApiHandler({ backend, auth, mailer, baseUrl }: ApiOptions): ApiHandler {
  // Blunt brute force at WordPress-parity: 10 login tries / 15 min per
  // client+email, 5 emails / 15 min for magic links.
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const linkLimiter = new RateLimiter(5, 15 * 60 * 1000);

  return async (req, pathname) => {
    if (!pathname.startsWith("/api/")) return null;
    try {
      return await route(req, pathname);
    } catch (err) {
      // Anything unexpected (a config error, a backend network failure, a
      // filesystem error) becomes a clean 500 instead of an opaque platform
      // crash page. Every error thrown by this module is our own message
      // text (never a raw stack trace or a secret), so it's safe to return.
      return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  async function route(req: Request, pathname: string): Promise<Response> {
    // Behind a TLS-terminating proxy the request URL says http even though
    // the browser connection is https; the forwarded proto (or a configured
    // https base URL) knows better. Secure controls the cookie's Secure
    // attribute and __Host- prefix, so err on the side of true.
    const secure =
      new URL(req.url).protocol === "https:" ||
      req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" ||
      baseUrl?.startsWith("https:") === true;

    // Open: which login methods this server supports (drives the login UI).
    if (pathname === "/api/auth") {
      const methods: string[] = [];
      if (auth?.editors.some((e) => e.password ?? e.passwordHash)) methods.push("password");
      if (auth && mailer) methods.push("magicLink");
      return json(200, { methods });
    }

    if (pathname === "/api/login" && req.method === "POST") {
      if (!auth) return json(400, { error: "auth is not enabled on this server" });
      const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
      const email = body.email ?? "";
      if (!loginLimiter.allow(`${clientKey(req)}|${email.toLowerCase()}`)) {
        return json(429, { error: "too many attempts; try again in a few minutes" });
      }
      const user = await checkLogin(email, body.password ?? "", auth);
      if (!user) return json(401, { error: "wrong email or password" });
      return json(200, { user }, { "set-cookie": sessionCookie(createSession(user, auth), auth, secure) });
    }

    // Magic link, step 1: email a short-lived login URL. Always answers 200
    // so the endpoint doesn't reveal who is an editor.
    if (pathname === "/api/request-link" && req.method === "POST") {
      if (!auth || !mailer) return json(400, { error: "email login is not enabled on this server" });
      const body = (await req.json().catch(() => ({}))) as { email?: string };
      const email = body.email ?? "";
      if (!linkLimiter.allow(clientKey(req))) {
        return json(429, { error: "too many requests; try again in a few minutes" });
      }
      const editor = findEditor(email, auth);
      if (editor) {
        // The request's path is trustworthy (it's how this handler was
        // reached, so a base path like /editsy survives), but its HOST is
        // the Host header. When a canonical base URL is configured, the
        // link's origin comes from there instead; a forged Host header
        // must not choose where an editor's login link points.
        const url = new URL(req.url);
        if (baseUrl) {
          const canonical = new URL(baseUrl);
          url.protocol = canonical.protocol;
          url.host = canonical.host;
        }
        url.pathname = url.pathname.replace(/\/api\/request-link$/, "/api/magic");
        url.search = `?token=${encodeURIComponent(createLoginToken(editor.email, auth))}`;
        await mailer.send({
          to: editor.email,
          subject: "Your editsy login link",
          text: `Log in to edit the site (link is valid for 15 minutes):\n\n${url.toString()}\n\nIf you didn't request this, ignore it.`,
        });
      }
      return json(200, { sent: true });
    }

    // Magic link, step 2, the emailed URL: set the session, land in the editor.
    if (pathname === "/api/magic") {
      if (!auth) return json(400, { error: "auth is not enabled on this server" });
      const token = new URL(req.url).searchParams.get("token") ?? undefined;
      const user = verifyLoginToken(token, auth);
      if (!user) {
        return new Response("This login link is invalid or expired. Request a new one.", {
          status: 401,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      const editorHome = new URL(req.url).pathname.replace(/\/api\/magic$/, "") || "/";
      return new Response(null, {
        status: 302,
        headers: {
          location: editorHome,
          "set-cookie": sessionCookie(createSession(user, auth), auth, secure),
        },
      });
    }

    if (pathname === "/api/logout" && req.method === "POST") {
      return json(200, { ok: true }, { "set-cookie": clearSessionCookie(secure) });
    }

    let user: SessionUser | null = null;
    if (auth) {
      user = sessionFromRequest(req, auth);
      if (!user) return json(401, { error: "login required" });
    }

    if (pathname === "/api/state") {
      const info = backend.info();
      const files = await backend.listContentFiles();
      return json(200, {
        files,
        siteUrl: info.siteUrl,
        mode: info.mode,
        user,
        theme: info.theme ?? null,
        warning: info.warning ?? null,
      });
    }

    if (pathname === "/api/assets") {
      return json(200, { assets: await backend.listAssets() });
    }

    // Upload an image into the assets root (under uploads/). Never
    // overwrites: name collisions get a numeric suffix. In git-backed
    // backends this is an immediate commit, like a media library.
    if (pathname === "/api/upload" && req.method === "POST") {
      if (!backend.writeAsset) {
        return json(400, { error: "this backend doesn't support uploads" });
      }
      const body = (await req.json().catch(() => ({}))) as { name?: string; dataBase64?: string };
      if (!body.name || !body.dataBase64) {
        return json(400, { error: "missing `name` or `dataBase64`" });
      }
      // Cheap size gate before decoding (base64 is 4/3 of the bytes).
      if (body.dataBase64.length > (UPLOAD_MAX_BYTES * 4) / 3 + 4) {
        return json(413, { error: `image too large (the limit is ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB)` });
      }
      const name = sanitizeAssetName(body.name);
      if (!name) {
        return json(400, {
          error: `that file type can't be uploaded; allowed: ${[...UPLOAD_EXTENSIONS].join(", ")}`,
        });
      }
      const data = Buffer.from(body.dataBase64, "base64");
      if (data.length === 0 || data.length > UPLOAD_MAX_BYTES) {
        return json(413, { error: `image too large (the limit is ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB)` });
      }
      if (!magicBytesMatch(name, data)) {
        return json(400, { error: "the file's contents don't look like its extension; upload refused" });
      }

      const taken = new Set((await backend.listAssets()).map((p) => p.toLowerCase()));
      const dot = name.lastIndexOf(".");
      const stem = name.slice(0, dot);
      const ext = name.slice(dot);
      for (let n = 1; n <= 50; n++) {
        const candidate = `uploads/${n === 1 ? name : `${stem}-${n}${ext}`}`;
        if (taken.has(`/${candidate}`.toLowerCase())) continue;
        try {
          const { path } = await backend.writeAsset(candidate, data, { author: user ?? undefined });
          return json(200, { path: `/${path}` });
        } catch (err) {
          if (err instanceof AssetExistsError) continue; // raced; try the next name
          throw err;
        }
      }
      return json(409, { error: "couldn't find a free filename; rename the file and try again" });
    }

    if (pathname === "/api/content") {
      const file = await validateFile(new URL(req.url).searchParams.get("file"), backend);
      if (typeof file !== "string") return file;
      const { text, rev } = await backend.readContent(file);
      const { doc, issues } = readContent(file, text);
      return json(200, { doc, issues, values: doc ? toValues(doc.root) : null, rev });
    }

    // Create a new content file as a copy of an existing one, the "new
    // post" workflow for file-per-entry sites. In git-backed backends this
    // is an immediate commit, like an upload.
    if (pathname === "/api/duplicate" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { file?: string; name?: string };
      const source = await validateFile(body.file ?? null, backend);
      if (typeof source !== "string") return source;
      const globs = backend.info().contentGlobs;
      if (!globs) return json(400, { error: "this backend doesn't support creating files" });

      const name = sanitizeContentName(body.name ?? "", source);
      if (!name) return json(400, { error: "that name doesn't work; use letters, numbers, dots, and dashes" });
      const dir = source.includes("/") ? source.slice(0, source.lastIndexOf("/") + 1) : "";
      const target = dir + name;
      if (!picomatch(globs)(target)) {
        return json(400, {
          error: `"${target}" wouldn't be picked up as a content file (globs: ${globs.join(", ")})`,
        });
      }
      // Case-insensitive: Windows and macOS filesystems are, and a
      // case-only "new" name would silently OVERWRITE the original there.
      const targetLower = target.toLowerCase();
      if ((await backend.listContentFiles()).some((f) => f.toLowerCase() === targetLower)) {
        return json(409, { error: `${target} already exists; pick another name` });
      }
      const { text } = await backend.readContent(source);
      try {
        await backend.writeContent(target, text, {
          message: `editsy: create ${target} (copy of ${source})`,
          author: user ?? undefined,
        });
      } catch (err) {
        if (err instanceof ConflictError) {
          return json(409, { error: `${target} was just created by someone else; pick another name` });
        }
        throw err;
      }
      return json(200, { file: target });
    }

    if (pathname === "/api/save" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        // Multi-file shape: the editor publishes every edited file at once,
        // as ONE commit in git-backed backends (one rebuild, not one each).
        files?: { file?: string; values?: Value; baseRev?: string }[];
        // Single-file shape, kept working for scripts and older callers.
        file?: string;
        values?: Value;
        baseRev?: string;
        dryRun?: boolean;
      };
      const multi = Array.isArray(body.files);
      const specs = multi
        ? body.files!
        : [{ file: body.file, values: body.values, baseRev: body.baseRev }];
      if (specs.length === 0) return json(400, { error: "`files` is empty" });

      const known = await backend.listContentFiles();
      const prepared: { file: string; values: Value; baseRev: string }[] = [];
      for (const spec of specs) {
        if (!spec.file) return json(400, { error: "missing `file`" });
        if (!known.includes(spec.file)) {
          return json(403, { error: `not a configured content file: ${spec.file}` });
        }
        if (spec.values === undefined) {
          return json(400, { error: `missing \`values\` for ${spec.file}` });
        }
        // Required, not merely honored when present: without it, a write
        // can't actually detect that the file changed since the caller last
        // read it, silently defeating the conflict guarantee saves have.
        if (spec.baseRev === undefined) {
          return json(400, { error: `missing \`baseRev\` for ${spec.file}` });
        }
        if (prepared.some((p) => p.file === spec.file)) {
          return json(400, { error: `duplicate file in save: ${spec.file}` });
        }
        prepared.push({ file: spec.file, values: spec.values, baseRev: spec.baseRev });
      }

      const stale: string[] = [];
      const results: { file: string; diff: string; changed: boolean; rev: string; after: string }[] = [];
      for (const { file, values, baseRev } of prepared) {
        const { text: before, rev: currentRev } = await backend.readContent(file);
        if (baseRev !== currentRev) {
          stale.push(file);
          continue;
        }
        let after: string;
        try {
          after = applyValues(file, before, values);
        } catch (err) {
          if (err instanceof WriteError) return json(422, { error: err.message });
          throw err;
        }
        results.push({
          file,
          diff: createTwoFilesPatch(file, file, before, after, "on disk", "after save"),
          changed: before !== after,
          rev: currentRev,
          after,
        });
      }
      if (stale.length > 0) return json(409, { error: new ConflictError(stale).message });

      const changed = results.filter((r) => r.changed);
      const respond = (written: boolean) =>
        multi
          ? json(200, {
              written,
              results: results.map(({ file, diff, changed, rev }) => ({ file, diff, changed, rev })),
            })
          : json(200, {
              diff: results[0]!.diff,
              written,
              changed: results[0]!.changed,
              rev: results[0]!.rev,
            });

      if (body.dryRun || changed.length === 0) return respond(false);
      try {
        if (changed.length > 1 && backend.writeMany) {
          const { revs } = await backend.writeMany(
            changed.map(({ file, after, rev }) => ({ file, text: after, baseRev: rev })),
            { author: user ?? undefined },
          );
          for (const r of changed) r.rev = revs[r.file] ?? r.rev;
        } else {
          for (const r of changed) {
            const { rev } = await backend.writeContent(r.file, r.after, {
              baseRev: r.rev,
              message: `editsy: update ${r.file}`,
              author: user ?? undefined,
            });
            r.rev = rev;
          }
        }
      } catch (err) {
        if (err instanceof ConflictError) return json(409, { error: err.message });
        throw err;
      }
      return respond(true);
    }

    return json(404, { error: "unknown API route" });
  }
}

/**
 * Reduce a requested filename for a duplicated content file to a safe
 * basename in the source's directory, forcing the source's extension.
 */
export function sanitizeContentName(raw: string, source: string): string | undefined {
  // Custom globs can match extensionless files; don't let lastIndexOf(-1)
  // turn the source's final character into an "extension".
  const dotAt = source.lastIndexOf(".");
  const ext = dotAt > source.lastIndexOf("/") ? source.slice(dotAt) : "";
  const base = raw.split(/[/\\]/).pop() ?? "";
  let cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/\.+/g, ".");
  // People type extensions from habit; strip ANY familiar content extension
  // (typing "post.md" while duplicating a .ts file must not yield .md.ts).
  cleaned = cleaned.replace(/\.(ts|json|md)$/i, "");
  cleaned = cleaned.replace(/[.-]+$/, "");
  if (cleaned.length === 0) return undefined;
  return cleaned + ext;
}

const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Formats editors may upload. Deliberately narrower than what image fields
 * can REFERENCE (IMAGE_GLOB): no SVG (can carry scripts and would be served
 * from the site's origin, the same reason WordPress refuses them) and no
 * ICO (nobody uploads favicons through a CMS; keep the parser surface small).
 */
const UPLOAD_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);

/**
 * Reduce a user-supplied filename to a safe basename: strip any directory
 * part, keep word characters/dot/dash, require an allowed image extension.
 * Returns undefined when nothing safe remains.
 */
export function sanitizeAssetName(raw: string): string | undefined {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  const dot = cleaned.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const stem = cleaned
    .slice(0, dot)
    .replace(/\.+/g, ".") // no ".." tricks inside
    .replace(/[-.]+$/, ""); // "photo (1).png" → "photo-1.png", not "photo-1-.png"
  const ext = cleaned.slice(dot + 1).toLowerCase();
  if (!UPLOAD_EXTENSIONS.has(ext) || stem.length === 0) return undefined;
  return `${stem}.${ext}`;
}

/** The first bytes must agree with the claimed extension. */
export function magicBytesMatch(name: string, data: Buffer): boolean {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const ascii = (start: number, text: string) =>
    data.length >= start + text.length && data.toString("latin1", start, start + text.length) === text;
  switch (ext) {
    case "png":
      return data.length >= 8 && data[0] === 0x89 && ascii(1, "PNG");
    case "jpg":
    case "jpeg":
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case "gif":
      return ascii(0, "GIF8");
    case "webp":
      return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "avif":
      return ascii(4, "ftyp");
    default:
      return false;
  }
}

async function validateFile(file: string | null, backend: ContentBackend): Promise<string | Response> {
  if (!file) return json(400, { error: "missing `file`" });
  const files = await backend.listContentFiles();
  if (!files.includes(file)) return json(403, { error: `not a configured content file: ${file}` });
  return file;
}
