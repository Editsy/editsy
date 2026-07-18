/**
 * `editsy init`: scaffold a project for editsy in one command.
 *
 * Strictly create-only: existing files are never touched, patched, or
 * overwritten. Where a file the user owns would need changes (an existing
 * next.config), init prints the exact snippet instead of editing it.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface InitResult {
  /** Files created this run, root-relative. */
  created: string[];
  /** Files that already existed and were left alone. */
  skipped: string[];
  /** Human guidance: things init deliberately didn't do itself. */
  notes: string[];
}

const CONFIG_TEMPLATE = `// editsy configuration. Every key is optional; these are the defaults.
export default {
  // Globs that locate content files.
  content: ["content/**/*.{ts,json,md}", "src/content/**/*.{ts,json,md}"],
  // Public-assets root for image fields (and uploads).
  assets: "public",
  // Dev server shown in the local editor's preview pane.
  siteUrl: "http://localhost:3000",
  // Optional: the editor wears your site's colors.
  // theme: { accent: "#2f8f85" },
};
`;

const ROUTE_TEMPLATE = `import { createEditsy } from "@editsy/next";

export const { GET, POST } = createEditsy();
`;

const NEXT_CONFIG_TEMPLATE = `import type { NextConfig } from "next";

const config: NextConfig = {
  // Both blocks matter for the deployed /editsy editor; each omission
  // fails silently. See https://editsy.dev/docs/remote for the why.
  serverExternalPackages: ["@editsy/cli"],
  outputFileTracingIncludes: {
    "/editsy/**": [
      "./node_modules/**/@editsy/editor/dist/**",
      "./node_modules/**/@editsy/editor/package.json",
    ],
  },
};

export default config;
`;

const ENV_EXAMPLE_TEMPLATE = `# editsy remote mode (the deployed editor at /editsy).
# Set the REAL values in your host's environment, never in a committed file.
EDITSY_SECRET=
EDITSY_EDITORS=[{"name":"You","email":"you@example.com","passwordHash":"scrypt$..."}]
EDITSY_GITHUB_REPO=owner/repo
EDITSY_GITHUB_TOKEN=
# EDITSY_GITHUB_BRANCH=main
# EDITSY_SMTP_URL=smtps://user:pass@host
# The site's canonical origin; login-link emails build their URLs from it.
# EDITSY_BASE_URL=https://www.example.com
`;

const AGENTS_TEMPLATE = `# Working on this site

This site's copy is edited with [editsy](https://editsy.dev): the content
files are the CMS. Follow these rules and the site stays editable by
non-developers. The full contract:
https://github.com/editsy/editsy/blob/main/docs/AI-CONVENTIONS.md

- All human-editable copy lives in content files (see the globs in
  editsy.config.ts), wrapped in defineContent() or defineCollection().
  Components import content and render it; never hardcode copy in JSX.
- Content values are JSON-serializable literals only: no functions, JSX,
  spreads, or computed values. Use f.markdown(), f.image(), f.date(),
  f.url(), and f.select() when inference isn't enough.
- Give every defineCollection a template, so empty collections can grow.
- Render markdown fields with the Markdown component from editsy/react,
  and consume content through useEditsy for live preview.
- Field keys read like form labels; design and layout decisions stay out
  of content files.
- When the task is editing content values and the @editsy/mcp server is
  configured, use its tools instead of editing the files directly.
- Run \`npx editsy check\` before you finish; it must pass.
`;

/** The short version, for printing when an AGENTS.md already exists. */
export const AGENTS_SNIPPET = `This site's copy is edited with editsy (https://editsy.dev); the content
files are the CMS. Follow
https://github.com/editsy/editsy/blob/main/docs/AI-CONVENTIONS.md: all
human-editable copy in content files as JSON-serializable literals,
rendered through components, and \`npx editsy check\` must pass.`;

/** The exact next.config addition, for printing when the file already exists. */
export const NEXT_CONFIG_SNIPPET = `  serverExternalPackages: ["@editsy/cli"],
  outputFileTracingIncludes: {
    "/editsy/**": [
      "./node_modules/**/@editsy/editor/dist/**",
      "./node_modules/**/@editsy/editor/package.json",
    ],
  },`;

