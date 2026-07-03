/**
 * Writing values back into a content file (D2).
 *
 * Strategy: never mutate the AST. Walk the parse tree alongside the new
 * values and collect position-based text edits against the ORIGINAL source,
 * then apply them back-to-front. Anything we don't explicitly edit
 * (comments, quote style, formatting, `f.*` wrappers) survives byte-for-byte.
 *
 * Collections: when items are added / duplicated / reordered, each item that
 * has a `$src` template is rendered by taking the ORIGINAL element's source
 * text and applying its field edits inside that slice. Annotations and
 * comments travel with the item.
 */
import ts from "typescript";
import { WriteError, isCollectionValue, type CollectionValue, type Value } from "../model.js";
import { applyMarkdownValues } from "./frontmatter.js";
import { isStringy, readContent, stringValue } from "./read.js";
import { printString, printTemplate, printValue, type PrintOptions } from "./print.js";

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

interface WriteContext {
  sf: ts.SourceFile;
  text: string;
  opts: PrintOptions;
}

export { WriteError } from "../model.js";

/** Apply a values tree to a content file's source text; returns the new text. */
export function applyValues(file: string, text: string, values: Value): string {
  if (file.endsWith(".md")) return applyMarkdownValues(file, text, values);
  const parsed = readContent(file, text);
  if (!parsed.bindings?.length || !parsed.sourceFile) {
    const first = parsed.issues[0];
    throw new WriteError(
      `cannot save: ${first ? first.message : "file is not a valid content file"}`,
      file,
      first?.line,
    );
  }
  const ctx: WriteContext = {
    sf: parsed.sourceFile,
    text,
    opts: detectPrintOptions(parsed.sourceFile, text),
  };
  const edits: TextEdit[] = [];
  if (parsed.doc?.exports) {
    // Several exports: the values object is keyed by export name.
    if (typeof values !== "object" || values === null || Array.isArray(values) || isCollectionValue(values)) {
      throw new WriteError("expected an object of values keyed by export name", file);
    }
    for (const binding of parsed.bindings) {
      if (!Object.hasOwn(values, binding.key)) continue; // untouched export
      collectRootEdits(binding.expr, (values as Record<string, Value>)[binding.key]!, binding.templateExpr, ctx, edits);
    }
  } else {
    const binding = parsed.bindings[0]!;
    collectRootEdits(binding.expr, values, binding.templateExpr, ctx, edits);
  }
  return applyEdits(text, edits);
}

/** Edit one export's literal; collections get their declared template, if any. */
function collectRootEdits(
  expr: ts.Expression,
  val: Value,
  templateExpr: ts.ObjectLiteralExpression | undefined,
  ctx: WriteContext,
  edits: TextEdit[],
): void {
  if (ts.isArrayLiteralExpression(expr) && isCollectionValue(val)) {
    collectCollectionEdits(expr, val, ctx, edits, templateExpr);
    return;
  }
  collectEdits(expr, val, ctx, edits);
}

// ---------------------------------------------------------------------------

function collectEdits(expr: ts.Expression, val: Value, ctx: WriteContext, edits: TextEdit[]): void {
  // f.* annotation: edit the string inside the call, keep the wrapper.
  if (ts.isCallExpression(expr)) {
    const inner = expr.arguments[0];
    if (!inner) throw mismatch(expr, ctx, "annotation call has no argument");
    collectEdits(inner, val, ctx, edits);
    return;
  }

  if (isStringy(expr)) {
    if (typeof val !== "string") throw mismatch(expr, ctx, `expected a string, got ${typeof val}`);
    if (stringValue(expr) === val) return;
    const original = expr.getText(ctx.sf);
    const text = original.startsWith("`")
      ? printTemplate(val)
      : printString(val, original.startsWith("'") ? "'" : '"');
    edits.push({ start: expr.getStart(ctx.sf), end: expr.end, text });
    return;
  }

  if (
    ts.isNumericLiteral(expr) ||
    (ts.isPrefixUnaryExpression(expr) &&
      expr.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(expr.operand))
  ) {
    if (typeof val !== "number") throw mismatch(expr, ctx, `expected a number, got ${typeof val}`);
    const current = Number(expr.getText(ctx.sf));
    if (current === val) return;
    edits.push({ start: expr.getStart(ctx.sf), end: expr.end, text: String(val) });
    return;
  }

  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    if (typeof val !== "boolean") throw mismatch(expr, ctx, `expected a boolean, got ${typeof val}`);
    const current = expr.kind === ts.SyntaxKind.TrueKeyword;
    if (current === val) return;
    edits.push({ start: expr.getStart(ctx.sf), end: expr.end, text: String(val) });
    return;
  }

  if (ts.isObjectLiteralExpression(expr)) {
    if (typeof val !== "object" || val === null || Array.isArray(val) || isCollectionValue(val)) {
      throw mismatch(expr, ctx, "expected an object of field values");
    }
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) continue; // read already flagged it
      const name =
        ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
      // Object.hasOwn, not `in`: a field named "constructor" or "toString"
      // must not match the prototype chain of a JSON-parsed values object.
      if (name === undefined || !Object.hasOwn(val, name)) continue; // untouched field
      collectEdits(prop.initializer, (val as Record<string, Value>)[name]!, ctx, edits);
    }
    return;
  }

  if (ts.isArrayLiteralExpression(expr)) {
    if (isCollectionValue(val)) {
      collectCollectionEdits(expr, val, ctx, edits);
      return;
    }
    if (Array.isArray(val)) {
      // string list
      if (val.length === expr.elements.length) {
        expr.elements.forEach((el, i) => collectEdits(el, val[i]!, ctx, edits));
      } else {
        const indent = lineIndentOf(expr, ctx);
        edits.push({
          start: expr.getStart(ctx.sf),
          end: expr.end,
          text: printValue(val, indent, ctx.opts),
        });
      }
      return;
    }
    throw mismatch(expr, ctx, "expected a list or collection value for an array");
  }

  throw mismatch(expr, ctx, `unsupported node in write path (${ts.SyntaxKind[expr.kind]})`);
}

