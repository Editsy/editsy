/** Serve the built @editsy/editor assets, fetch-style, for any host (CLI server or site route). */
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

export function resolveEditorDist(): string | undefined {
  const require = createRequire(import.meta.url);
  // Route 1: normal module resolution from THIS file's location. Works
  // whenever this code runs from its real node_modules home (the CLI, next
  // dev, or a site that externalizes @editsy/cli via serverExternalPackages).
  try {
    const pkg = require.resolve("@editsy/editor/package.json");
    const dist = join(dirname(pkg), "dist");
    if (existsSync(join(dist, "index.html"))) return dist;
  } catch {
    // fall through
  }
  try {
    const dist = dirname(require.resolve("@editsy/editor/dist/index.html"));
    return dist;
  } catch {
    // fall through
  }
  // Route 2: when a bundler has inlined this code (import.meta.url then
  // points into the site's build output, where resolution can't see pnpm's
  // isolated store), look for the editor in the layouts package managers
  // actually produce, relative to the working directory. On serverless
  // hosts this finds the files a correctly configured
  // outputFileTracingIncludes carried along.
  const candidates = [join(process.cwd(), "node_modules", "@editsy", "editor", "dist")];
  const store = join(process.cwd(), "node_modules", ".pnpm");
  try {
    for (const entry of readdirSync(store)) {
      if (entry.startsWith("@editsy+editor@") || entry.startsWith("@editsy+cli@")) {
        candidates.push(join(store, entry, "node_modules", "@editsy", "editor", "dist"));
      }
    }
  } catch {
    // no pnpm store, nothing to add
  }
  return candidates.find((dist) => existsSync(join(dist, "index.html")));
}

/**
 * Serve an editor asset for a path relative to the editor root ("/",
 * "/assets/index-x.js"). Unknown paths fall back to index.html (SPA).
 * `baseHref` (e.g. "/editsy/") is injected as a <base> tag into index.html
 * so the editor's relative asset/API URLs resolve when it is mounted under
 * a site path instead of at "/".
 */
export async function serveEditorAsset(
  pathname: string,
  dist: string | undefined,
  opts?: { baseHref?: string },
): Promise<Response> {
  if (!dist) {
    return new Response(
      "<h1>editsy</h1><p>The editor UI isn't built. Run <code>pnpm --filter @editsy/editor build</code> and restart.</p>",
      { headers: { "content-type": MIME[".html"]! } },
    );
  }
  const rel = pathname === "/" || pathname === "" ? "/index.html" : pathname;
  let path = normalize(join(dist, rel));
  // Boundary-aware containment (plain startsWith would also admit a sibling
  // directory that happens to share the "dist" prefix).
  if (!path.startsWith(normalize(dist) + sep) || !existsSync(path)) {
    path = join(dist, "index.html");
    if (!existsSync(path)) return new Response("not found", { status: 404 });
  }
  if (path.endsWith("index.html") && opts?.baseHref) {
    const html = (await readFile(path, "utf8")).replace(
      "<head>",
      `<head><base href="${opts.baseHref}" />`,
    );
    return new Response(html, { headers: { "content-type": MIME[".html"]! } });
  }
  const body = await readFile(path);
  const immutable = rel.startsWith("/assets/");
  return new Response(body, {
    headers: {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
      ...(immutable ? { "cache-control": "public, max-age=31536000, immutable" } : {}),
    },
  });
}
