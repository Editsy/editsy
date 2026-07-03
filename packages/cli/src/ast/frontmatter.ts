/**
 * Markdown content files: YAML-style frontmatter plus a body.
 *
 *   ---
 *   title: Hello world
 *   date: 2026-07-03
 *   tags: [intro, news]
 *   ---
 *
 *   The **body**, edited as rich text.
 *
 * No YAML dependency. We parse the frontmatter SUBSET that maps onto
 * editsy's field model (scalar strings/numbers/booleans and lists of
 * strings, inline or block style) and flag anything else (nested maps,
 * block scalars, anchors) as an issue instead of guessing. Same philosophy
 * as the TypeScript reader: constraints, stated loudly.
 *
 * Writes are surgical, like the AST writer: only a changed value's bytes
 * on its own line are replaced. An untouched file round-trips byte-exact,
 * CRLF and all.
 */
import {
  WriteError,
  type ContentDoc,
  type FieldNode,
  type Issue,
  type Value,
} from "../model.js";

/** Strings at least this long (or containing newlines) infer as textarea. */
const TEXTAREA_THRESHOLD = 120;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Region {
  start: number;
  end: number;
}

interface FmEntry {
  key: string;
  node: FieldNode;
  region: Region;
  style: "scalar" | "inline-list" | "block-list";
  /** Indentation of block-list items, for style-preserving rewrites. */
  itemIndent: string;
  line: number;
}

export interface ParsedMarkdown {
  doc?: ContentDoc;
  issues: Issue[];
  entries: FmEntry[];
  /** The raw text after the closing delimiter (or the whole file when there's no frontmatter). */
  bodyRegion: Region;
  /** What the editor sees: the raw body minus one leading blank line. */
  bodyValue: string;
  eol: "\n" | "\r\n";
}

export function readMarkdownFile(file: string, text: string): ParsedMarkdown {
  const issues: Issue[] = [];
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const entries: FmEntry[] = [];
  const issueAt = (line: number, message: string) => issues.push({ message, line, column: 1 });

  let bodyStart = 0;
  const opening = /^---\r?\n/.exec(text);
  if (opening) {
    // Split the frontmatter block into lines with their absolute offsets.
    const lines: { start: number; raw: string }[] = [];
    let pos = opening[0].length;
    let closed = false;
    while (pos <= text.length) {
      const nl = text.indexOf("\n", pos);
      const end = nl === -1 ? text.length : nl;
      const raw = text.slice(pos, end).replace(/\r$/, "");
      if (raw === "---") {
        closed = true;
        bodyStart = nl === -1 ? text.length : nl + 1;
        break;
      }
      lines.push({ start: pos, raw });
      if (nl === -1) break;
      pos = nl + 1;
    }
    if (!closed) {
      issueAt(1, "frontmatter never closes; expected a second --- line");
      return { issues, entries: [], bodyRegion: { start: 0, end: text.length }, bodyValue: text, eol };
    }
    parseFrontmatter(lines, text, entries, issueAt);
  }

  const rawBody = text.slice(bodyStart);
  const bodyValue = bodyStart === 0 ? rawBody : rawBody.replace(/^\r?\n/, "");

  const fields: Record<string, FieldNode> = {};
  for (const entry of entries) fields[entry.key] = entry.node;
  fields.body = { kind: "markdown", value: bodyValue, annotated: true };

  return {
    doc: { file, type: "content", root: { kind: "object", fields } },
    issues,
    entries,
    bodyRegion: { start: bodyStart, end: text.length },
    bodyValue,
    eol,
  };
}

