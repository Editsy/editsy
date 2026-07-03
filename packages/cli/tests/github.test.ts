/** GitHubBackend against a tiny in-memory fake of the GitHub REST API. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "../src/backend.js";
import { GitHubBackend, gitBlobSha } from "../src/github.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const HOME = `import { defineContent } from "editsy";\n\nexport default defineContent({ heading: "Hi" });\n`;
const ABOUT = `import { defineContent } from "editsy";\n\nexport default defineContent({ title: "About" });\n`;

interface FakeRepo {
  files: Map<string, { content: string; sha: string }>;
  commits: string[];
  head: string;
  truncated: boolean;
  /** Simulate a concurrent publish: the branch moves right after a ref read. */
  moveHeadAfterRefRead: boolean;
  /**
   * Any request that tried to override the commit's git identity
   * (committer/author fields). Must stay empty: identity belongs to the
   * token owner so deploy hosts can match the commit email to a real
   * account (Vercel blocks unmatched authors). Editors are credited in
   * the message trailer instead.
   */
  identityOverrides: string[];
}

let repo: FakeRepo;

function fakeGitHub(): typeof fetch {
  // Trees/commits created via the Git Data API, waiting for the ref update.
  const pendingTrees = new Map<string, { path: string; content: string }[]>();
  const pendingCommits = new Map<string, { tree: string; parent: string; message: string }>();
  let counter = 0;

  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer test-token") return new Response("{}", { status: 401 });

    const trees = /^\/repos\/amy\/site\/git\/trees\/([^/]+)$/.exec(url.pathname);
    if (trees && method === "GET") {
      const tree = [...repo.files.entries()].map(([path, f]) => ({ path, type: "blob", sha: f.sha }));
      return Response.json({ sha: `tree-of-${decodeURIComponent(trees[1]!)}`, tree, truncated: repo.truncated });
    }
    if (url.pathname === "/repos/amy/site/git/trees" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        base_tree: string;
        tree: { path: string; content: string }[];
      };
      const sha = `tree-${++counter}`;
      pendingTrees.set(sha, body.tree);
      return Response.json({ sha });
    }
    if (url.pathname === "/repos/amy/site/git/ref/heads/main" && method === "GET") {
      const sha = repo.head;
      if (repo.moveHeadAfterRefRead) repo.head = "someone-elses-commit";
      return Response.json({ object: { sha } });
    }
    if (url.pathname === "/repos/amy/site/git/commits" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        tree: string;
        parents: string[];
        message: string;
        author?: unknown;
        committer?: unknown;
      };
      if (body.author || body.committer) repo.identityOverrides.push("git/commits");
      const sha = `commit-${++counter}`;
      pendingCommits.set(sha, { tree: body.tree, parent: body.parents[0]!, message: body.message });
      return Response.json({ sha });
    }
    if (url.pathname === "/repos/amy/site/git/refs/heads/main" && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { sha: string; force?: boolean };
      const commit = pendingCommits.get(body.sha);
      if (!commit || body.force) return new Response("{}", { status: 422 });
      // Fast-forward only, like the real API without force.
      if (commit.parent !== repo.head) return new Response("{}", { status: 422 });
      for (const item of pendingTrees.get(commit.tree) ?? []) {
        repo.files.set(item.path, { content: item.content, sha: gitBlobSha(item.content) });
      }
      repo.head = body.sha;
      repo.commits.push(commit.message);
      return Response.json({ object: { sha: body.sha } });
    }

    const contents = /^\/repos\/amy\/site\/contents\/(.+)$/.exec(url.pathname);
    if (contents) {
      const path = decodeURIComponent(contents[1]!);
      const existing = repo.files.get(path);
      if (method === "GET") {
        if (!existing) return new Response("{}", { status: 404 });
        return Response.json({
          content: Buffer.from(existing.content, "utf8").toString("base64"),
          sha: existing.sha,
        });
      }
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body)) as {
          message: string;
          content: string;
          sha?: string;
          branch: string;
          committer?: unknown;
          author?: unknown;
        };
        if (body.committer || body.author) repo.identityOverrides.push(`contents PUT ${path}`);
        if (existing && body.sha !== existing.sha) return new Response("{}", { status: 422 });
        const content = Buffer.from(body.content, "base64").toString("utf8");
        const sha = `sha-${repo.commits.length + 1}`;
        repo.files.set(path, { content, sha });
        repo.commits.push(body.message);
        return Response.json({ content: { sha } });
      }
    }
    return new Response("{}", { status: 404 });
  };
}

function backend(): GitHubBackend {
  return new GitHubBackend({
    repo: "amy/site",
    token: "test-token",
    config: DEFAULT_CONFIG,
  });
}

