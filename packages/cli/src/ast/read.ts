/**
 * Reading content files: locate the editable exports (a default export, a
 * named `export const`, or several of them), infer the field model from the
 * literal values (D4), and collect constraint violations (D1) along the way.
 *
 * Uses the raw TypeScript compiler API (no type checker, just the parse
 * tree), so it runs in Node and in the browser alike (D3).
 */
import ts from "typescript";
import type {
  CollectionField,
  ContentDoc,
  FieldNode,
  Issue,
  ObjectField,
  StringField,
} from "../model.js";
import { readMarkdownFile } from "./frontmatter.js";

const ANNOTATIONS = new Set(["text", "textarea", "markdown", "html", "image", "url", "date", "select"]);
/** Strings at least this long (or containing newlines) infer as textarea. */
const TEXTAREA_THRESHOLD = 120;
/** Strings shaped like an ISO date infer as a date field. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One editable export in a content file, as the writer needs it. */
export interface RootBinding {
  /** Export name; "default" for the default export. */
  key: string;
  /** The editable literal expression (wrapper and as/satisfies unwrapped). */
  expr: ts.Expression;
  /** `defineCollection(items, { template })`'s template literal, if given. */
  templateExpr?: ts.ObjectLiteralExpression;
  /** Whether a defineContent/defineCollection wrapper was used. */
  wrapped: boolean;
}

export interface ParsedContent {
  doc?: ContentDoc;
  issues: Issue[];
  /** The parse tree, for the writer. Present whenever anything editable was found. */
  sourceFile?: ts.SourceFile;
  /** The editable exports, in file order. */
  bindings?: RootBinding[];
  /** The single binding's expression, a convenience kept for single-export files. */
  rootExpr?: ts.Expression;
  /** False when at least one editable export lacks a defineContent/defineCollection wrapper. */
  wrapped?: boolean;
}

export function parseSource(file: string, text: string): ts.SourceFile {
  if (file.endsWith(".json")) return ts.parseJsonText(file, text);
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

/** Parse a content file's source text into a document model plus issues. */
export function readContent(file: string, text: string): ParsedContent {
  if (file.endsWith(".md")) {
    // Markdown files have their own reader/writer pair (ast/frontmatter.ts);
    // only doc + issues apply; there's no TS parse tree.
    const { doc, issues } = readMarkdownFile(file, text);
    return { doc, issues, wrapped: true };
  }
  const sf = parseSource(file, text);
  if (file.endsWith(".json")) return readJson(file, sf);
  const issues: Issue[] = [];
  const issueAt = (node: ts.Node, message: string) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    issues.push({ message, line: line + 1, column: character + 1 });
  };

  // Every editable export: `export default <expr>` and `export const x = <expr>`.
  const found: { key: string; raw: ts.Expression }[] = [];
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      found.push({ key: "default", raw: statement.expression });
    } else if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          found.push({ key: decl.name.text, raw: decl.initializer });
        }
      }
    }
  }
  if (found.length === 0) {
    issues.push({
      message:
        "no editable export found: a content file needs `export default defineContent({...})`, " +
        "`export default defineCollection([...])`, or `export const name = {...}` / `[...]`",
      line: 1,
      column: 1,
    });
    return { issues };
  }

  const bindings: RootBinding[] = [];
  const nodes: { key: string; node: FieldNode }[] = [];
  for (const { key, raw } of found) {
    const read = readBinding(key, raw, sf, issueAt);
    if (!read) continue;
    bindings.push(read.binding);
    nodes.push({ key, node: read.node });
  }
  if (bindings.length === 0) {
    // Every export was unusable; the specific issues are already recorded.
    return { issues, sourceFile: sf };
  }
  const allWrapped = bindings.every((b) => b.wrapped);

  // One export that is itself an object or collection → the file IS that
  // content (the shape sites already have). Anything else (several exports,
  // or a scalar/list export) becomes an object doc keyed by export name.
  if (nodes.length === 1 && (nodes[0]!.node.kind === "object" || nodes[0]!.node.kind === "collection")) {
    const root = nodes[0]!.node as ObjectField | CollectionField;
    return {
      doc: { file, type: root.kind === "collection" ? "collection" : "content", root },
      issues,
      sourceFile: sf,
      bindings,
      rootExpr: bindings[0]!.expr,
      wrapped: allWrapped,
    };
  }

  const fields: Record<string, FieldNode> = {};
  for (const { key, node } of nodes) fields[key] = node;
  return {
    doc: {
      file,
      type: "content",
      root: { kind: "object", fields },
      exports: nodes.map((n) => n.key),
    },
    issues,
    sourceFile: sf,
    bindings,
    wrapped: allWrapped,
  };
}