function parseFrontmatter(
  lines: { start: number; raw: string }[],
  text: string,
  entries: FmEntry[],
  issueAt: (line: number, message: string) => void,
): void {
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const { start, raw } = lines[i]!;
    const lineNo = 2 + i; // 1-based; line 1 is the opening ---
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

    if (/^\s/.test(raw)) {
      issueAt(lineNo, "indented frontmatter lines (nested maps, block scalars) aren't supported");
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+):(\s*)(.*)$/.exec(raw);
    if (!m) {
      issueAt(lineNo, "expected `key: value`");
      continue;
    }
    const [, key, gap, rest] = m as unknown as [string, string, string, string];
    if (seen.has(key)) {
      issueAt(lineNo, `duplicate key "${key}"; the first one wins`);
      continue;
    }
    if (key === "body") {
      issueAt(lineNo, `"body" is reserved for the markdown body; rename this frontmatter key`);
      continue;
    }

    if (rest.trim() === "") {
      // Either a block list follows, or it's something we don't support.
      const items: string[] = [];
      const itemLines: number[] = [];
      let itemIndent = "";
      let j = i + 1;
      while (j < lines.length) {
        const itemMatch = /^(\s+)-\s+(.*)$/.exec(lines[j]!.raw);
        if (!itemMatch) break;
        itemIndent = itemMatch[1]!;
        items.push(unquoteScalar(stripBareComment(itemMatch[2]!.trim()), 2 + j, issueAt));
        itemLines.push(j);
        j++;
      }
      if (items.length === 0) {
        issueAt(lineNo, `"${key}" has no value; empty values and nested structures aren't supported`);
        continue;
      }
      const lastLine = lines[itemLines[itemLines.length - 1]!]!;
      const lastLineEnd = endOfLine(text, lastLine.start);
      seen.add(key);
      entries.push({
        key,
        node: { kind: "list", items },
        // From right after the colon through the last item, a rewrite
        // replaces the whole block, keeping the block style.
        region: { start: start + key.length + 1, end: lastLineEnd },
        style: "block-list",
        itemIndent,
        line: lineNo,
      });
      i = j - 1;
      continue;
    }

    // Separate the value from a trailing ` # comment`; real YAML parsers
    // do, and the region must exclude it so the comment survives edits.
    const rawValue = rest.trim();
    let valueText: string;
    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      const closeAt = findClosingQuote(rawValue);
      if (closeAt === -1) {
        issueAt(lineNo, `"${key}" has an unterminated quoted value`);
        continue;
      }
      const after = rawValue.slice(closeAt + 1).trim();
      if (after !== "" && !after.startsWith("#")) {
        issueAt(lineNo, `"${key}" has content after its quoted value that editsy doesn't understand`);
        continue;
      }
      valueText = rawValue.slice(0, closeAt + 1);
    } else {
      valueText = stripBareComment(rawValue);
      if (valueText === "") {
        issueAt(lineNo, `"${key}" has no value; empty values and nested structures aren't supported`);
        continue;
      }
    }
    const valueStart = start + key.length + 1 + gap.length;
    const region = { start: valueStart, end: valueStart + valueText.length };
    seen.add(key);

    if (valueText.startsWith("[") && valueText.endsWith("]")) {
      entries.push({
        key,
        node: { kind: "list", items: parseInlineList(valueText, lineNo, issueAt) },
        region,
        style: "inline-list",
        itemIndent: "",
        line: lineNo,
      });
      continue;
    }
    entries.push({
      key,
      node: scalarNode(valueText, lineNo, issueAt),
      region,
      style: "scalar",
      itemIndent: "",
      line: lineNo,
    });
  }
}

/** Cut an unquoted value at a ` #` comment, like YAML parsers do. */
function stripBareComment(value: string): string {
  const m = /\s#/.exec(value);
  return m ? value.slice(0, m.index).trimEnd() : value;
}

/** Index of the quote closing the one the value starts with, or -1. */
function findClosingQuote(value: string): number {
  const quote = value[0]!;
  for (let i = 1; i < value.length; i++) {
    const ch = value[i]!;
    if (quote === '"' && ch === "\\") {
      i++; // skip the escaped character
    } else if (ch === quote) {
      if (quote === "'" && value[i + 1] === "'") {
        i++; // '' is an escaped quote inside single quotes
      } else {
        return i;
      }
    }
  }
  return -1;
}

function endOfLine(text: string, lineStart: number): number {
  const nl = text.indexOf("\n", lineStart);
  if (nl === -1) return text.length;
  return text[nl - 1] === "\r" ? nl - 1 : nl;
}

function scalarNode(
  valueText: string,
  line: number,
  issueAt: (line: number, message: string) => void,
): FieldNode {
  if (valueText === "true" || valueText === "false") {
    return { kind: "boolean", value: valueText === "true" };
  }
  if (/^-?\d+(\.\d+)?$/.test(valueText)) return { kind: "number", value: Number(valueText) };
  const value = unquoteScalar(valueText, line, issueAt);
  const kind = ISO_DATE_RE.test(value)
    ? "date"
    : value.length >= TEXTAREA_THRESHOLD
      ? "textarea"
      : "text";
  return { kind, value, annotated: false };
}

