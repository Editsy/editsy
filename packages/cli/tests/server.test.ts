import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../src/server.js";

const HOME = `import { defineContent } from "editsy";

export default defineContent({
  hero: { heading: "Hello" },
});
`;

let root: string;
let server: Server;
let base: string;

async function currentRev(file = "content/home.ts"): Promise<string> {
  const res = await fetch(`${base}/api/content?file=${file}`);
  return (await res.json()).rev;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editsy-test-"));
  await mkdir(join(root, "content"), { recursive: true });
  await mkdir(join(root, "public", "img"), { recursive: true });
  await writeFile(join(root, "content", "home.ts"), HOME);
  await writeFile(join(root, "public", "img", "a.svg"), "<svg/>");
  server = await startServer({ root, port: 0 });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

describe("edit server API", () => {
  it("lists content files and the site url", async () => {
    const res = await fetch(`${base}/api/state`);
    const body = await res.json();
    expect(body.files).toEqual(["content/home.ts"]);
    expect(body.siteUrl).toMatch(/^http/);
  });

  it("lists assets as web paths", async () => {
    const res = await fetch(`${base}/api/assets`);
    const body = await res.json();
    expect(body.assets).toEqual(["/img/a.svg"]);
  });

  it("serves a parsed doc with values", async () => {
    const res = await fetch(`${base}/api/content?file=content/home.ts`);
    const body = await res.json();
    expect(body.doc.type).toBe("content");
    expect(body.values.hero.heading).toBe("Hello");
    expect(body.issues).toEqual([]);
  });

  it("rejects files outside the content globs", async () => {
    const res = await fetch(`${base}/api/content?file=../server.test.ts`);
    expect(res.status).toBe(403);
  });

  it("rejects a save with no baseRev at all (conflict checks can't be skipped)", async () => {
    const res = await fetch(`${base}/api/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file: "content/home.ts",
        dryRun: true,
        values: { hero: { heading: "No rev supplied" } },
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/baseRev/);
  });

  it("dry-run save returns a diff without writing", async () => {
    const res = await fetch(`${base}/api/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file: "content/home.ts",
        baseRev: await currentRev(),
        dryRun: true,
        values: { hero: { heading: "Changed" } },
      }),
    });
    const body = await res.json();
    expect(body.changed).toBe(true);
    expect(body.written).toBe(false);
    expect(body.diff).toContain('+  hero: { heading: "Changed" },');
    expect(await readFile(join(root, "content", "home.ts"), "utf8")).toBe(HOME);
  });

  it("real save writes the file", async () => {
    const res = await fetch(`${base}/api/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file: "content/home.ts",
        baseRev: await currentRev(),
        values: { hero: { heading: "Written" } },
      }),
    });
    const body = await res.json();
    expect(body.written).toBe(true);
    expect(await readFile(join(root, "content", "home.ts"), "utf8")).toContain('heading: "Written"');
  });

  it("rejects a save whose baseRev is stale with 409", async () => {
    const rev = await currentRev();
    // Simulate an agent editing the file behind the editor's back.
    const path = join(root, "content", "home.ts");
    await writeFile(path, (await readFile(path, "utf8")).replace("Written", "Elsewhere"));
    const res = await fetch(`${base}/api/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file: "content/home.ts",
        baseRev: rev,
        values: { hero: { heading: "Mine" } },
      }),
    });
    expect(res.status).toBe(409);
    expect(await readFile(path, "utf8")).toContain("Elsewhere");
  });

  it("rejects a shape-mismatched save with 422", async () => {
    const res = await fetch(`${base}/api/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file: "content/home.ts",
        baseRev: await currentRev(),
        values: { hero: { heading: 42 } },
      }),
    });
    expect(res.status).toBe(422);
  });
});