/** Unwrap one export's expression and read it into a field node. */
function readBinding(
  key: string,
  raw: ts.Expression,
  sf: ts.SourceFile,
  issueAt: IssueFn,
): { binding: RootBinding; node: FieldNode } | undefined {
  // Unwrap `as const` / `satisfies T` / parens, common on existing sites.
  let expr = raw;
  while (
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isParenthesizedExpression(expr)
  ) {
    expr = expr.expression;
  }

  // defineContent()/defineCollection() wrappers are recommended (they add
  // type constraints and make intent explicit) but NOT required: a plain
  // literal works, so editsy can sit on top of content files an existing
  // site already has, unmodified.
  let wrapped = false;
  let templateExpr: ts.ObjectLiteralExpression | undefined;
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    (expr.expression.text === "defineContent" || expr.expression.text === "defineCollection")
  ) {
    const callee = expr.expression.text;
    const arg = expr.arguments[0];
    if (!arg) {
      issueAt(expr, `${callee}() needs an argument`);
      return undefined;
    }
    if (callee === "defineCollection") {
      templateExpr = readTemplateOption(expr, sf, issueAt);
    }
    if (callee === "defineContent" && !ts.isObjectLiteralExpression(arg)) {
      issueAt(arg, "defineContent() takes an object literal");
      return undefined;
    }
    if (callee === "defineCollection" && !ts.isArrayLiteralExpression(arg)) {
      issueAt(arg, "defineCollection() takes an array literal");
      return undefined;
    }
    wrapped = true;
    expr = arg;
  }

  let node: FieldNode | undefined;
  if (ts.isArrayLiteralExpression(expr) && (wrapped || key === "default")) {
    // defineCollection([...]), or the long-standing rule that an exported
    // default array IS a collection. Includes the empty array.
    const items: ObjectField[] = [];
    for (const el of expr.elements) {
      if (ts.isObjectLiteralExpression(el)) items.push(readObject(el, sf, issueAt));
      else issueAt(el, "collection items must be object literals");
    }
    node = { kind: "collection", items };
  } else if (ts.isObjectLiteralExpression(expr) || wrapped) {
    node = readObject(expr as ts.ObjectLiteralExpression, sf, issueAt);
  } else if (key === "default") {
    issueAt(
      expr,
      "default export must be an object literal, an array literal, or wrapped in defineContent()/defineCollection() from 'editsy'",
    );
    return undefined;
  } else if (isContentish(expr)) {
    // A named export of a string/number/boolean/list is an editable field.
    node = readNode(expr, sf, issueAt);
  } else {
    // A named export that clearly isn't content (a function, a component,
    // a re-exported identifier); skip it silently so content files can
    // hold the occasional helper without spurious warnings.
    return undefined;
  }
  if (!node) return undefined;
  if (node.kind === "collection" && templateExpr) {
    node.template = readObject(templateExpr, sf, issueAt);
  }
  return { binding: { key, expr, templateExpr, wrapped }, node };
}

/** Literal-ish shapes we treat as content when they appear as a named export. */
function isContentish(expr: ts.Expression): boolean {
  return (
    isStringy(expr) ||
    ts.isNumericLiteral(expr) ||
    (ts.isPrefixUnaryExpression(expr) &&
      expr.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(expr.operand)) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isArrayLiteralExpression(expr)
  );
}

/** The `{ template: {...} }` options argument of defineCollection, if present. */
function readTemplateOption(
  call: ts.CallExpression,
  sf: ts.SourceFile,
  issueAt: IssueFn,
): ts.ObjectLiteralExpression | undefined {
  const opts = call.arguments[1];
  if (!opts) return undefined;
  if (!ts.isObjectLiteralExpression(opts)) {
    issueAt(opts, "defineCollection()'s second argument must be an object literal like { template: {...} }");
    return undefined;
  }
  for (const prop of opts.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
    if (name !== "template") continue;
    if (!ts.isObjectLiteralExpression(prop.initializer)) {
      issueAt(prop.initializer, "template must be an object literal (the shape of a new item)");
      return undefined;
    }
    return prop.initializer;
  }
  return undefined;
}

