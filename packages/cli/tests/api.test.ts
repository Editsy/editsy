/** The fetch-style API core, exercised directly (no HTTP server) with auth enabled. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiHandler, sanitizeContentName, type ApiHandler } from "../src/api.js";
import { LocalDiskBackend } from "../src/backend.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { AuthConfig } from "../src/auth.js";

const AUTH: AuthConfig = {
  secret: "api-test-secret",
  editors: [{ name: "Amy", email: "amy@example.com", password: "pw" }],
};

let root: string;
let api: ApiHandler;
let cookie: string;

function req(path: string, init?: RequestInit & { auth?: boolean }): Request {
  const headers = new Headers(init?.headers);
  if (init?.auth !== false && cookie) headers.set("cookie", cookie);
  if (init?.body) headers.set("content-type", "application/json");
  return new Request(`http://editor.local${path}`, { ...init, headers });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editsy-api-"));
  await mkdir(join(root, "content"), { recursive: true });
  await writeFile(
    join(root, "content", "home.ts"),
    `import { defineContent } from "editsy";\n\nexport default defineContent({ heading: "Hi" });\n`,
  );
  api = createApiHandler({
    backend: new LocalDiskBackend(root, { ...DEFAULT_CONFIG, theme: { accent: "#2f8f85" } }),
    auth: AUTH,
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("auth-gated API", () => {
  it("returns 401 without a session", async () => {
    const res = await api(req("/api/state", { auth: false }), "/api/state");
    expect(res!.status).toBe(401);
  });

  it("rejects a bad login", async () => {
    const res = await api(
      req("/api/login", { method: "POST", body: JSON.stringify({ email: "amy@example.com", password: "no" }), auth: false }),
      "/api/login",
    );
    expect(res!.status).toBe(401);
  });

  it("logs in and sets a session cookie", async () => {
    const res = await api(
      req("/api/login", { method: "POST", body: JSON.stringify({ email: "amy@example.com", password: "pw" }), auth: false }),
      "/api/login",
    );
    expect(res!.status).toBe(200);
    const setCookie = res!.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    cookie = setCookie.split(";")[0]!;
  });

  it("serves state (with the user) once logged in", async () => {
    const res = await api(req("/api/state"), "/api/state");
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.files).toEqual(["content/home.ts"]);
    expect(body.user).toEqual({ name: "Amy", email: "amy@example.com" });
    expect(body.mode).toBe("local");
    expect(body.theme).toEqual({ accent: "#2f8f85" });
  });

  it("saves through the backend", async () => {
    const content = await (await api(req("/api/content?file=content/home.ts"), "/api/content"))!.json();
    const res = await api(
      req("/api/save", {
        method: "POST",
        body: JSON.stringify({
          file: "content/home.ts",
          baseRev: content.rev,
          values: { heading: "Hello from the API" },
        }),
      }),
      "/api/save",
    );
    const body = await res!.json();
    expect(body.written).toBe(true);
    expect(body.rev).not.toBe(content.rev);
  });

  it("rejects a save with no baseRev; it can't be allowed to silently skip the conflict check", async () => {
    const res = await api(
      req("/api/save", {
        method: "POST",
        body: JSON.stringify({ file: "content/home.ts", values: { heading: "No rev" } }),
      }),
      "/api/save",
    );
    expect(res!.status).toBe(400);
    expect((await res!.json()).error).toMatch(/baseRev/);
  });

  it("turns an unexpected backend error into a clean 500 instead of throwing", async () => {
    const brokenApi = createApiHandler({
      backend: new (class extends LocalDiskBackend {
        async readContent(): Promise<{ text: string; rev: string }> {
          throw new Error("disk exploded");
        }
      })(root, DEFAULT_CONFIG),
      auth: AUTH,
    });
    const login = await brokenApi(
      req("/api/login", {
        method: "POST",
        body: JSON.stringify({ email: "amy@example.com", password: "pw" }),
        auth: false,
      }),
      "/api/login",
    );
    const brokenCookie = login!.headers.get("set-cookie")!.split(";")[0]!;
    const res = await brokenApi(
      new Request("http://editor.local/api/content?file=content/home.ts", {
        headers: { cookie: brokenCookie },
      }),
      "/api/content",
    );
    expect(res!.status).toBe(500);
    expect((await res!.json()).error).toBe("disk exploded");
  });

  it("ignores non-API paths (returns null for the static layer)", async () => {
    expect(await api(req("/assets/app.js"), "/assets/app.js")).toBeNull();
  });

  // Generous timeout: each failed attempt burns a full scrypt on purpose.
  it("rate-limits repeated failed logins with 429", { timeout: 30_000 }, async () => {
    const attempt = () =>
      api(
        req("/api/login", {
          method: "POST",
          body: JSON.stringify({ email: "brute@example.com", password: "guess" }),
          auth: false,
        }),
        "/api/login",
      );
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await attempt())!.status;
    expect(last).toBe(429);
  });
});

describe("multi-file save (one publish, several files)", () => {
  beforeAll(async () => {
    await writeFile(
      join(root, "content", "about.ts"),
      `import { defineContent } from "editsy";\n\nexport default defineContent({ title: "About" });\n`,
    );
  });

  const readRev = async (file: string) =>
    (await (await api(req(`/api/content?file=${encodeURIComponent(file)}`), "/api/content"))!.json()) as {
      rev: string;
      values: Record<string, string>;
    };

  it("dry-runs all files without writing", async () => {
    const home = await readRev("content/home.ts");
    const about = await readRev("content/about.ts");
    const res = await api(
      req("/api/save", {
        method: "POST",
        body: JSON.stringify({
          dryRun: true,
          files: [
            { file: "content/home.ts", values: { heading: "Multi 1" }, baseRev: home.rev },
            { file: "content/about.ts", values: { title: "Multi 2" }, baseRev: about.rev },
          ],
        }),
      }),
      "/api/save",
    );
    const body = await res!.json();
    expect(body.written).toBe(false);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].changed).toBe(true);
    expect(body.results[0].diff).toContain("Multi 1");
    expect((await readRev("content/home.ts")).rev).toBe(home.rev);
  });

  it("writes several files in one request and returns per-file revs", async () => {
    const home = await readRev("content/home.ts");
    const about = await readRev("content/about.ts");
    const res = await api(
      req("/api/save", {
        method: "POST",
        body: JSON.stringify({
          files: [
            { file: "content/home.ts", values: { heading: "Together A" }, baseRev: home.rev },
            { file: "content/about.ts", values: { title: "Together B" }, baseRev: about.rev },
          ],
        }),
      }),
      "/api/save",
    );
    const body = await res!.json();
    expect(body.written).toBe(true);
    const homeAfter = await readRev("content/home.ts");
    const aboutAfter = await readRev("content/about.ts");
    expect(homeAfter.values.heading).toBe("Together A");
    expect(aboutAfter.values.title).toBe("Together B");
    const revOf = (file: string) => body.results.find((r: { file: string }) => r.file === file).rev;
    expect(revOf("content/home.ts")).toBe(homeAfter.rev);
    expect(revOf("content/about.ts")).toBe(aboutAfter.rev);
  });

  it("is all-or-nothing: one stale file fails the whole batch with 409", async () => {
    const home = await readRev("content/home.ts");
    const res = await api(
      req("/api/save", {
        method: "POST",
        body: JSON.stringify({
          files: [
            { file: "content/home.ts", values: { heading: "Half" }, baseRev: home.rev },
            { file: "content/about.ts", values: { title: "Half" }, baseRev: "stale-rev" },
          ],
        }),
      }),
      "/api/save",
    );
    expect(res!.status).toBe(409);
    expect((await res!.json()).error).toContain("content/about.ts");
    // The fresh file must not have been written either.
    expect((await readRev("content/home.ts")).values.heading).toBe("Together A");
  });

  it("rejects duplicate files in one save", async () => {
    const home = await readRev("content/home.ts");
    const res = await api(
      req("/api/save", {
        method: "POST",
        body: JSON.stringify({
          files: [
            { file: "content/home.ts", values: { heading: "A" }, baseRev: home.rev },
            { file: "content/home.ts", values: { heading: "B" }, baseRev: home.rev },
          ],
        }),
      }),
      "/api/save",
    );
    expect(res!.status).toBe(400);
    expect((await res!.json()).error).toContain("duplicate");
  });

  it("rejects an empty files array", async () => {
    const res = await api(
      req("/api/save", { method: "POST", body: JSON.stringify({ files: [] }) }),
      "/api/save",
    );
    expect(res!.status).toBe(400);
  });
});

describe("duplicate a content file", () => {
  it("creates a sibling copy with identical bytes and lists it", async () => {
    const source = await (await api(req("/api/content?file=content/home.ts"), "/api/content"))!.json();
    const res = await api(
      req("/api/duplicate", {
        method: "POST",
        body: JSON.stringify({ file: "content/home.ts", name: "landing" }),
      }),
      "/api/duplicate",
    );
    expect(res!.status).toBe(200);
    expect((await res!.json()).file).toBe("content/landing.ts");
    const state = await (await api(req("/api/state"), "/api/state"))!.json();
    expect(state.files).toContain("content/landing.ts");
    const copy = await (await api(req("/api/content?file=content/landing.ts"), "/api/content"))!.json();
    expect(copy.values).toEqual(source.values);
  });

  it("sanitizes hostile names into the source's directory and extension", async () => {
    const res = await api(
      req("/api/duplicate", {
        method: "POST",
        body: JSON.stringify({ file: "content/home.ts", name: "../../evil" }),
      }),
      "/api/duplicate",
    );
    expect((await res!.json()).file).toBe("content/evil.ts");
  });

  it("treats collisions case-insensitively, the way Windows and macOS filesystems do", async () => {
    const res = await api(
      req("/api/duplicate", {
        method: "POST",
        body: JSON.stringify({ file: "content/home.ts", name: "LANDING" }),
      }),
      "/api/duplicate",
    );
    // A case-only variant of an existing file would OVERWRITE it there.
    expect(res!.status).toBe(409);
  });

  it("refuses collisions and names that reduce to nothing", async () => {
    const again = await api(
      req("/api/duplicate", {
        method: "POST",
        body: JSON.stringify({ file: "content/home.ts", name: "landing" }),
      }),
      "/api/duplicate",
    );
    expect(again!.status).toBe(409);
    const junk = await api(
      req("/api/duplicate", {
        method: "POST",
        body: JSON.stringify({ file: "content/home.ts", name: "###" }),
      }),
      "/api/duplicate",
    );
    expect(junk!.status).toBe(400);
  });
});

describe("sanitizeContentName", () => {
  it("handles habit-typed extensions and extensionless sources", () => {
    expect(sanitizeContentName("post.md", "content/notes.md")).toBe("post.md");
    expect(sanitizeContentName("post.md", "content/page.ts")).toBe("post.ts");
    expect(sanitizeContentName("copy", "content/README")).toBe("copy");
    expect(sanitizeContentName("weird.name.here", "content/a.json")).toBe("weird.name.here.json");
  });
});

describe("image upload", () => {
  // A real-enough PNG: correct magic bytes, junk body (we validate, not parse).
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("editsy-test-image"),
  ]);
  const upload = (name: string, data: Buffer | string) =>
    api(
      req("/api/upload", {
        method: "POST",
        body: JSON.stringify({
          name,
          dataBase64: typeof data === "string" ? data : data.toString("base64"),
        }),
      }),
      "/api/upload",
    );

  beforeAll(async () => {
    await mkdir(join(root, "public"), { recursive: true });
  });

  it("uploads a png under /uploads and lists it as an asset", async () => {
    const res = await upload("photo.png", PNG);
    expect(res!.status).toBe(200);
    expect((await res!.json()).path).toBe("/uploads/photo.png");
    const assets = await (await api(req("/api/assets"), "/api/assets"))!.json();
    expect(assets.assets).toContain("/uploads/photo.png");
  });

  it("never overwrites; a name collision gets a numeric suffix", async () => {
    const res = await upload("photo.png", PNG);
    expect((await res!.json()).path).toBe("/uploads/photo-2.png");
  });

  it("strips any directory part from the name (no traversal)", async () => {
    const res = await upload("../../outside/../evil.png", PNG);
    expect((await res!.json()).path).toBe("/uploads/evil.png");
  });

  it("tidies messy names instead of rejecting them", async () => {
    const res = await upload("Holiday Photo (1).PNG", PNG);
    expect((await res!.json()).path).toBe("/uploads/Holiday-Photo-1.png");
  });

  it("refuses SVG (scripts served from the site origin) and unknown types", async () => {
    for (const name of ["logo.svg", "cursed.html", "noext"]) {
      const res = await upload(name, PNG);
      expect(res!.status).toBe(400);
      expect((await res!.json()).error).toContain("can't be uploaded");
    }
  });

  it("refuses a file whose bytes don't match its extension", async () => {
    const res = await upload("fake.png", Buffer.from("<script>alert(1)</script>"));
    expect(res!.status).toBe(400);
    expect((await res!.json()).error).toContain("don't look like");
  });

  it("refuses oversized uploads before decoding them", async () => {
    const res = await upload("big.png", "A".repeat(6 * 1024 * 1024));
    expect(res!.status).toBe(413);
  });
});

describe("secure deployments", () => {
  const login = (api2: ApiHandler, url: string, headers?: Record<string, string>) =>
    api2(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email: "amy@example.com", password: "pw" }),
      }),
      "/api/login",
    );

  it("uses a __Host- cookie over https, and reads it back", async () => {
    const res = await login(api, "https://site.example/api/login");
    const setCookie = res!.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^__Host-editsy_session=/);
    expect(setCookie).toContain("Secure");
    const state = await api(
      new Request("https://site.example/api/state", { headers: { cookie: setCookie.split(";")[0]! } }),
      "/api/state",
    );
    expect(state!.status).toBe(200);
  });

  it("treats a TLS-terminating proxy (x-forwarded-proto) as secure", async () => {
    const res = await login(api, "http://internal:3000/api/login", { "x-forwarded-proto": "https" });
    expect(res!.headers.get("set-cookie")).toMatch(/^__Host-editsy_session=.*Secure/s);
  });

  it("builds magic links from the configured base URL, not the Host header", async () => {
    const sent: { text: string }[] = [];
    const secureApi = createApiHandler({
      backend: new LocalDiskBackend(root, DEFAULT_CONFIG),
      auth: AUTH,
      mailer: { send: async (m) => void sent.push(m) },
      baseUrl: "https://www.example.com",
    });
    // The attacker's forged Host header reaches us as the request URL's host.
    const res = await secureApi(
      new Request("http://attacker.example/editsy/api/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "amy@example.com" }),
      }),
      "/api/request-link",
    );
    expect(res!.status).toBe(200);
    expect(sent[0]!.text).toContain("https://www.example.com/editsy/api/magic?token=");
    expect(sent[0]!.text).not.toContain("attacker.example");
  });
});

describe("LocalDiskBackend path containment", () => {
  it("refuses paths that escape the project root, even from programmatic callers", async () => {
    const backend = new LocalDiskBackend(root, DEFAULT_CONFIG);
    await expect(backend.readContent("../outside.ts")).rejects.toThrow(/outside the project root/);
    await expect(backend.writeContent("..\\outside.ts", "x", {})).rejects.toThrow(/outside the project root/);
    await expect(backend.writeAsset("../../escape.png", Buffer.from("x"))).rejects.toThrow(
      /outside the project root/,
    );
  });
});

describe("magic-link flow", () => {
  const sent: { to: string; text: string }[] = [];
  let magicApi: ApiHandler;

  beforeAll(() => {
    magicApi = createApiHandler({
      backend: new LocalDiskBackend(root, DEFAULT_CONFIG),
      auth: AUTH,
      mailer: { send: async (m) => void sent.push(m) },
    });
  });

  it("advertises both methods", async () => {
    const res = await magicApi(req("/api/auth", { auth: false }), "/api/auth");
    expect((await res!.json()).methods).toEqual(["password", "magicLink"]);
  });

  it("emails a link for a known editor and stays silent for strangers", async () => {
    const ask = (email: string) =>
      magicApi(
        req("/api/request-link", { method: "POST", body: JSON.stringify({ email }), auth: false }),
        "/api/request-link",
      );
    expect((await ask("amy@example.com"))!.status).toBe(200);
    expect((await ask("stranger@example.com"))!.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("amy@example.com");
    expect(sent[0]!.text).toContain("/api/magic?token=");
  });

  it("the emailed link logs in and redirects to the editor", async () => {
    const url = /https?:\/\/\S+/.exec(sent[0]!.text)![0];
    const path = new URL(url).pathname + new URL(url).search;
    const res = await magicApi(new Request(url), path.replace(/\?.*$/, ""));
    expect(res!.status).toBe(302);
    expect(res!.headers.get("set-cookie")).toContain("editsy_session=");
    expect(res!.headers.get("location")).toBe("/");
  });

  it("rejects an expired or garbage token", async () => {
    const res = await magicApi(
      req("/api/magic?token=garbage", { auth: false }),
      "/api/magic",
    );
    expect(res!.status).toBe(401);
  });
});