function unquoteScalar(
  valueText: string,
  line: number,
  issueAt: (line: number, message: string) => void,
): string {
  if (valueText.startsWith('"') && valueText.endsWith('"') && valueText.length >= 2) {
    try {
      // YAML double-quoted scalars overlap JSON strings for everything we
      // ever WRITE; reading someone else's exotic escapes fails loudly.
      return JSON.parse(valueText) as string;
    } catch {
      issueAt(line, "couldn't parse this quoted value: unsupported escape sequence");
      return valueText.slice(1, -1);
    }
  }
  if (valueText.startsWith("'") && valueText.endsWith("'") && valueText.length >= 2) {
    return valueText.slice(1, -1).replace(/''/g, "'");
  }
  return valueText;
}

function parseInlineList(
  valueText: string,
  line: number,
  issueAt: (line: number, message: string) => void,
): string[] {
  const inner = valueText.slice(1, -1).trim();
  if (inner === "") return [];
  // Split on commas outside quotes. Quotes in frontmatter tags are rare;
  // this covers them without a parser dependency.
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
    } else if (ch === ",") {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map((item) => unquoteScalar(item.trim(), line, issueAt));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Bare scalars a YAML parser reads back as the same string. */
function printFmString(value: string): string {
  if (ISO_DATE_RE.test(value)) return value; // dates stay bare, like everyone writes them
  const bareSafe =
    /^[A-Za-z][A-Za-z0-9 ._/()-]*$/.test(value) &&
    !/\s$/.test(value) &&
    !/^(true|false|null|yes|no|on|off)$/i.test(value);
  // JSON string escaping is a strict subset of YAML double-quoted escaping.
  return bareSafe ? value : JSON.stringify(value);
}

export function applyMarkdownValues(file: string, text: string, values: Value): string {
  const parsed = readMarkdownFile(file, text);
  if (!parsed.doc) {
    const first = parsed.issues[0];
    throw new WriteError(
      `cannot save: ${first ? first.message : "not a valid markdown content file"}`,
      file,
      first?.line,
    );
  }
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new WriteError("expected an object of field values", file);
  }
  const vals = values as Record<string, Value>;
  const edits: TextEdit[] = [];

  for (const entry of parsed.entries) {
    if (!Object.hasOwn(vals, entry.key)) continue; // untouched field
    const v = vals[entry.key]!;

    if (entry.node.kind === "list") {
      if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
        throw new WriteError(`"${entry.key}" expects a list of strings`, file, entry.line);
      }
      if (JSON.stringify(v) === JSON.stringify(entry.node.items)) continue;
      const printed = (v as string[]).map(printFmString);
      // Block-list regions start right after the colon; inline regions start
      // at the value itself; the replacements differ accordingly.
      const replacement =
        entry.style === "block-list"
          ? v.length > 0
            ? parsed.eol + printed.map((p) => `${entry.itemIndent}- ${p}`).join(parsed.eol)
            : " []"
          : `[${printed.join(", ")}]`;
      edits.push({ ...entry.region, text: replacement });
      continue;
    }

    if (entry.node.kind === "number") {
      if (typeof v !== "number") throw new WriteError(`"${entry.key}" expects a number`, file, entry.line);
      if (v === entry.node.value) continue;
      edits.push({ ...entry.region, text: String(v) });
      continue;
    }
    if (entry.node.kind === "boolean") {
      if (typeof v !== "boolean") throw new WriteError(`"${entry.key}" expects true or false`, file, entry.line);
      if (v === entry.node.value) continue;
      edits.push({ ...entry.region, text: String(v) });
      continue;
    }
    // text / textarea / date
    if (typeof v !== "string") throw new WriteError(`"${entry.key}" expects a string`, file, entry.line);
    if (v === (entry.node as { value: string }).value) continue;
    edits.push({ ...entry.region, text: printFmString(v) });
  }

  if (Object.hasOwn(vals, "body")) {
    const v = vals.body;
    if (typeof v !== "string") throw new WriteError("the body expects a string", file);
    if (v !== parsed.bodyValue) {
      const normalized = v.replace(/\r?\n/g, parsed.eol);
      const replacement =
        parsed.bodyRegion.start === 0
          ? // No frontmatter: the body IS the file.
            normalized === "" ? "" : normalized.endsWith(parsed.eol) ? normalized : normalized + parsed.eol
          : normalized === ""
            ? parsed.eol
            : parsed.eol + (normalized.endsWith(parsed.eol) ? normalized : normalized + parsed.eol);
      edits.push({ ...parsed.bodyRegion, text: replacement });
    }
  }

  // Back to front, so earlier offsets stay valid (same as the AST writer).
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
