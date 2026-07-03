/**
 * `editsy doctor`: check a project's editsy setup and say what's wrong in
 * actionable terms. Every real-world failure we've seen was configuration
 * (missing tracing config, absent auth vars, malformed editors JSON, an
 * expired GitHub token), so this converts those from support issues into
 * one command.
 *
 * Never prints a secret's VALUE, only whether it exists and looks sane.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEditorsFile, parseEditors, type Editor } from "./auth.js";
import { runCheck } from "./check.js";
import { findContentFiles, loadConfig } from "./config.js";
import { resolveEditorDist } from "./static.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorOptions {
  root: string;
  /** Injectable for tests. Defaults to process.env merged over .env files. */
  env?: Record<string, string | undefined>;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Minimal KEY=VALUE parser for presence checks. The CLI runs outside the
 * framework, so .env files a host or `next dev` would load aren't in
 * process.env; reading them here keeps doctor's answers accurate. No
 * expansion, no interpolation; values are only ever tested, not used.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]!] = value;
  }
  return out;
}

async function collectEnv(root: string): Promise<Record<string, string | undefined>> {
  const merged: Record<string, string | undefined> = {};
  // Lowest precedence first; process.env wins, matching how hosts behave.
  for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    try {
      Object.assign(merged, parseDotenv(await readFile(join(root, file), "utf8")));
    } catch {
      // no such file; that's fine
    }
  }
  return { ...merged, ...process.env };
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorCheck[]> {
  const { root } = opts;
  const env = opts.env ?? (await collectEnv(root));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const checks: DoctorCheck[] = [];
  const add = (label: string, status: DoctorStatus, detail: string) =>
    checks.push({ label, status, detail });

  // -- content ---------------------------------------------------------
  let configOk = true;
  try {
    const config = await loadConfig(root);
    const files = await findContentFiles(root, config);
    if (files.length === 0) {
      add(
        "content files",
        "warn",
        `none found (looked for ${config.content.join(", ")}); check the globs in editsy.config.ts`,
      );
    } else {
      const { problems } = await runCheck(root);
      if (problems.length > 0) {
        add(
          "content files",
          "fail",
          `${files.length} found, but ${problems.length} have issues; run \`editsy check\` for details`,
        );
      } else {
        add("content files", "ok", `${files.length} found, all valid`);
      }
    }
  } catch (err) {
    configOk = false;
    add("editsy.config.ts", "fail", err instanceof Error ? err.message : String(err));
  }
  if (!configOk) return checks;

  // -- editor UI --------------------------------------------------------
  const editorDist = resolveEditorDist();
  add(
    "editor UI",
    editorDist ? "ok" : "fail",
    editorDist
      ? "@editsy/editor build found"
      : "@editsy/editor's built dist wasn't found; reinstall @editsy/cli (or, in the editsy repo itself, build the editor)",
  );

  // -- auth -------------------------------------------------------------
  const secret = env.EDITSY_SECRET;
  if (!secret) {
    add("EDITSY_SECRET", "warn", "not set; required for the deployed editor (production answers 503 without it)");
  } else if (secret.length < 16) {
    add("EDITSY_SECRET", "warn", "set, but short; use a long random value");
  } else {
    add("EDITSY_SECRET", "ok", "set");
  }

  let editors: Editor[] = [];
  let editorsSource = "";
  try {
    if (env.EDITSY_EDITORS) {
      editors = parseEditors(env.EDITSY_EDITORS, "EDITSY_EDITORS");
      editorsSource = "EDITSY_EDITORS";
    }
    const fromFile = await loadEditorsFile(root);
    if (fromFile) {
      editors = [...editors, ...fromFile];
      editorsSource = editorsSource ? `${editorsSource} + editsy.editors.json` : "editsy.editors.json";
    }
  } catch (err) {
    add("editors", "fail", err instanceof Error ? err.message : String(err));
  }
  if (editorsSource) {
    const plaintext = editors.filter((e) => e.password && !e.passwordHash).length;
    add(
      "editors",
      plaintext > 0 ? "warn" : "ok",
      `${editors.length} configured via ${editorsSource}` +
        (plaintext > 0 ? `, ${plaintext} with a PLAINTEXT password (fine for dev, hash for production)` : ""),
    );
  } else if (!checks.some((c) => c.label === "editors")) {
    add("editors", "warn", "none configured; the deployed editor needs EDITSY_EDITORS or editsy.editors.json");
  }

  // -- magic-link base URL ----------------------------------------------
  if (env.EDITSY_SMTP_URL) {
    const base = env.EDITSY_BASE_URL;
    if (!base) {
      add(
        "EDITSY_BASE_URL",
        "warn",
        "not set; login-link emails will build their URL from the request's Host header; " +
          "set the site's canonical origin (e.g. https://www.example.com) so a forged header can't redirect them",
      );
    } else if (!/^https?:\/\//.test(base)) {
      add("EDITSY_BASE_URL", "fail", `should be an absolute origin like https://www.example.com, got something else`);
    } else {
      add("EDITSY_BASE_URL", "ok", `login links point at ${base}`);
    }
  }

  // -- GitHub backend ---------------------------------------------------
  const repo = env.EDITSY_GITHUB_REPO;
  const token = env.EDITSY_GITHUB_TOKEN;
  if (!repo && !token) {
    add(
      "GitHub backend",
      "warn",
      "not configured, which is fine locally; the deployed editor needs EDITSY_GITHUB_REPO and EDITSY_GITHUB_TOKEN to publish",
    );
  } else if (!repo || !token) {
    add("GitHub backend", "fail", `only ${repo ? "EDITSY_GITHUB_REPO" : "EDITSY_GITHUB_TOKEN"} is set; both are needed`);
  } else if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    add("GitHub backend", "fail", `EDITSY_GITHUB_REPO should be "owner/repo", got something else`);
  } else {
    // The live test: this is what catches expired and underscoped tokens.
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (res.status === 401) {
        add("GitHub backend", "fail", "the token was rejected (expired or revoked); generate a new fine-grained PAT");
      } else if (res.status === 404) {
        add(
          "GitHub backend",
          "fail",
          `the token can't see ${repo}: wrong repo name, or the token wasn't granted access to it`,
        );
      } else if (!res.ok) {
        add("GitHub backend", "warn", `GitHub answered ${res.status}; try again, or check https://www.githubstatus.com`);
      } else {
        const body = (await res.json()) as { permissions?: { push?: boolean }; default_branch?: string };
        const branch = env.EDITSY_GITHUB_BRANCH ?? body.default_branch ?? "main";
        if (body.permissions && body.permissions.push === false) {
          add("GitHub backend", "fail", `the token can READ ${repo} but not write; it needs the Contents read/write permission`);
        } else {
          add("GitHub backend", "ok", `token can access ${repo} (publishing to ${branch})`);
        }
      }
    } catch {
      add("GitHub backend", "warn", "couldn't reach api.github.com to test the token; are you offline?");
    }
  }

  // -- Next.js integration ----------------------------------------------
  const pkgRaw = await readFile(join(root, "package.json"), "utf8").catch(() => undefined);
  const pkg = pkgRaw ? (JSON.parse(pkgRaw) as { dependencies?: object; devDependencies?: object }) : undefined;
  const isNext =
    !!pkg && ("next" in (pkg.dependencies ?? {}) || "next" in (pkg.devDependencies ?? {}));
  if (isNext) {
    const routeExists = ["app", "src/app"].some((d) =>
      existsSync(join(root, d, "editsy", "[[...editsy]]", "route.ts")),
    );
    add(
      "/editsy route",
      routeExists ? "ok" : "warn",
      routeExists
        ? "found"
        : "not found; run `editsy init` to create app/editsy/[[...editsy]]/route.ts",
    );

    const nextConfig = ["next.config.ts", "next.config.js", "next.config.mjs"].find((f) =>
      existsSync(join(root, f)),
    );
    if (nextConfig) {
      const text = await readFile(join(root, nextConfig), "utf8");
      // Proximity matching, not bare substrings: a comment that merely
      // mentions a package name must not pass the check.
      const missing = [
        !/serverExternalPackages[\s\S]{0,200}?@editsy\/cli/.test(text) &&
          `serverExternalPackages: ["@editsy/cli"]`,
        !/outputFileTracingIncludes[\s\S]{0,400}?@editsy\/editor/.test(text) &&
          "the outputFileTracingIncludes globs",
      ].filter(Boolean);
      add(
        "next.config",
        missing.length > 0 ? "warn" : "ok",
        missing.length > 0
          ? `${nextConfig} is missing ${missing.join(" and ")}; the DEPLOYED editor breaks without them (https://editsy.dev/docs/remote)`
          : `${nextConfig} has the editsy blocks`,
      );
    } else {
      add("next.config", "warn", "no next.config found; run `editsy init` to create one with the editsy blocks");
    }
  }

  return checks;
}

const ICONS: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatDoctorResult(checks: DoctorCheck[]): string {
  const lines = checks.map((c) => `${ICONS[c.status]} ${c.label}: ${c.detail}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push(
    fails > 0
      ? `\n✗ ${fails} problem${fails === 1 ? "" : "s"} to fix${warns > 0 ? `, ${warns} warning${warns === 1 ? "" : "s"}` : ""}`
      : warns > 0
        ? `\n! Nothing broken, ${warns} warning${warns === 1 ? "" : "s"} worth a look`
        : "\n✓ Everything checks out",
  );
  return lines.join("\n");
}
