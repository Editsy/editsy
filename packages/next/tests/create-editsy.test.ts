import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentBackend } from "@editsy/cli";
import { createEditsy } from "../src/index.js";

const AUTH = {
  secret: "test-secret",
  editors: [{ name: "Amy", email: "amy@example.com", password: "pw" }],
};

function fakeBackend(overrides: Partial<ContentBackend> = {}): ContentBackend {
  return {
    info: () => ({ mode: "local", siteUrl: "/" }),
    listContentFiles: async () => [],
    readContent: async () => ({ text: "", rev: "r" }),
    writeContent: async () => ({ rev: "r2" }),
    listAssets: async () => [],
    ...overrides,
  };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("EDITSY_")) delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("createEditsy", () => {
  it("404s outside the base path", async () => {
    const { GET } = createEditsy({ backend: fakeBackend(), auth: AUTH });
    const res = await GET(new Request("http://site.test/somewhere-else"));
    expect(res.status).toBe(404);
  });

  it("answers 503 in production with no auth configured at all", async () => {
    process.env.NODE_ENV = "production";
    const { GET } = createEditsy({ backend: fakeBackend() });
    const res = await GET(new Request("http://site.test/editsy/api/state"));
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/editsy is disabled/);
  });

  it("does not gate localhost/dev deployments behind the auth-missing 503", async () => {
    // NODE_ENV left as the test runner's default (not "production").
    const { GET } = createEditsy({ backend: fakeBackend() });
    const res = await GET(new Request("http://site.test/editsy/api/state"));
    expect(res.status).toBe(200);
  });

  it("turns a malformed EDITSY_EDITORS into a clean 500, not a crash", async () => {
    process.env.EDITSY_SECRET = "s";
    process.env.EDITSY_EDITORS = "not valid json";
    const { GET } = createEditsy({ backend: fakeBackend() });
    const res = await GET(new Request("http://site.test/editsy/api/state"));
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/editsy configuration error/);
  });

  it("warns (but doesn't block) when production has no GitHub backend configured", async () => {
    process.env.NODE_ENV = "production";
    // No EDITSY_GITHUB_REPO/TOKEN, so it falls back to the local-disk backend,
    // which is exactly the "looks fine, silently doesn't persist" trap.
    const { GET, POST } = createEditsy({ auth: AUTH });
    const cookie = await login(POST);
    const res = await GET(
      new Request("http://site.test/editsy/api/state", { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toMatch(/EDITSY_GITHUB_REPO/);
  });

  it("does not warn when a backend is supplied explicitly (bypasses the env fallback entirely)", async () => {
    process.env.NODE_ENV = "production";
    const { GET, POST } = createEditsy({ backend: fakeBackend(), auth: AUTH });
    const cookie = await login(POST);
    const res = await GET(
      new Request("http://site.test/editsy/api/state", { headers: { cookie } }),
    );
    const body = await res.json();
    expect(body.warning).toBeNull();
  });
});

async function login(POST: (req: Request) => Promise<Response>): Promise<string> {
  const res = await POST(
    new Request("http://site.test/editsy/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "amy@example.com", password: "pw" }),
    }),
  );
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
