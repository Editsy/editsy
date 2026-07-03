/**
 * @editsy/next: remote mode (D8), the editsy admin, served from your
 * deployed Next.js site. One catch-all route gives editors
 * `yoursite.com/editsy`: log in, edit, publish (a git commit behind the
 * scenes when the GitHub backend is configured).
 *
 * Setup, in app/editsy/[[...editsy]]/route.ts:
 *
 *   import { createEditsy } from "@editsy/next";
 *   export const { GET, POST } = createEditsy();
 *
 * Environment:
 *   EDITSY_SECRET        session-cookie signing secret (long + random)
 *   EDITSY_EDITORS       JSON [{ "name", "email", "password" }, ...]
 *   EDITSY_GITHUB_REPO   "owner/repo"  → saves become commits (production)
 *   EDITSY_GITHUB_TOKEN  fine-grained PAT scoped to that repo
 *   EDITSY_GITHUB_BRANCH branch to commit to (default "main")
 *
 * Without GitHub variables the backend is the local filesystem, right for
 * `next dev`, wrong for serverless production (read-only, ephemeral disk).
 */
import {
  DEFAULT_CONFIG,
  GitHubBackend,
  LocalDiskBackend,
  authFromEnv,
  createApiHandler,
  loadEditorsFile,
  mailerFromEnv,
  resolveEditorDist,
  serveEditorAsset,
  type AuthConfig,
  type ContentBackend,
  type EditsyConfig,
  type Mailer,
} from "@editsy/cli";

export interface CreateEditsyOptions {
  /** Where the route is mounted. Default "/editsy". */
  basePath?: string;
  /** Content globs / assets root / site URL. Defaults match editsy.config.ts defaults. */
  config?: Partial<EditsyConfig>;
  /** Override the backend entirely (e.g. a custom ContentBackend). */
  backend?: ContentBackend;
  /** Override auth; defaults to EDITSY_SECRET + EDITSY_EDITORS / editsy.editors.json. */
  auth?: AuthConfig;
  /** Override the magic-link mailer; defaults to SMTP from EDITSY_SMTP_URL. */
  mailer?: Mailer;
  /**
   * The site's canonical origin, e.g. "https://www.example.com". Magic-link
   * emails build their URLs from it instead of trusting the request's Host
   * header. Defaults to EDITSY_BASE_URL, or the config's siteUrl when that
   * is an absolute URL.
   */
  baseUrl?: string;
}

export interface EditsyRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
}

export function createEditsy(options: CreateEditsyOptions = {}): EditsyRouteHandlers {
  const basePath = (options.basePath ?? "/editsy").replace(/\/$/, "");
  const config: EditsyConfig = {
    ...DEFAULT_CONFIG,
    // In remote mode the "preview" is simply the live site.
    siteUrl: "/",
    ...options.config,
  };
  const backend = options.backend ?? backendFromEnv(config);
  const mailer = options.mailer ?? mailerFromEnv();
  const baseUrl =
    options.baseUrl ??
    process.env.EDITSY_BASE_URL ??
    (/^https?:\/\//.test(config.siteUrl) ? config.siteUrl : undefined);
  const production = process.env.NODE_ENV === "production";
  const editorDist = resolveEditorDist();

  // Editors can come from env or a committed editsy.editors.json (hashed
  // passwords, .htpasswd-style); resolved once, lazily.
  let apiPromise: Promise<ReturnType<typeof createApiHandler>> | undefined;
  const api = () =>
    (apiPromise ??= (async () => {
      const auth =
        options.auth ?? authFromEnv(process.env, await loadEditorsFile(process.cwd()).catch(() => undefined));
      if (production && !auth) authMissing = true;
      return createApiHandler({ backend, auth, mailer, baseUrl });
    })());
  let authMissing = false;

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(basePath)) return new Response("not found", { status: 404 });

    let apiHandler: Awaited<ReturnType<typeof api>>;
    try {
      apiHandler = await api();
    } catch (err) {
      // A config problem (malformed EDITSY_EDITORS JSON, a bad editors
      // file) shouldn't crash the whole route with an opaque platform
      // error page; say what's wrong instead.
      return new Response(
        `editsy configuration error: ${err instanceof Error ? err.message : String(err)}`,
        { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    // Deploying editors without auth would hand write access to the world.
    if (authMissing) {
      return new Response(
        "editsy is disabled: configure EDITSY_SECRET plus EDITSY_EDITORS (or editsy.editors.json) to enable editor logins in production.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    // Next normalizes away trailing slashes, so the editor lives at exactly
    // basePath; a <base> tag makes its relative asset/API URLs resolve.
    const sub = url.pathname === basePath ? "/" : url.pathname.slice(basePath.length);
    return (
      (await apiHandler(req, sub)) ?? serveEditorAsset(sub, editorDist, { baseHref: `${basePath}/` })
    );
  };

  return { GET: handler, POST: handler };
}

function backendFromEnv(config: EditsyConfig): ContentBackend {
  const repo = process.env.EDITSY_GITHUB_REPO;
  const token = process.env.EDITSY_GITHUB_TOKEN;
  if (repo && token) {
    return new GitHubBackend({
      repo,
      token,
      branch: process.env.EDITSY_GITHUB_BRANCH,
      config,
    });
  }
  const disk = new LocalDiskBackend(process.cwd(), config);
  if (process.env.NODE_ENV !== "production") return disk;
  // Most serverless hosts reset the filesystem on every deploy (or run it
  // read-only), so local-disk saves in production either fail outright or
  // silently don't persist past the next cold start. This is a real,
  // working setup on a traditional always-on Node server, though, so warn
  // rather than block; the editor shows this as a banner.
  return withWarning(
    disk,
    "No EDITSY_GITHUB_REPO/EDITSY_GITHUB_TOKEN configured: saves write to this server's local " +
      "disk. On most serverless hosts (Vercel, etc.) that filesystem is read-only or reset on " +
      "every deploy, so edits may fail or silently vanish. Configure the GitHub backend unless " +
      "you know this host has a persistent, writable filesystem.",
  );
}

/** Wrap a backend so its info() always reports the given warning. */
function withWarning(backend: ContentBackend, warning: string): ContentBackend {
  return {
    info: () => ({ ...backend.info(), warning }),
    listContentFiles: () => backend.listContentFiles(),
    readContent: (file) => backend.readContent(file),
    writeContent: (file, text, opts) => backend.writeContent(file, text, opts),
    ...(backend.writeMany
      ? { writeMany: (items, opts) => backend.writeMany!(items, opts) }
      : {}),
    ...(backend.writeAsset
      ? { writeAsset: (path, data, opts) => backend.writeAsset!(path, data, opts) }
      : {}),
    listAssets: () => backend.listAssets(),
  };
}
