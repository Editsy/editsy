import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Value } from "@editsy/cli";
import { createDispatcher } from "../src/rpc.js";
import { createEditsyMcp, listContentFiles, readContentFile, writeContentFile, checkContent } from "../src/server.js";

const HOME_TS = `import { defineContent, f } from "editsy";

// The hero comment must survive every save.
export default defineContent({
  hero: {
    heading: "Hello there",
    body: f.markdown("Some *text*"),
  },
  status: f.select("draft", ["draft", "live"]),
  visits: 3,
});
`;

const ABOUT_TS = `import { defineContent } from "editsy";

export const intro = defineContent({ heading: "About us" });
export const outro = defineContent({ closing: "Bye for now" });
`;

const SETTINGS_JSON = `{
  "site": { "name": "Test site" },
  "perPage": 5
}
`;

const NOTES_MD = `---
title: Field notes
draft: true
---

The body is editable too.
`;

const POSTS_TS = `import { defineCollection } from "editsy";

export default defineCollection(
  [
    { title: "First post", draft: false },
    { title: "Second post", draft: true },
  ],
  { template: { title: "New post", draft: true } },
);
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "editsy-mcp-"));
  await mkdir(join(root, "content"), { recursive: true });
  await writeFile(join(root, "content", "home.ts"), HOME_TS);
  await writeFile(join(root, "content", "posts.ts"), POSTS_TS);
  await writeFile(join(root, "content", "notes.md"), NOTES_MD);
  await writeFile(join(root, "content", "about.ts"), ABOUT_TS);
  await writeFile(join(root, "content", "settings.json"), SETTINGS_JSON);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ops", () => {
  it("lists content files under the default globs", async () => {
    const { files } = await listContentFiles(root);
    expect(files).toEqual([
      "content/about.ts",
      "content/home.ts",
      "content/notes.md",
      "content/posts.ts",
      "content/settings.json",
    ]);
  });

  it("round-trips a multi-export file, values keyed by export name", async () => {
    const doc = await readContentFile(root, "content/about.ts");
    expect(doc.exports).toEqual(["intro", "outro"]);
    const values = structuredClone(doc.values) as { intro: { heading: string }; outro: { closing: string } };
    values.outro.closing = "See you soon";
    await writeContentFile(root, "content/about.ts", values as unknown as Value, doc.rev);
    const text = await readFile(join(root, "content", "about.ts"), "utf8");
    expect(text).toContain('closing: "See you soon"');
    expect(text).toContain('heading: "About us"');
  });

  it("round-trips a JSON file and keeps it parseable", async () => {
    const doc = await readContentFile(root, "content/settings.json");
    const values = structuredClone(doc.values) as { site: { name: string }; perPage: number };
    values.site.name = "Renamed site";
    values.perPage = 10;
    await writeContentFile(root, "content/settings.json", values as unknown as Value, doc.rev);
    const text = await readFile(join(root, "content", "settings.json"), "utf8");
    expect(JSON.parse(text)).toEqual({ site: { name: "Renamed site" }, perPage: 10 });
  });

  it("round-trips a markdown file: frontmatter and body", async () => {
    const doc = await readContentFile(root, "content/notes.md");
    expect(doc.fields).toMatchObject({ title: "text", draft: "boolean" });
    const values = structuredClone(doc.values) as { title: string; draft: boolean; body: string };
    values.draft = false;
    values.body = "A rewritten body.\n";
    await writeContentFile(root, "content/notes.md", values, doc.rev);
    const text = await readFile(join(root, "content", "notes.md"), "utf8");
    expect(text).toContain("draft: false");
    expect(text).toContain("A rewritten body.");
    expect(text).toContain("title: Field notes");
  });

  it("reads a file into fields and values", async () => {
    const doc = await readContentFile(root, "content/home.ts");
    expect(doc.kind).toBe("content");
    expect(doc.rev).toMatch(/^[0-9a-f]{16}$/);
    expect(doc.values).toMatchObject({ hero: { heading: "Hello there" }, visits: 3 });
    expect(doc.fields).toMatchObject({ hero: { heading: "text", body: "markdown" }, visits: "number" });
  });

  it("writes edited values, preserving comments, and returns a diff", async () => {
    const doc = await readContentFile(root, "content/home.ts");
    const values = structuredClone(doc.values) as { hero: { heading: string } };
    values.hero.heading = "Hello again";
    const result = await writeContentFile(root, "content/home.ts", values, doc.rev);
    expect(result.diff).toContain('-    heading: "Hello there"');
    expect(result.diff).toContain('+    heading: "Hello again"');
    const text = await readFile(join(root, "content", "home.ts"), "utf8");
    expect(text).toContain("The hero comment must survive every save.");
    expect(text).toContain('heading: "Hello again"');
    expect(text).toContain('f.markdown("Some *text*")');
  });

  it("round-trips a collection: delete, reorder, add from template", async () => {
    const doc = await readContentFile(root, "content/posts.ts");
    const values = structuredClone(doc.values) as {
      $collection: true;
      items: { $src?: number; $template?: boolean; value: Record<string, unknown> }[];
    };
    // Drop the first post, keep the second, add a fresh one from the template.
    values.items = [values.items[1]!, { $template: true, value: { title: "Third post", draft: true } }];
    await writeContentFile(root, "content/posts.ts", values as unknown as Value, doc.rev);
    const after = await readContentFile(root, "content/posts.ts");
    const titles = (after.values as unknown as { items: { value: { title: string } }[] }).items.map(
      (i) => i.value.title,
    );
    expect(titles).toEqual(["Second post", "Third post"]);
  });

  it("demands baseRev; omitting it must not silently bypass the conflict check", async () => {
    const doc = await readContentFile(root, "content/home.ts");
    const values = structuredClone(doc.values) as { hero: { heading: string } };
    values.hero.heading = "No rev supplied";
    await expect(
      writeContentFile(root, "content/home.ts", values, undefined as unknown as string),
    ).rejects.toThrow(/baseRev is required/);
  });

  it("refuses a save that would leave the file invalid, allows valid edits and fixes", async () => {
    const doc = await readContentFile(root, "content/home.ts");
    const values = structuredClone(doc.values) as { status: string };
    values.status = "nonsense";
    await expect(writeContentFile(root, "content/home.ts", values, doc.rev)).rejects.toThrow(
      /refusing to save/,
    );
    values.status = "live";
    const ok = await writeContentFile(root, "content/home.ts", values, doc.rev);
    expect(ok.diff).toContain('+  status: f.select("live", ["draft", "live"])');
  });

  it("refuses a stale baseRev instead of overwriting", async () => {
    const doc = await readContentFile(root, "content/home.ts");
    await writeFile(join(root, "content", "home.ts"), HOME_TS.replace("Hello there", "Changed elsewhere"));
    const values = structuredClone(doc.values) as { hero: { heading: string } };
    values.hero.heading = "Racing edit";
    await expect(writeContentFile(root, "content/home.ts", values, doc.rev)).rejects.toThrow(/changed since/);
  });

  it("refuses paths outside the content globs", async () => {
    await writeFile(join(root, "package.json"), "{}");
    await expect(readContentFile(root, "package.json")).rejects.toThrow(/not a content file/);
    await expect(writeContentFile(root, "../escape.ts", "x", "whatever")).rejects.toThrow(/not a content file/);
  });

  it("check reports clean and broken projects", async () => {
    expect((await checkContent(root)).ok).toBe(true);
    await writeFile(join(root, "content", "bad.ts"), "export default { oops: () => 1 };\n");
    const check = await checkContent(root);
    expect(check.ok).toBe(false);
    expect(check.summary).toContain("bad.ts");
  });
});

describe("protocol", () => {
  const rpc = (method: string, params?: object, id: number | null = 1) =>
    ({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }) as const;

  it("negotiates initialize and ignores the initialized notification", async () => {
    const dispatch = createDispatcher(createEditsyMcp(root));
    const init = (await dispatch(rpc("initialize", { protocolVersion: "2025-03-26" }))) as {
      result: { protocolVersion: string; serverInfo: { name: string }; capabilities: object };
    };
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.serverInfo.name).toBe("editsy");
    expect(init.result.capabilities).toEqual({ tools: {} });
    // An unknown future version gets our latest instead of an error.
    const future = (await dispatch(rpc("initialize", { protocolVersion: "2099-01-01" }))) as {
      result: { protocolVersion: string };
    };
    expect(future.result.protocolVersion).toBe("2025-06-18");
    expect(await dispatch(rpc("notifications/initialized", undefined, null))).toBeUndefined();
  });

  it("lists the four tools with schemas", async () => {
    const dispatch = createDispatcher(createEditsyMcp(root));
    const listed = (await dispatch(rpc("tools/list"))) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((t) => t.name)).toEqual([
      "list_content_files",
      "read_content",
      "write_content",
      "check_content",
    ]);
  });

  it("runs a full read-edit-write conversation over tools/call", async () => {
    const dispatch = createDispatcher(createEditsyMcp(root));
    const call = async (name: string, args: object) => {
      const res = (await dispatch(rpc("tools/call", { name, arguments: args }))) as {
        result: { content: [{ text: string }]; isError?: boolean };
      };
      return { ...res.result, parsed: () => JSON.parse(res.result.content[0].text) };
    };
    const doc = (await call("read_content", { file: "content/home.ts" })).parsed();
    doc.values.hero.heading = "Saved over MCP";
    const write = await call("write_content", { file: "content/home.ts", values: doc.values, baseRev: doc.rev });
    expect(write.isError).toBeUndefined();
    expect(write.parsed().diff).toContain("Saved over MCP");
    const check = (await dispatch(rpc("tools/call", { name: "check_content", arguments: {} }))) as {
      result: { isError?: boolean };
    };
    expect(check.result.isError).toBeUndefined();
  });

  it("advertises annotations and treats id 0 as a real request", async () => {
    const dispatch = createDispatcher(createEditsyMcp(root));
    const listed = (await dispatch(rpc("tools/list", undefined, 0))) as {
      id: number;
      result: { tools: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[] };
    };
    expect(listed.id).toBe(0);
    const byName = Object.fromEntries(listed.result.tools.map((t) => [t.name, t.annotations]));
    expect(byName.read_content).toMatchObject({ readOnlyHint: true });
    expect(byName.write_content).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("reports a failing check as a result, not a tool error", async () => {
    await writeFile(join(root, "content", "bad.ts"), "export default { oops: () => 1 };\n");
    const dispatch = createDispatcher(createEditsyMcp(root));
    const check = (await dispatch(rpc("tools/call", { name: "check_content", arguments: {} }))) as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(check.result.isError).toBeUndefined();
    expect(check.result.content[0].text).toContain("bad.ts");
  });

  it("reports tool failures in-band and protocol misuse as errors", async () => {
    const dispatch = createDispatcher(createEditsyMcp(root));
    const bad = (await dispatch(rpc("tools/call", { name: "read_content", arguments: { file: "nope.ts" } }))) as {
      result: { isError?: boolean; content: [{ text: string }] };
    };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain("not a content file");
    const unknownTool = (await dispatch(rpc("tools/call", { name: "rm_rf" }))) as { error: { code: number } };
    expect(unknownTool.error.code).toBe(-32602);
    const unknownMethod = (await dispatch(rpc("resources/list"))) as { error: { code: number } };
    expect(unknownMethod.error.code).toBe(-32601);
    expect(await dispatch("not an object")).toMatchObject({ error: { code: -32600 } });
    // An id-less tools/call is a notification; it gets silence, not a stray id:null frame.
    expect(await dispatch(rpc("tools/call", { name: "check_content", arguments: {} }, null))).toBeUndefined();
  });
});
