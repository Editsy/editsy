/**
 * ContentBackend (D3): the seam between the editor and where content lives.
 * The editor UI and API core only speak this interface; v1 implements it
 * over the local disk, v2 over the GitHub API (see github.ts).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { glob } from "tinyglobby";
import type { EditsyConfig, EditsyTheme } from "./config.js";

export interface BackendInfo {
  mode: "local" | "github";
  siteUrl: string;
  theme?: EditsyTheme;
  /** Surfaced as a persistent banner in the editor UI, e.g. a deploy misconfiguration. */
  warning?: string;
  /**
   * The globs that define what counts as a content file. Lets the API
   * validate paths for NEW files (duplicate) before writing; without them,
   * file creation is disabled.
   */
  contentGlobs?: string[];
}

export interface WriteManyItem {
  file: string;
  text: string;
  /** Current rev of this file; the whole batch is refused if any is stale. */
  baseRev?: string;
}

export interface ContentBackend {
  info(): BackendInfo;
  /** Content files matching the config globs, root-relative, forward slashes, sorted. */
  listContentFiles(): Promise<string[]>;
  /** Read a content file; rev identifies this exact version for conflict checks. */
  readContent(file: string): Promise<{ text: string; rev: string }>;
  /**
   * Write a content file. `baseRev` (when given) must match the current
   * version or the write throws ConflictError. `message`/`author` feed the
   * commit in git-backed backends; disk backends ignore them.
   */
  writeContent(
    file: string,
    text: string,
    opts: { baseRev?: string; message?: string; author?: { name: string; email: string } },
  ): Promise<{ rev: string }>;
  /**
   * Write several files as ONE unit: in git-backed backends, one commit
   * (so a multi-file publish triggers one rebuild, not one per file).
   * All-or-nothing: any stale `baseRev` fails the whole batch. Optional;
   * callers fall back to sequential writeContent when absent.
   */
  writeMany?(
    items: WriteManyItem[],
    opts: { message?: string; author?: { name: string; email: string } },
  ): Promise<{ revs: Record<string, string> }>;
  /** Image files under the assets root, as site-absolute web paths. */
  listAssets(): Promise<string[]>;
  /**
   * Write a NEW file under the assets root (`path` is assets-root-relative,
   * already validated by the API layer). Must refuse to overwrite: throw
   * AssetExistsError when the path is taken. Optional; uploads are disabled
   * for backends without it.
   */
  writeAsset?(
    path: string,
    data: Buffer,
    opts: { message?: string; author?: { name: string; email: string } },
  ): Promise<{ path: string }>;
}

/** An asset write refused because the target path already exists. */
export class AssetExistsError extends Error {
  constructor(path: string) {
    super(`${path} already exists`);
  }
}

/** A write refused because the file changed since `baseRev` was read. */
export class ConflictError extends Error {
  constructor(fileOrFiles: string | string[]) {
    const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
    super(`${files.join(", ")} changed since you loaded ${files.length === 1 ? "it" : "them"}; reload to pick up the new version`);
  }
}

export const IMAGE_GLOB = "**/*.{png,jpg,jpeg,webp,gif,svg,avif,ico}";

export function contentRev(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

export class LocalDiskBackend implements ContentBackend {
  constructor(
    private root: string,
    private config: EditsyConfig,
  ) {}

  info(): BackendInfo {
    return {
      mode: "local",
      siteUrl: this.config.siteUrl,
      theme: this.config.theme,
      contentGlobs: this.config.content,
    };
  }

  async listContentFiles(): Promise<string[]> {
    const files = await glob(this.config.content, {
      cwd: this.root,
      ignore: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    });
    return files.map((f) => f.replace(/\\/g, "/")).sort();
  }

  /**
   * Resolve a repo-relative path and REFUSE anything that escapes the root.
   * The API layer already allowlists paths against the content globs, but
   * this class is also part of the exported programmatic API, so it can't
   * assume every caller did; containment belongs where the disk is touched.
   */
  private inside(file: string): string {
    const full = resolve(this.root, file);
    const rel = relative(resolve(this.root), full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`refusing a path outside the project root: ${file}`);
    }
    return full;
  }

  async readContent(file: string): Promise<{ text: string; rev: string }> {
    const text = await readFile(this.inside(file), "utf8");
    return { text, rev: contentRev(text) };
  }

  async writeContent(
    file: string,
    text: string,
    opts: { baseRev?: string },
  ): Promise<{ rev: string }> {
    const full = this.inside(file);
    if (opts.baseRev !== undefined) {
      const current = await readFile(full, "utf8");
      if (contentRev(current) !== opts.baseRev) throw new ConflictError(file);
    }
    await writeFile(full, text, "utf8");
    return { rev: contentRev(text) };
  }

  async writeMany(items: WriteManyItem[]): Promise<{ revs: Record<string, string> }> {
    // Check every baseRev before touching anything, so a stale file can't
    // leave the batch half-written.
    const stale: string[] = [];
    for (const item of items) {
      if (item.baseRev === undefined) continue;
      const current = await readFile(this.inside(item.file), "utf8");
      if (contentRev(current) !== item.baseRev) stale.push(item.file);
    }
    if (stale.length > 0) throw new ConflictError(stale);
    const revs: Record<string, string> = {};
    for (const item of items) {
      await writeFile(this.inside(item.file), item.text, "utf8");
      revs[item.file] = contentRev(item.text);
    }
    return { revs };
  }

  async listAssets(): Promise<string[]> {
    const images = await glob(IMAGE_GLOB, {
      cwd: join(this.root, this.config.assets),
      ignore: ["**/node_modules/**"],
    });
    return images.map((p) => "/" + p.replace(/\\/g, "/")).sort();
  }

  async writeAsset(path: string, data: Buffer): Promise<{ path: string }> {
    const full = this.inside(join(this.config.assets, path));
    await mkdir(dirname(full), { recursive: true });
    try {
      // "wx": exclusive, so an existing asset is never clobbered.
      await writeFile(full, data, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new AssetExistsError(path);
      throw err;
    }
    return { path };
  }
}
