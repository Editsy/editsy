/** `editsy init` (create-only scaffolding) and `editsy doctor` (setup checks). */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth.js";
import { parseDotenv, runDoctor, type DoctorCheck } from "../src/doctor.js";
import { runInit } from "../src/init.js";

const HOME = `import { defineContent } from "editsy";\n\nexport default defineContent({ heading: "Hi" });\n`;

let root: string;

async function makeProject(opts: { next?: boolean; srcApp?: boolean; content?: boolean } = {}) {
  root = await mkdtemp(join(tmpdir(), "editsy-init-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "site", dependencies: opts.next ? { next: "^15.0.0" } : {} }),
  );
  if (opts.next) await mkdir(join(root, opts.srcApp ? "src/app" : "app"), { recursive: true });
  if (opts.content) {
    await mkdir(join(root, "content"), { recursive: true });
    await writeFile(join(root, "content", "home.ts"), HOME);
  }
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("editsy init", () => {
  it("scaffolds a Next.js app: config, route, next.config, .env.example", async () => {
    await makeProject({ next: true });
    const result = await runInit(root);
    expect(result.created.sort()).toEqual([
      ".env.example",
      "AGENTS.md",
      "app/editsy/[[...editsy]]/route.ts",
      "editsy.config.ts",
      "next.config.ts",
    ]);
    expect(await readFile(join(root, "app/editsy/[[...editsy]]/route.ts"), "utf8")).toContain(
      "createEditsy",
    );
    expect(await readFile(join(root, "next.config.ts"), "utf8")).toContain("serverExternalPackages");
    // It knows what still needs installing.
    expect(result.notes.join("\n")).toContain("@editsy/next");
    expect(result.notes.join("\n")).toContain("npm install editsy");
  });

  it("respects the src/app layout", async () => {
    await makeProject({ next: true, srcApp: true });
    const result = await runInit(root);
    expect(result.created).toContain("src/app/editsy/[[...editsy]]/route.ts");
    expect(existsSync(join(root, "app"))).toBe(false);
  });

  it("prefers a root app/ over src/app, matching Next's precedence", async () => {
    await makeProject({ next: true });
    await mkdir(join(root, "src", "app"), { recursive: true });
    const result = await runInit(root);
    expect(result.created).toContain("app/editsy/[[...editsy]]/route.ts");
    expect(result.created).not.toContain("src/app/editsy/[[...editsy]]/route.ts");
  });

  it("NEVER overwrites: a second run creates nothing and changes nothing", async () => {
    await makeProject({ next: true });
    await runInit(root);
    const configBefore = await readFile(join(root, "editsy.config.ts"), "utf8");
    await writeFile(join(root, "editsy.config.ts"), configBefore + "// my edit\n");
    const nextConfigBefore = await readFile(join(root, "next.config.ts"), "utf8");
    const second = await runInit(root);
    expect(second.created).toEqual([]);
    // config, route, .env.example counted as kept; next.config (created by
    // the first run) takes the exists-path and must be byte-identical.
    expect(second.skipped.length).toBeGreaterThanOrEqual(3);
    expect(await readFile(join(root, "editsy.config.ts"), "utf8")).toContain("// my edit");
    expect(await readFile(join(root, "next.config.ts"), "utf8")).toBe(nextConfigBefore);
  });

  it("prints the snippet instead of editing an existing next.config", async () => {
    await makeProject({ next: true });
    const original = "export default { reactStrictMode: true };\n";
    await writeFile(join(root, "next.config.ts"), original);
    const result = await runInit(root);
    expect(result.created).not.toContain("next.config.ts");
    expect(await readFile(join(root, "next.config.ts"), "utf8")).toBe(original);
    expect(result.notes.join("\n")).toContain("serverExternalPackages");
  });

  it("skips Next scaffolding in a non-Next project", async () => {
    await makeProject();
    const result = await runInit(root);
    expect(result.created.sort()).toEqual([".env.example", "AGENTS.md", "editsy.config.ts"]);
  });

  it("scaffolds an AGENTS.md carrying the conventions", async () => {
    await makeProject();
    await runInit(root);
    const text = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(text).toContain("AI-CONVENTIONS.md");
    expect(text).toContain("npx editsy check");
    expect(text).toContain("@editsy/mcp");
  });

  it("leaves an AGENTS.md that references the conventions alone, silently", async () => {
    await makeProject();
    const original = "# My agents file\n\nFollow editsy's AI-CONVENTIONS.md for content.\n";
    await writeFile(join(root, "AGENTS.md"), original);
    const result = await runInit(root);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(original);
    expect(result.skipped).toContain("AGENTS.md");
    expect(result.notes.join("\n")).not.toContain("AGENTS.md");
  });

  it("prints the snippet for an AGENTS.md that merely mentions editsy", async () => {
    await makeProject();
    // The word alone doesn't count as carrying the contract.
    const original = "# My agents file\n\nWe use editsy for content editing.\n";
    await writeFile(join(root, "AGENTS.md"), original);
    const result = await runInit(root);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(original);
    expect(result.created).not.toContain("AGENTS.md");
    expect(result.notes.join("\n")).toContain("AI-CONVENTIONS.md");
  });
});

const okGitHub: typeof fetch = async () =>
  Response.json({ permissions: { push: true }, default_branch: "main" });

function byLabel(checks: DoctorCheck[], label: string): DoctorCheck {
  const found = checks.find((c) => c.label === label);
  expect(found, `expected a "${label}" check`).toBeDefined();
  return found!;
}

describe("editsy doctor", () => {
  it("passes a fully configured project", async () => {
    await makeProject({ next: true, content: true });
    await runInit(root);
    const checks = await runDoctor({
      root,
      env: {
        EDITSY_SECRET: "long-enough-secret-value",
        EDITSY_EDITORS: JSON.stringify([
          { name: "Amy", email: "amy@example.com", passwordHash: hashPassword("pw") },
        ]),
        EDITSY_GITHUB_REPO: "amy/site",
        EDITSY_GITHUB_TOKEN: "token",
      },
      fetchImpl: okGitHub,
    });
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(byLabel(checks, "content files").status).toBe("ok");
    expect(byLabel(checks, "GitHub backend").detail).toContain("publishing to main");
    expect(byLabel(checks, "/editsy route").status).toBe("ok");
    expect(byLabel(checks, "next.config").status).toBe("ok");
  });

  it("catches the failures we've met in production", async () => {
    await makeProject({ next: true, content: true });
    // No route, no next.config, bare-object editors, expired token.
    const checks = await runDoctor({
      root,
      env: {
        EDITSY_SECRET: "short",
        EDITSY_EDITORS: `{"name":"Amy","email":"a@b.c"}`,
        EDITSY_GITHUB_REPO: "amy/site",
        EDITSY_GITHUB_TOKEN: "expired",
      },
      fetchImpl: async () => new Response("{}", { status: 401 }),
    });
    expect(byLabel(checks, "EDITSY_SECRET").detail).toContain("short");
    expect(byLabel(checks, "editors").status).toBe("fail");
    expect(byLabel(checks, "editors").detail).toContain("ARRAY");
    expect(byLabel(checks, "GitHub backend").detail).toContain("expired or revoked");
    expect(byLabel(checks, "/editsy route").detail).toContain("editsy init");
    expect(byLabel(checks, "next.config").detail).toContain("editsy init");
  });

  it("flags a read-only token, the silent publish-killer", async () => {
    await makeProject({ content: true });
    const checks = await runDoctor({
      root,
      env: { EDITSY_GITHUB_REPO: "amy/site", EDITSY_GITHUB_TOKEN: "read-only" },
      fetchImpl: async () => Response.json({ permissions: { push: false } }),
    });
    expect(byLabel(checks, "GitHub backend").status).toBe("fail");
    expect(byLabel(checks, "GitHub backend").detail).toContain("Contents read/write");
  });

  it("warns on plaintext passwords without failing", async () => {
    await makeProject({ content: true });
    const checks = await runDoctor({
      root,
      env: {
        EDITSY_EDITORS: JSON.stringify([{ name: "A", email: "a@b.c", password: "letmein" }]),
      },
      fetchImpl: okGitHub,
    });
    expect(byLabel(checks, "editors").status).toBe("warn");
    expect(byLabel(checks, "editors").detail).toContain("PLAINTEXT");
    // The value itself never appears in output.
    expect(JSON.stringify(checks)).not.toContain("letmein");
  });

  it("warns when login emails are on but no base URL pins their origin", async () => {
    await makeProject({ content: true });
    const env = { EDITSY_SMTP_URL: "smtps://user:pass@mail.example" };
    const without = await runDoctor({ root, env, fetchImpl: okGitHub });
    expect(byLabel(without, "EDITSY_BASE_URL").status).toBe("warn");
    expect(byLabel(without, "EDITSY_BASE_URL").detail).toContain("Host header");

    const withBase = await runDoctor({
      root,
      env: { ...env, EDITSY_BASE_URL: "https://www.example.com" },
      fetchImpl: okGitHub,
    });
    expect(byLabel(withBase, "EDITSY_BASE_URL").status).toBe("ok");

    const relative = await runDoctor({
      root,
      env: { ...env, EDITSY_BASE_URL: "www.example.com" },
      fetchImpl: okGitHub,
    });
    expect(byLabel(relative, "EDITSY_BASE_URL").status).toBe("fail");
  });

  it("never leaks secret values in any check", async () => {
    await makeProject({ content: true });
    const checks = await runDoctor({
      root,
      env: {
        EDITSY_SECRET: "super-secret-value-here",
        EDITSY_GITHUB_REPO: "amy/site",
        EDITSY_GITHUB_TOKEN: "ghp_very_secret_token",
      },
      fetchImpl: async () => new Response("{}", { status: 404 }),
    });
    const all = JSON.stringify(checks);
    expect(all).not.toContain("super-secret-value-here");
    expect(all).not.toContain("ghp_very_secret_token");
  });
});

describe("parseDotenv", () => {
  it("handles quotes, comments, and export prefixes; no expansion", () => {
    const parsed = parseDotenv(
      `# comment\nexport A=1\nB="two words"\nC='single'\nD=$HOME\n  E = spaced \nnot a line\n`,
    );
    expect(parsed).toEqual({ A: "1", B: "two words", C: "single", D: "$HOME", E: "spaced" });
  });
});
