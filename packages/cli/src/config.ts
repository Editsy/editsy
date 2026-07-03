/**
 * editsy.config.ts loading (D6). The config file is optional; the defaults
 * cover the conventional layout.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { glob } from "tinyglobby";

/** Optional editor theming so the admin can wear the site's colors. */
export interface EditsyTheme {
  /** Primary action color (buttons, active file). */
  accent?: string;
  /** Text color on the accent. */
  accentInk?: string;
  bg?: string;
  panel?: string;
  ink?: string;
  muted?: string;
  line?: string;
  /** Offset-shadow accent. */
  gold?: string;
  /** UI font-family for the editor. */
  font?: string;
}

export interface EditsyConfig {
  /** Globs (relative to the project root) that locate content files. */
  content: string[];
  /** Public-assets root for image fields. */
  assets: string;
  /** The site's dev-server URL, iframed as the preview pane. */
  siteUrl: string;
  /** Editor colors/font; see EditsyTheme. Unset keys keep editsy defaults. */
  theme?: EditsyTheme;
}

export const DEFAULT_CONFIG: EditsyConfig = {
  content: ["content/**/*.{ts,json,md}", "src/content/**/*.{ts,json,md}"],
  assets: "public",
  siteUrl: "http://localhost:3000",
};

const CONFIG_FILES = ["editsy.config.ts", "editsy.config.js", "editsy.config.mjs"];

export async function loadConfig(root: string): Promise<EditsyConfig> {
  for (const name of CONFIG_FILES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const jiti = createJiti(import.meta.url);
    const mod = (await jiti.import(path)) as { default?: Partial<EditsyConfig> } & Partial<EditsyConfig>;
    const user = mod.default ?? mod;
    return { ...DEFAULT_CONFIG, ...user };
  }
  return DEFAULT_CONFIG;
}

/** Content files matching the config globs, project-root-relative with forward slashes, sorted. */
export async function findContentFiles(root: string, config: EditsyConfig): Promise<string[]> {
  const files = await glob(config.content, {
    cwd: root,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
  });
  return files.map((f) => f.replace(/\\/g, "/")).sort();
}
