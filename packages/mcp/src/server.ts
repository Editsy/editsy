/**
 * The editsy MCP tools: list, read, write, check. Everything routes through
 * the same code paths the editor uses (LocalDiskBackend for containment and
 * conflict checks, readContent/applyValues for the AST round trip), so an
 * agent gets the same guarantees a human editor does: values change, comments
 * and formatting stay, and a stale file is refused rather than overwritten.
 */
import {
  LocalDiskBackend,
  applyValues,
  loadConfig,
  readContent,
  runCheck,
  formatCheckResult,
  toValues,
  type EditsyConfig,
  type FieldNode,
  type Value,
} from "@editsy/cli";
import { createTwoFilesPatch } from "diff";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ServerOptions, ToolDef, ToolResult } from "./rpc.js";

async function open(root: string): Promise<{ config: EditsyConfig; backend: LocalDiskBackend }> {
  const config = await loadConfig(root);
  return { config, backend: new LocalDiskBackend(root, config) };
}

/**
 * A compact schema view of a parsed document: leaf fields become their kind
 * ("text", "markdown", ...), selects list their options, collections report
 * their item shape. Sent alongside values so the model knows which strings
 * are markdown, which are dates, and what a new collection item looks like.
 */
export function describeFields(node: FieldNode): unknown {
  switch (node.kind) {
    case "select":
      return `select: one of ${JSON.stringify(node.options ?? [])}`;
    case "list":
      return "list of strings";
    case "object":
      return Object.fromEntries(Object.entries(node.fields).map(([key, child]) => [key, describeFields(child)]));
    case "collection": {
      const sample = node.items[0] ?? node.template;
      return {
        collection: node.items.length,
        itemShape: sample ? describeFields(sample) : {},
        hasTemplate: node.template !== undefined,
      };
    }
    default:
      return node.kind;
  }
}

export async function listContentFiles(root: string): Promise<{ files: string[]; globs: string[] }> {
  const { config, backend } = await open(root);
  return { files: await backend.listContentFiles(), globs: config.content };
}

export interface ReadResult {
  file: string;
  rev: string;
  kind: "content" | "collection";
  exports?: string[];
  fields: unknown;
  values: Value;
}

export async function readContentFile(root: string, file: string): Promise<ReadResult> {
  const { backend } = await open(root);
  await ensureContentFile(backend, file);
  const { text, rev } = await backend.readContent(file);
  const parsed = readContent(file, text);
  if (!parsed.doc) {
    const first = parsed.issues[0];
    throw new Error(
      first
        ? `${file}:${first.line}:${first.column}: ${first.message}`
        : `${file} is not a content file editsy can parse`,
    );
  }
  return {
    file,
    rev,
    kind: parsed.doc.type,
    ...(parsed.doc.exports ? { exports: parsed.doc.exports } : {}),
    fields: describeFields(parsed.doc.root),
    values: toValues(parsed.doc.root),
  };
}

export interface WriteResult {
  file: string;
  rev: string;
  diff: string;
}

export async function writeContentFile(
  root: string,
  file: string,
  values: Value,
  baseRev?: string,
): Promise<WriteResult> {
  const { backend } = await open(root);
  await ensureContentFile(backend, file);
  const { text, rev } = await backend.readContent(file);
  const newText = applyValues(file, text, values);
  // The backend re-checks the rev at write time, so a file that changed
  // between our read and the write is refused rather than clobbered.
  const written = await backend.writeContent(file, newText, { baseRev: baseRev ?? rev });
  return { file, rev: written.rev, diff: createTwoFilesPatch(file, file, text, newText) };
}

export async function checkContent(root: string): Promise<{ ok: boolean; summary: string }> {
  const check = await runCheck(root);
  return { ok: check.problems.length === 0, summary: formatCheckResult(check) };
}

/** Only paths the config globs recognize are editable; everything else on disk is off limits. */
async function ensureContentFile(backend: LocalDiskBackend, file: string): Promise<void> {
  const files = await backend.listContentFiles();
  if (!files.includes(file)) {
    throw new Error(`${file} is not a content file (known files: ${files.join(", ") || "none"})`);
  }
}

function json(value: unknown): ToolResult {
  return { text: JSON.stringify(value, null, 2) };
}

const VALUES_HELP =
  "Send back the same shape read_content returned in `values`, with your edits applied. " +
  "Strings, numbers, booleans, and string arrays map directly. Collections keep their " +
  '{ "$collection": true, "items": [...] } shape: edit an item\'s `value` to change it, remove an ' +
  "entry to delete it, reorder entries to reorder items, and add a new entry as " +
  '{ "$src": <index of the existing item whose shape it copies>, "value": { ... } } (or ' +
  '{ "$template": true, "value": { ... } } when the collection reports hasTemplate). ' +
  "Change values only; the file's structure, comments, and formatting are preserved by the save.";

/** The MCP server definition for a project root; hand this to serveStdio(createDispatcher(...)). */
export function createEditsyMcp(root: string): ServerOptions {
  const require = createRequire(import.meta.url);
  const { version } = JSON.parse(readFileSync(require.resolve("../package.json"), "utf8")) as { version: string };
  const tools: ToolDef[] = [
    {
      name: "list_content_files",
      description:
        "List the editable content files of this editsy project (the files matching its content globs). " +
        "Start here; other tools only accept paths from this list.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => json(await listContentFiles(root)),
    },
    {
      name: "read_content",
      description:
        "Read one content file as structured data: `values` holds the current content, `fields` maps each " +
        "field to its kind (text, markdown, date, image path, select with options, ...), and `rev` identifies " +
        "this version for conflict-checked writes.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Root-relative path from list_content_files, forward slashes" },
        },
        required: ["file"],
        additionalProperties: false,
      },
      handler: async (args) => json(await readContentFile(root, String(args.file))),
    },
    {
      name: "write_content",
      description:
        "Save edited values into a content file and return a unified diff of what changed. " +
        VALUES_HELP +
        " Pass `baseRev` from read_content so a file that changed underneath you is refused instead of overwritten.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Root-relative path from list_content_files" },
          values: { description: "The edited values tree, in the shape read_content returned" },
          baseRev: { type: "string", description: "The rev this edit was based on, from read_content" },
        },
        required: ["file", "values"],
        additionalProperties: false,
      },
      handler: async (args) =>
        json(
          await writeContentFile(
            root,
            String(args.file),
            args.values as Value,
            args.baseRev === undefined ? undefined : String(args.baseRev),
          ),
        ),
    },
    {
      name: "check_content",
      description:
        "Validate every content file in the project (the same check `npx editsy check` runs in CI). " +
        "Run it after a batch of edits.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        const check = await checkContent(root);
        return { text: check.summary, isError: !check.ok };
      },
    },
  ];

  return {
    name: "editsy",
    version,
    instructions:
      "This server edits the content files of a site that uses editsy (a file-based CMS; the files are the " +
      "database). Typical flow: list_content_files, read_content, edit the values, write_content with the rev " +
      "you read, and check_content after bulk changes. Edit values only: copy, dates, image paths, list items. " +
      "Structure, layout, and code live in the site's components and are out of scope for these tools.",
    tools,
  };
}
