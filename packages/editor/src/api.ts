import type { ContentDoc, Issue, Value } from "./types";

export interface SessionUser {
  name: string;
  email: string;
}

export interface AppState {
  files: string[];
  siteUrl: string;
  mode: "local" | "github";
  user: SessionUser | null;
  /** Optional site-provided colors/font from editsy.config.ts. */
  theme: Record<string, string> | null;
  /** A persistent deployment warning from the backend (e.g. no durable storage configured). */
  warning: string | null;
}

export interface ContentResponse {
  doc: ContentDoc | null;
  issues: Issue[];
  /** Content hash of the file as read; echo back on save for conflict detection. */
  rev: string;
}

export interface SaveResult {
  file: string;
  diff: string;
  changed: boolean;
  rev: string;
}

export interface SaveResponse {
  written: boolean;
  results: SaveResult[];
}

export interface SaveSpec {
  file: string;
  values: Value;
  baseRev?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * The editor is served either at "/" (local `editsy edit`) or under a base
 * path like "/editsy/" (remote mode inside a site). API URLs derive from
 * wherever this page lives.
 */
const base = window.location.pathname.replace(/\/(index\.html)?$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((body as { error?: string }).error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return body as T;
}

export const api = {
  state: () => request<AppState>("/api/state"),
  authMethods: () => request<{ methods: ("password" | "magicLink")[] }>("/api/auth"),
  requestLink: (email: string) =>
    request<{ sent: true }>("/api/request-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
  assets: () => request<{ assets: string[] }>("/api/assets"),
  /** Upload an image into the assets root; returns its site-absolute path. */
  upload: (name: string, dataBase64: string) =>
    request<{ path: string }>("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, dataBase64 }),
    }),
  content: (file: string) => request<ContentResponse>(`/api/content?file=${encodeURIComponent(file)}`),
  /** Create a copy of a content file (the "new post" primitive). */
  duplicate: (file: string, name: string) =>
    request<{ file: string }>("/api/duplicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file, name }),
    }),
  /** Save every edited file in one request, one commit in git-backed modes. */
  save: (files: SaveSpec[], dryRun: boolean) =>
    request<SaveResponse>("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files, dryRun }),
    }),
  login: (email: string, password: string) =>
    request<{ user: SessionUser }>("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: true }>("/api/logout", { method: "POST" }),
};
