/**
 * GitHubBackend (D8): content lives in a GitHub repo; reads use the contents
 * API, writes become commits, publish is whatever rebuild the host runs on
 * push. The blob SHA doubles as the conflict-detection rev; GitHub itself
 * refuses a PUT whose sha is stale.
 *
 * Multi-file publishes use the Git Data API (blobs inlined into a tree, one
 * commit, a non-force ref update) so several edited files land as ONE commit
 * (one rebuild), and the fast-forward-only ref update doubles as an atomic
 * conflict check against concurrent publishes.
 */
import { createHash } from "node:crypto";
import picomatch from "picomatch";
import {
  AssetExistsError,
  ConflictError,
  IMAGE_GLOB,
  type BackendInfo,
  type ContentBackend,
  type WriteManyItem,
} from "./backend.js";
import type { EditsyConfig } from "./config.js";

export interface GitHubBackendOptions {
  /** "owner/repo" */
  repo: string;
  /** Fine-grained PAT or GitHub App installation token with contents read/write on the one repo. */
  token: string;
  /** Branch to read and commit to. Default "main". */
  branch?: string;
  config: EditsyConfig;
  /** Override for tests. Default: https://api.github.com */
  apiBase?: string;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

export class GitHubBackend implements ContentBackend {
  private branch: string;
  private apiBase: string;

  constructor(private opts: GitHubBackendOptions) {
    this.branch = opts.branch ?? "main";
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  }

