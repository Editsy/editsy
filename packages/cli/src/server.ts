/**
 * `editsy edit`: the local editor server (D3). A thin node:http adapter
 * over the shared fetch-style API (api.ts) with a LocalDiskBackend. Auth is
 * intentionally off: this server binds to 127.0.0.1 only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createApiHandler } from "./api.js";
import { LocalDiskBackend } from "./backend.js";
import { loadConfig } from "./config.js";
import { resolveEditorDist, serveEditorAsset } from "./static.js";

export interface ServerOptions {
  root: string;
  port: number;
}

export async function startServer(opts: ServerOptions): Promise<Server> {
  const config = await loadConfig(opts.root);
  const api = createApiHandler({ backend: new LocalDiskBackend(opts.root, config) });
  const editorDist = resolveEditorDist();

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const request = toRequest(req);
    const pathname = new URL(request.url).pathname;
    const response = (await api(request, pathname)) ?? (await serveEditorAsset(pathname, editorDist));
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  return server;
}

/** node:http IncomingMessage → WHATWG Request. */
function toRequest(req: IncomingMessage): Request {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }
  const body = method === "GET" || method === "HEAD" ? undefined : req;
  return new Request(url, {
    method,
    headers,
    body: body as unknown as BodyInit,
    // @ts-expect-error node fetch needs duplex for streamed bodies
    duplex: "half",
  });
}
