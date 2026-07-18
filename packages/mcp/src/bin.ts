/**
 * `editsy-mcp [--root <dir>]`: serve the editsy tools over stdio for an MCP
 * client (Claude Code, Cursor, Claude Desktop, ...). Register it as e.g.
 *   claude mcp add editsy -- npx -y @editsy/mcp
 * run from the site's repo, or pass --root when the client starts it elsewhere.
 */
import { resolve } from "node:path";
import { createDispatcher, serveStdio } from "./rpc.js";
import { createEditsyMcp } from "./server.js";

const args = process.argv.slice(2);
let root = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root" && args[i + 1]) root = resolve(args[++i]!);
  else if (args[i] === "--help" || args[i] === "-h") {
    console.error("usage: editsy-mcp [--root <project dir>]");
    process.exit(0);
  }
}

serveStdio(createDispatcher(createEditsyMcp(root))).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