function collectCollectionEdits(
  arr: ts.ArrayLiteralExpression,
  val: CollectionValue,
  ctx: WriteContext,
  edits: TextEdit[],
  declaredTemplate?: ts.ObjectLiteralExpression,
): void {
  const els = arr.elements;
  const identity =
    val.items.length === els.length && val.items.every((item, i) => item.$src === i);

  if (identity) {
    val.items.forEach((item, i) => collectEdits(els[i]!, item.value, ctx, edits));
    return;
  }

  // Structure changed: rebuild the array. Items with a template keep their
  // original source text (with field edits applied inside the slice); the
  // template being either an existing element ($src) or the collection's
  // declared `template` option ($template), so `f.*` annotations and
  // comments survive into new items either way.
  const indent = lineIndentOf(arr, ctx);
  const inner = indent + ctx.opts.step;
  const itemTexts = val.items.map((item) => {
    const template =
      item.$src !== undefined ? els[item.$src] : item.$template ? declaredTemplate : undefined;
    if (template) {
      const sub: TextEdit[] = [];
      collectEdits(template, item.value, ctx, sub);
      const start = template.getStart(ctx.sf);
      return applyEdits(
        ctx.text.slice(start, template.end),
        sub.map((e) => ({ ...e, start: e.start - start, end: e.end - start })),
      );
    }
    return printValue(item.value, inner, ctx.opts);
  });

  const text =
    itemTexts.length === 0
      ? "[]"
      : `[\n${itemTexts.map((t) => inner + t).join(",\n")}${ctx.opts.json ? "" : ","}\n${indent}]`;
  edits.push({ start: arr.getStart(ctx.sf), end: arr.end, text });
}

// ---------------------------------------------------------------------------

function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.end > sorted[i - 1]!.start) {
      throw new Error("internal: overlapping text edits");
    }
  }
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function lineIndentOf(node: ts.Node, ctx: WriteContext): string {
  const start = node.getStart(ctx.sf);
  const lineStart = ctx.text.lastIndexOf("\n", start - 1) + 1;
  const match = /^[ \t]*/.exec(ctx.text.slice(lineStart, start));
  return match ? match[0] : "";
}

function detectPrintOptions(sf: ts.SourceFile, text: string): PrintOptions {
  let quote: '"' | "'" = '"';
  const findQuote = (node: ts.Node): boolean => {
    if (ts.isStringLiteral(node)) {
      quote = node.getText(sf).startsWith("'") ? "'" : '"';
      return true;
    }
    return ts.forEachChild(node, findQuote) ?? false;
  };
  findQuote(sf);
  const indentMatch = /\n([ \t]+)\S/.exec(text);
  return {
    quote,
    step: indentMatch ? indentMatch[1]! : "  ",
    json: sf.fileName.endsWith(".json"),
  };
}

function mismatch(node: ts.Node, ctx: WriteContext, message: string): WriteError {
  const { line } = ctx.sf.getLineAndCharacterOfPosition(node.getStart(ctx.sf));
  return new WriteError(message, ctx.sf.fileName, line + 1);
}
