/**
 * Printing values back to TypeScript literal text. Used when the writer has
 * to synthesize new source (added collection items, resized lists) rather
 * than editing existing nodes in place.
 */
import { isCollectionValue, type Value } from "../model.js";

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface PrintOptions {
  /** Whitespace for one indent step, e.g. "  ". */
  step: string;
  /** Quote character for strings: '"' or "'". */
  quote: '"' | "'";
  /** Strict JSON output: keys always quoted, no trailing commas. */
  json?: boolean;
}

/**
 * Remaining C0 control characters (tab/newline/return handled separately).
 * They're technically legal in a JS string literal but ILLEGAL in JSON, and
 * invisible-but-load-bearing in either; a paste can carry them in, so they
 * get explicit \u escapes on the way out.
 */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const controlEscape = (c: string) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");

/** Print a string as a TS literal with the requested quote character. */
export function printString(value: string, quote: '"' | "'"): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(quote, "g"), `\\${quote}`)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(CONTROL_RE, controlEscape);
  return quote + escaped + quote;
}

/** Print a string as a template literal (used when the original was backtick-quoted). */
export function printTemplate(value: string): string {
  return (
    "`" +
    value
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${")
      // Template literals normalize CRLF to LF at parse time, which would
      // silently change the value on the next read; escape CR explicitly.
      .replace(/\r/g, "\\r")
      .replace(CONTROL_RE, controlEscape) +
    "`"
  );
}

/**
 * Print a values-tree node as TS literal text. `indent` is the indentation
 * of the line the value starts on; nested lines get `indent + step`.
 */
export function printValue(value: Value, indent: string, opts: PrintOptions): string {
  if (typeof value === "string") return printString(value, opts.quote);
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  const trail = opts.json ? "" : ",";

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const oneLine = `[${value.map((v) => printString(v, opts.quote)).join(", ")}]`;
    if (oneLine.length <= 60 && !value.some((v) => v.includes("\n"))) return oneLine;
    const inner = indent + opts.step;
    const items = value.map((v) => inner + printString(v, opts.quote));
    return `[\n${items.join(",\n")}${trail}\n${indent}]`;
  }

  if (isCollectionValue(value)) {
    if (value.items.length === 0) return "[]";
    const inner = indent + opts.step;
    const items = value.items.map((it) => inner + printValue(it.value, inner, opts));
    return `[\n${items.join(",\n")}${trail}\n${indent}]`;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  const inner = indent + opts.step;
  const props = entries.map(([key, v]) => {
    const printedKey = !opts.json && IDENTIFIER_RE.test(key) ? key : printString(key, '"');
    return `${inner}${printedKey}: ${printValue(v, inner, opts)}`;
  });
  return `{\n${props.join(",\n")}${trail}\n${indent}}`;
}
