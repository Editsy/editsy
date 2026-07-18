/**
 * The slice of MCP this server needs: JSON-RPC 2.0 over stdio, one message
 * per line, tools only. Small enough to own (the official SDK brings two
 * web frameworks along for a server that never opens a socket). Kept apart
 * from the editsy logic so it could be swapped for the SDK without touching
 * the tools.
 *
 * Protocol reference: modelcontextprotocol.io, stdio transport. Messages
 * are newline-delimited JSON on stdin/stdout; anything a human should see
 * goes to stderr.
 */

/** Protocol revisions this server can speak. Tools behave the same in all of them. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0]!;

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  inputSchema: object;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** What a tool call produces. `isError` reports tool-level failures (bad file, conflict) in-band. */
export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ServerOptions {
  name: string;
  version: string;
  /** Usage notes handed to the client on initialize; most clients show them to the model. */
  instructions?: string;
  tools: ToolDef[];
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = object;

function result(id: number | string | null, payload: object): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: payload };
}

function error(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Turn one incoming message into at most one response. Notifications and
 * malformed frames without an id produce undefined (nothing is sent back).
 * Exported as a plain function so tests can drive the protocol without
 * spawning a process.
 */
export function createDispatcher(opts: ServerOptions): (message: unknown) => Promise<JsonRpcResponse | undefined> {
  return async (message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return error(null, -32600, "expected a JSON-RPC message object");
    }
    const msg = message as JsonRpcMessage;
    const id = msg.id ?? null;
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return isRequest ? error(id, -32600, "not a JSON-RPC 2.0 request") : undefined;
    }

    switch (msg.method) {
      case "initialize": {
        const asked = (msg.params?.protocolVersion as string) ?? "";
        return result(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: opts.name, version: opts.version },
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
        });
      }
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, {
          tools: opts.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case "tools/call": {
        const name = msg.params?.name;
        const tool = opts.tools.find((t) => t.name === name);
        if (!tool) return error(id, -32602, `unknown tool: ${String(name)}`);
        try {
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
          const { text, isError } = await tool.handler(args);
          return result(id, { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
        } catch (err) {
          // Tool failures are results, not protocol errors: the model should
          // read them and adjust, the same way it reads a failed shell command.
          const text = err instanceof Error ? err.message : String(err);
          return result(id, { content: [{ type: "text", text }], isError: true });
        }
      }
      default:
        // Unknown notifications (notifications/initialized etc.) are fine to
        // ignore; unknown requests owe the client an error.
        return isRequest ? error(id, -32601, `method not found: ${msg.method}`) : undefined;
    }
  };
}

/** Run the server on stdin/stdout until stdin closes. */
export async function serveStdio(dispatch: (message: unknown) => Promise<JsonRpcResponse | undefined>): Promise<void> {
  const { createInterface } = await import("node:readline");
  const lines = createInterface({ input: process.stdin, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify(error(null, -32700, "parse error")) + "\n");
      continue;
    }
    const response = await dispatch(parsed);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  }
}
