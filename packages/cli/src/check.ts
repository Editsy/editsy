/**
 * `editsy check`: validate the D1 constraint (content files are plain,
 * JSON-serializable literals wrapped in defineContent/defineCollection).
 * Usable in CI; exit code 1 on any issue.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findContentFiles, loadConfig } from "./config.js";
import { readContent } from "./ast/read.js";
import type { Issue } from "./model.js";

export interface CheckResult {
  files: string[];
  problems: { file: string; issues: Issue[] }[];
  /** Valid content files using plain exports instead of the wrappers. */
  unwrapped: string[];
}

export async function runCheck(root: string): Promise<CheckResult> {
  const config = await loadConfig(root);
  const files = await findContentFiles(root, config);
  const problems: CheckResult["problems"] = [];
  const unwrapped: string[] = [];
  for (const file of files) {
    const text = await readFile(join(root, file), "utf8");
    const { issues, doc, wrapped } = readContent(file, text);
    if (issues.length > 0) problems.push({ file, issues });
    // The wrapper hint only makes sense for TS files; JSON and markdown can't wrap.
    else if (doc && wrapped === false && !file.endsWith(".json") && !file.endsWith(".md")) {
      unwrapped.push(file);
    }
  }
  return { files, problems, unwrapped };
}

export function formatCheckResult(result: CheckResult): string {
  const lines: string[] = [];
  for (const { file, issues } of result.problems) {
    for (const issue of issues) {
      lines.push(`${file}:${issue.line}:${issue.column}: ${issue.message}`);
    }
  }
  const issueCount = result.problems.reduce((n, p) => n + p.issues.length, 0);
  lines.push(
    issueCount === 0
      ? `✓ ${result.files.length} content file${result.files.length === 1 ? "" : "s"} OK`
      : `✗ ${issueCount} issue${issueCount === 1 ? "" : "s"} in ${result.problems.length} file${result.problems.length === 1 ? "" : "s"}`,
  );
  if (result.files.length === 0) {
    lines.push(
      "(no content files found; expected content/**/*.{ts,json,md} or src/content/**/*.{ts,json,md}, or set `content` globs in editsy.config.ts)",
    );
  }
  if (result.unwrapped.length > 0) {
    lines.push(
      `ℹ ${result.unwrapped.length} file${result.unwrapped.length === 1 ? " uses" : "s use"} plain exports, which works fine; ` +
        "wrapping in defineContent()/defineCollection() adds type-safety and f.* field options",
    );
  }
  return lines.join("\n");
}