async function createIfMissing(
  root: string,
  rel: string,
  content: string,
  result: InitResult,
): Promise<void> {
  const path = join(root, rel);
  if (existsSync(path)) {
    result.skipped.push(rel);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  // "wx": refuse to overwrite even if the file appeared since the check.
  await writeFile(path, content, { flag: "wx" });
  result.created.push(rel);
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function hasDependency(pkg: Record<string, unknown> | undefined, name: string): boolean {
  if (!pkg) return false;
  for (const key of ["dependencies", "devDependencies"]) {
    const deps = pkg[key];
    if (deps && typeof deps === "object" && name in (deps as Record<string, unknown>)) return true;
  }
  return false;
}

/** "pnpm add" / "yarn add" / "npm install", judged by the lockfile present. */
export function installCommand(root: string): string {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm add";
  if (existsSync(join(root, "yarn.lock"))) return "yarn add";
  return "npm install";
}

export async function runInit(root: string): Promise<InitResult> {
  const result: InitResult = { created: [], skipped: [], notes: [] };
  const pkg = await readPackageJson(root);

  await createIfMissing(root, "editsy.config.ts", CONFIG_TEMPLATE, result);

  // Remote-mode scaffolding only makes sense in a Next.js app.
  const isNext = hasDependency(pkg, "next");
  if (isNext) {
    // Next prefers a root app/ over src/app when both exist; match it, or
    // the route lands in the directory Next ignores.
    const appDir = existsSync(join(root, "app"))
      ? "app"
      : existsSync(join(root, "src", "app"))
        ? "src/app"
        : undefined;
    if (appDir) {
      await createIfMissing(
        root,
        `${appDir}/editsy/[[...editsy]]/route.ts`,
        ROUTE_TEMPLATE,
        result,
      );
    } else {
      result.notes.push(
        "Found next in package.json but no app/ directory, so the /editsy route wasn't created. " +
          "Remote mode needs the App Router.",
      );
    }

    const existingNextConfig = ["next.config.ts", "next.config.js", "next.config.mjs"].find((f) =>
      existsSync(join(root, f)),
    );
    if (existingNextConfig) {
      const text = await readFile(join(root, existingNextConfig), "utf8");
      // Proximity matching, same as doctor: a comment mentioning a package
      // name doesn't count as having the config.
      const hasExternal = /serverExternalPackages[\s\S]{0,200}?@editsy\/cli/.test(text);
      const hasTracing = /outputFileTracingIncludes[\s\S]{0,400}?@editsy\/editor/.test(text);
      if (!hasExternal || !hasTracing) {
        result.notes.push(
          `Your ${existingNextConfig} needs the editsy block for the DEPLOYED editor (init never ` +
            `edits files it didn't create). Add inside the config object:\n\n${NEXT_CONFIG_SNIPPET}`,
        );
      }
    } else {
      await createIfMissing(root, "next.config.ts", NEXT_CONFIG_TEMPLATE, result);
    }

    if (!hasDependency(pkg, "@editsy/next")) {
      result.notes.push(`Install the remote-mode adapter: ${installCommand(root)} @editsy/next`);
    }
  }

  if (!hasDependency(pkg, "editsy")) {
    result.notes.push(`Install the runtime (optional but recommended): ${installCommand(root)} editsy`);
  }

  // Agent instructions: same deal as next.config, never edit a file the
  // user owns. An AGENTS.md that already talks about editsy is left in
  // peace; one that doesn't gets the short version to paste in.
  const agentsPath = join(root, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const text = await readFile(agentsPath, "utf8");
    if (/editsy/i.test(text)) {
      result.skipped.push("AGENTS.md");
    } else {
      result.notes.push(
        "You already have an AGENTS.md (init never edits files it didn't create). " +
          `Add a section so agents keep the site editable:\n\n${AGENTS_SNIPPET}`,
      );
    }
  } else {
    await createIfMissing(root, "AGENTS.md", AGENTS_TEMPLATE, result);
  }

  await createIfMissing(root, ".env.example", ENV_EXAMPLE_TEMPLATE, result);

  return result;
}
