/**
 * `editsy-mcp [--root <dir>]`: serve the editsy tools over stdio for an MCP
 * client (Claude Code, Cursor, Claude Desktop, ...). Register it as e.g.
 *   claude mcp add editsy -- npx -y @editsy/mcp
 * run from the site's repo, or pass --root when the client starts it elsewhere.
 */
import { resolve } from "node:path";
import { createDispatcher, serveStdio } from "./rpc.js";
import { createEditsyMcp } from "./server.js";

const USAGE = "usage: editsy-mcp [--root <project dir>]";
const args = process.argv.slice(2);
let root = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root") {
    const value = args[++i];
    if (!value) {
      console.error(`--root needs a directory\n${USAGE}`);
      process.exit(1);
    }
    root = resolve(value);
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.error(USAGE);
    process.exit(0);
  } else {
    console.error(`unknown option: ${args[i]}\n${USAGE}`);
    process.exit(1);
  }
}

serveStdio(createDispatcher(createEditsyMcp(root))).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
