/**
 * Programmatic surface of @editsy/mcp: the server definition plus the plain
 * functions behind each tool, for anyone embedding the tools elsewhere.
 */
export { createDispatcher, serveStdio, type ServerOptions, type ToolDef, type ToolResult } from "./rpc.js";
export {
  checkContent,
  createEditsyMcp,
  describeFields,
  listContentFiles,
  readContentFile,
  writeContentFile,
  type ReadResult,
  type WriteResult,
} from "./server.js";
