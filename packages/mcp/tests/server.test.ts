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
  visits: 3,
});
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
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ops", () => {
  it("lists content files under the default globs", async () => {
    const { files } = await listContentFiles(root);
    expect(files).toEqual(["content/home.ts", "content/posts.ts"]);
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
    await expect(writeContentFile(root, "../escape.ts", "x")).rejects.toThrow(/not a content file/);
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
  });
});