beforeEach(() => {
  repo = {
    files: new Map([
      ["content/home.ts", { content: HOME, sha: "sha-0" }],
      ["content/about.ts", { content: ABOUT, sha: "sha-about" }],
      ["public/img/a.svg", { content: "<svg/>", sha: "sha-img" }],
      ["app/page.tsx", { content: "…", sha: "sha-page" }],
    ]),
    commits: [],
    head: "head-0",
    truncated: false,
    moveHeadAfterRefRead: false,
    identityOverrides: [],
  };
  vi.stubGlobal("fetch", fakeGitHub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHubBackend", () => {
  it("lists content files by glob and assets by extension", async () => {
    expect(await backend().listContentFiles()).toEqual(["content/about.ts", "content/home.ts"]);
    expect(await backend().listAssets()).toEqual(["/img/a.svg"]);
  });

  it("reads a file with its blob sha as rev", async () => {
    const { text, rev } = await backend().readContent("content/home.ts");
    expect(text).toBe(HOME);
    expect(rev).toBe("sha-0");
  });

  it("writes as a commit with the editor credited in the MESSAGE, not the git identity", async () => {
    const { rev } = await backend().writeContent("content/home.ts", HOME.replace("Hi", "Yo"), {
      baseRev: "sha-0",
      message: "editsy: update content/home.ts",
      author: { name: "Amy", email: "amy@example.com" },
    });
    expect(rev).toBe("sha-1");
    expect(repo.files.get("content/home.ts")!.content).toContain("Yo");
    expect(repo.commits[0]).toContain("Edited-by: Amy <amy@example.com>");
    // The commit identity must stay the token owner's: deploy hosts (Vercel)
    // block commits whose email doesn't match a real account.
    expect(repo.identityOverrides).toEqual([]);
  });

  it("creates a NEW file when writing without a baseRev (duplicate flow)", async () => {
    const { rev } = await backend().writeContent("content/fresh.ts", "export default { a: 1 };\n", {
      message: "editsy: create content/fresh.ts (copy of content/home.ts)",
    });
    expect(rev).toBeTruthy();
    expect(repo.files.get("content/fresh.ts")!.content).toContain("a: 1");
  });

  it("maps a stale sha to ConflictError", async () => {
    await expect(
      backend().writeContent("content/home.ts", "x", { baseRev: "stale" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to work from a truncated tree listing", async () => {
    repo.truncated = true;
    await expect(backend().listContentFiles()).rejects.toThrow(/truncated/);
  });

  describe("writeMany", () => {
    it("publishes several files as ONE commit", async () => {
      const { revs } = await backend().writeMany(
        [
          { file: "content/home.ts", text: HOME.replace("Hi", "Yo"), baseRev: "sha-0" },
          { file: "content/about.ts", text: ABOUT.replace("About", "Us"), baseRev: "sha-about" },
        ],
        { author: { name: "Amy", email: "amy@example.com" } },
      );
      expect(repo.commits).toHaveLength(1);
      expect(repo.commits[0]).toContain("editsy: update content/home.ts, content/about.ts");
      expect(repo.commits[0]).toContain("Edited-by: Amy <amy@example.com>");
      expect(repo.identityOverrides).toEqual([]);
      expect(repo.files.get("content/home.ts")!.content).toContain("Yo");
      expect(repo.files.get("content/about.ts")!.content).toContain("Us");
      // Revs are the deterministic git blob shas of the new contents;
      // exactly what a subsequent read would report.
      expect(revs["content/home.ts"]).toBe(repo.files.get("content/home.ts")!.sha);
      expect(revs["content/about.ts"]).toBe(repo.files.get("content/about.ts")!.sha);
    });

    it("summarizes the subject when more than two files changed", async () => {
      await backend().writeMany(
        [
          { file: "content/home.ts", text: "a", baseRev: "sha-0" },
          { file: "content/about.ts", text: "b", baseRev: "sha-about" },
          { file: "app/page.tsx", text: "c", baseRev: "sha-page" },
        ],
        {},
      );
      expect(repo.commits[0]).toBe("editsy: update 3 content files");
    });

    it("refuses the whole batch when any baseRev is stale", async () => {
      await expect(
        backend().writeMany(
          [
            { file: "content/home.ts", text: "x", baseRev: "sha-0" },
            { file: "content/about.ts", text: "y", baseRev: "stale" },
          ],
          {},
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(repo.commits).toHaveLength(0);
      expect(repo.files.get("content/home.ts")!.content).toBe(HOME);
    });

    it("treats a branch that moved mid-publish as a conflict, not an overwrite", async () => {
      repo.moveHeadAfterRefRead = true;
      await expect(
        backend().writeMany([{ file: "content/home.ts", text: "x", baseRev: "sha-0" }], {}),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(repo.head).toBe("someone-elses-commit");
      expect(repo.files.get("content/home.ts")!.content).toBe(HOME);
    });
  });

  describe("writeAsset", () => {
    it("commits a new asset under the assets root and never overwrites", async () => {
      const { path } = await backend().writeAsset("uploads/pic.png", Buffer.from("png-bytes"), {
        author: { name: "Amy", email: "amy@example.com" },
      });
      expect(path).toBe("uploads/pic.png");
      expect(repo.files.get("public/uploads/pic.png")!.content).toBe("png-bytes");
      expect(repo.commits.at(-1)).toContain("editsy: upload uploads/pic.png");
      expect(repo.identityOverrides).toEqual([]);

      const { AssetExistsError } = await import("../src/backend.js");
      await expect(
        backend().writeAsset("uploads/pic.png", Buffer.from("other"), {}),
      ).rejects.toBeInstanceOf(AssetExistsError);
      expect(repo.files.get("public/uploads/pic.png")!.content).toBe("png-bytes");
    });
  });
});

describe("gitBlobSha", () => {
  it("matches git hash-object", () => {
    // `echo hello | git hash-object --stdin`
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});