/** JSON content: the file's root value is the document, a JSON flavor of the same model. */
function readJson(file: string, sf: ts.SourceFile): ParsedContent {
  const issues: Issue[] = [];
  const issueAt = (node: ts.Node, message: string) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    issues.push({ message, line: line + 1, column: character + 1 });
  };
  const statement = sf.statements[0];
  const expr = statement && ts.isExpressionStatement(statement) ? statement.expression : undefined;
  if (expr && ts.isObjectLiteralExpression(expr)) {
    const root = readObject(expr, sf, issueAt);
    return {
      doc: { file, type: "content", root },
      issues,
      sourceFile: sf,
      bindings: [{ key: "default", expr, wrapped: false }],
      rootExpr: expr,
      wrapped: false,
    };
  }
  if (expr && ts.isArrayLiteralExpression(expr) && expr.elements.every(ts.isObjectLiteralExpression)) {
    const items = expr.elements.map((e) => readObject(e as ts.ObjectLiteralExpression, sf, issueAt));
    return {
      doc: { file, type: "collection", root: { kind: "collection", items } },
      issues,
      sourceFile: sf,
      bindings: [{ key: "default", expr, wrapped: false }],
      rootExpr: expr,
      wrapped: false,
    };
  }
  issues.push({ message: "JSON content must be an object or an array of objects", line: 1, column: 1 });
  return { issues, sourceFile: sf };
}

type IssueFn = (node: ts.Node, message: string) => void;

function readObject(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile, issueAt: IssueFn): ObjectField {
  const fields: Record<string, FieldNode> = {};
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      issueAt(prop, "only plain `key: value` properties are allowed; no spreads, shorthand, or methods");
      continue;
    }
    const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
    if (name === undefined) {
      issueAt(prop.name, "computed property names are not allowed in content");
      continue;
    }
    const node = readNode(prop.initializer, sf, issueAt);
    if (node) fields[name] = node;
  }
  return { kind: "object", fields };
}

function readNode(expr: ts.Expression, sf: ts.SourceFile, issueAt: IssueFn): FieldNode | undefined {
  // f.* annotation: the call expression tells us the field kind.
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "f"
    ) {
      const kind = callee.name.text;
      if (!ANNOTATIONS.has(kind)) {
        issueAt(callee.name, `unknown field annotation f.${kind}(); known: ${[...ANNOTATIONS].join(", ")}`);
        return undefined;
      }
      const inner = expr.arguments[0];
      if (!inner || !isStringy(inner)) {
        issueAt(expr, `f.${kind}() takes a string literal first`);
        return undefined;
      }
      if (kind === "select") {
        const optionsArg = expr.arguments[1];
        if (!optionsArg || !ts.isArrayLiteralExpression(optionsArg) || !optionsArg.elements.every(isStringy)) {
          issueAt(expr, `f.select() needs its options: f.select("a", ["a", "b"])`);
          return undefined;
        }
        const options = optionsArg.elements.map((e) => stringValue(e as StringyLiteral));
        const value = stringValue(inner);
        if (!options.includes(value)) {
          issueAt(inner, `f.select() value "${value}" isn't one of its options`);
        }
        return { kind: "select", value, annotated: true, options };
      }
      return { kind: kind as StringField["kind"], value: stringValue(inner), annotated: true };
    }
    issueAt(expr, "function calls are not allowed in content values (except f.* annotations)");
    return undefined;
  }

  if (isStringy(expr)) {
    const value = stringValue(expr);
    const kind = ISO_DATE_RE.test(value)
      ? "date"
      : value.includes("\n") || value.length >= TEXTAREA_THRESHOLD
        ? "textarea"
        : "text";
    return { kind, value, annotated: false };
  }

  if (ts.isNumericLiteral(expr)) return { kind: "number", value: Number(expr.text) };
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return { kind: "number", value: -Number(expr.operand.text) };
  }

  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };

  if (ts.isObjectLiteralExpression(expr)) return readObject(expr, sf, issueAt);

  if (ts.isArrayLiteralExpression(expr)) {
    const els = expr.elements;
    if (els.every((e) => isStringy(e))) {
      // Includes the empty array: an empty list is the harmless default.
      return { kind: "list", items: els.map((e) => stringValue(e as StringyLiteral)) };
    }
    if (els.every((e) => ts.isObjectLiteralExpression(e))) {
      return {
        kind: "collection",
        items: els.map((e) => readObject(e as ts.ObjectLiteralExpression, sf, issueAt)),
      };
    }
    issueAt(expr, "arrays must be all strings (a list) or all objects (a collection), not mixed");
    return undefined;
  }

  issueAt(
    expr,
    `unsupported value (${ts.SyntaxKind[expr.kind]}); content must be plain literals: ` +
      "strings, numbers, booleans, arrays, objects",
  );
  return undefined;
}

type StringyLiteral = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;

export function isStringy(node: ts.Node): node is StringyLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

export function stringValue(node: StringyLiteral): string {
  return node.text;
}