  info(): BackendInfo {
    return {
      mode: "github",
      siteUrl: this.opts.config.siteUrl,
      theme: this.opts.config.theme,
      contentGlobs: this.opts.config.content,
    };
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.apiBase}/repos/${this.opts.repo}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(init?.headers ?? {}),
      },
    });
  }

  /** The full blob list for a tree-ish (branch name or commit sha), plus the tree's own sha. */
  private async tree(ref: string): Promise<{ sha: string; entries: TreeEntry[] }> {
    const res = await this.request(`/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (!res.ok) throw new Error(`GitHub tree read failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { sha: string; tree: TreeEntry[]; truncated: boolean };
    if (body.truncated) {
      // Silently working from a partial file list would mean missing content
      // files and, worse, conflict checks against the wrong blobs.
      throw new Error(
        `GitHub truncated the tree listing for ${this.opts.repo}; the repo has too many files ` +
          `for a single listing, which editsy doesn't support yet. Please open an issue.`,
      );
    }
    return { sha: body.sha, entries: body.tree.filter((e) => e.type === "blob") };
  }

  async listContentFiles(): Promise<string[]> {
    const match = picomatch(this.opts.config.content);
    return (await this.tree(this.branch)).entries
      .map((e) => e.path)
      .filter((p) => match(p) && !p.includes("node_modules/"))
      .sort();
  }

  async readContent(file: string): Promise<{ text: string; rev: string }> {
    const res = await this.request(
      `/contents/${encodePath(file)}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (!res.ok) throw new Error(`GitHub read of ${file} failed (${res.status})`);
    const body = (await res.json()) as { content: string; sha: string };
    return { text: Buffer.from(body.content, "base64").toString("utf8"), rev: body.sha };
  }

  async writeContent(
    file: string,
    text: string,
    opts: { baseRev?: string; message?: string; author?: { name: string; email: string } },
  ): Promise<{ rev: string }> {
    // The commit's git identity is the TOKEN owner (GitHub's default), not
    // the editor: hosts gate deployments on the commit email matching a
    // real account (Vercel blocks unmatched authors outright). The human
    // editor is credited in the message's Edited-by trailer instead.
    const res = await this.request(`/contents/${encodePath(file)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: buildMessage(`editsy: update ${file}`, opts.message, opts.author),
        content: Buffer.from(text, "utf8").toString("base64"),
        sha: opts.baseRev,
        branch: this.branch,
      }),
    });
    // GitHub answers 409 (branch moved) or 422 (stale sha) for conflicts.
    if (res.status === 409 || res.status === 422) throw new ConflictError(file);
    if (!res.ok) throw new Error(`GitHub write of ${file} failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { content: { sha: string } };
    return { rev: body.content.sha };
  }

  async writeMany(
    items: WriteManyItem[],
    opts: { message?: string; author?: { name: string; email: string } },
  ): Promise<{ revs: Record<string, string> }> {
    // Where the branch is right now: the commit we build on.
    const refRes = await this.request(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    if (!refRes.ok) {
      throw new Error(`GitHub ref read failed (${refRes.status}): ${await refRes.text()}`);
    }
    const head = ((await refRes.json()) as { object: { sha: string } }).object.sha;

    // One recursive listing serves both the conflict check (current blob shas
    // vs each item's baseRev) and the base_tree for the new tree.
    const { sha: baseTree, entries } = await this.tree(head);
    const current = new Map(entries.map((e) => [e.path, e.sha]));
    const stale = items.filter(
      (i) => i.baseRev !== undefined && current.get(i.file) !== i.baseRev,
    );
    if (stale.length > 0) throw new ConflictError(stale.map((i) => i.file));

    const treeRes = await this.request(`/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTree,
        tree: items.map((i) => ({ path: i.file, mode: "100644", type: "blob", content: i.text })),
      }),
    });
    if (!treeRes.ok) {
      throw new Error(`GitHub tree write failed (${treeRes.status}): ${await treeRes.text()}`);
    }
    const newTree = ((await treeRes.json()) as { sha: string }).sha;

    // Author/committer left to GitHub's default (the token owner); see the
    // note in writeContent; the editor is credited in the message trailer.
    const commitRes = await this.request(`/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: buildMessage(defaultSubject(items.map((i) => i.file)), opts.message, opts.author),
        tree: newTree,
        parents: [head],
      }),
    });
    if (!commitRes.ok) {
      throw new Error(`GitHub commit failed (${commitRes.status}): ${await commitRes.text()}`);
    }
    const commit = ((await commitRes.json()) as { sha: string }).sha;

    // Fast-forward only (no force): if someone else published between our
    // ref read and now, this fails instead of overwriting their commit.
    const updateRes = await this.request(`/git/refs/heads/${encodeURIComponent(this.branch)}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit, force: false }),
    });
    if (updateRes.status === 409 || updateRes.status === 422) {
      throw new ConflictError(items.map((i) => i.file));
    }
    if (!updateRes.ok) {
      throw new Error(`GitHub ref update failed (${updateRes.status}): ${await updateRes.text()}`);
    }

    // Blob shas are deterministic (sha1 of "blob <bytes>\0<content>"), so the
    // new revs need no extra API round-trip.
    const revs: Record<string, string> = {};
    for (const i of items) revs[i.file] = gitBlobSha(i.text);
    return { revs };
  }

  async listAssets(): Promise<string[]> {
    const root = this.opts.config.assets.replace(/\/$/, "") + "/";
    const match = picomatch(IMAGE_GLOB);
    return (await this.tree(this.branch)).entries
      .map((e) => e.path)
      .filter((p) => p.startsWith(root) && match(p.slice(root.length)))
      .map((p) => "/" + p.slice(root.length))
      .sort();
  }

  async writeAsset(
    path: string,
    data: Buffer,
    opts: { message?: string; author?: { name: string; email: string } },
  ): Promise<{ path: string }> {
    const repoPath = `${this.opts.config.assets.replace(/\/$/, "")}/${path}`;
    // No `sha` in the body: this PUT only ever CREATES. GitHub answers 422
    // when the path already exists (and 409 when the branch moved).
    const res = await this.request(`/contents/${encodePath(repoPath)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: buildMessage(`editsy: upload ${path}`, opts.message, opts.author),
        content: data.toString("base64"),
        branch: this.branch,
      }),
    });
    if (res.status === 409 || res.status === 422) throw new AssetExistsError(path);
    if (!res.ok) {
      throw new Error(`GitHub upload of ${path} failed (${res.status}): ${await res.text()}`);
    }
    return { path };
  }
}

function encodePath(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

/** How git itself identifies a blob, which lets us know the new revs without asking. */
export function gitBlobSha(text: string): string {
  const buf = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

function defaultSubject(files: string[]): string {
  return files.length <= 2
    ? `editsy: update ${files.join(", ")}`
    : `editsy: update ${files.length} content files`;
}

function buildMessage(
  fallbackSubject: string,
  message: string | undefined,
  author: { name: string; email: string } | undefined,
): string {
  const subject = message ?? fallbackSubject;
  return author ? `${subject}\n\nEdited-by: ${author.name} <${author.email}>` : subject;
}
