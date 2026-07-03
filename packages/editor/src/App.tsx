import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type AppState, type SaveResult } from "./api";
import { AssetsContext, NodeEditor, labelize } from "./fields";
import { Login } from "./Login";
import {
  applyStoredValues,
  tagSources,
  toPlainContent,
  toValues,
  type ContentDoc,
  type Issue,
  type ObjectField,
  type Value,
} from "./types";

// ---------------------------------------------------------------------------
// Crash insurance: unsaved edits are mirrored into localStorage (per file,
// tied to the file revision they were made against) and offered back after
// a crash or an accidentally closed tab. All storage access is best-effort;
// quota errors and private-mode restrictions must never break editing.
// ---------------------------------------------------------------------------

const DRAFT_STORE_PREFIX = "editsy:draft:";

function storeDraft(file: string, rev: string | undefined, values: Value): void {
  try {
    localStorage.setItem(DRAFT_STORE_PREFIX + file, JSON.stringify({ rev, values, at: Date.now() }));
  } catch {
    // Full or unavailable storage just means no crash insurance.
  }
}

function readStoredDraft(file: string): { rev?: string; values: Value } | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORE_PREFIX + file);
    return raw ? (JSON.parse(raw) as { rev?: string; values: Value }) : null;
  } catch {
    return null;
  }
}

function clearStoredDraft(file: string): void {
  try {
    localStorage.removeItem(DRAFT_STORE_PREFIX + file);
  } catch {
    // Nothing to do.
  }
}

function fileTitle(file: string): string {
  const base = file.split("/").pop()!.replace(/\.(ts|json|md)$/, "");
  return labelize(base);
}

/** Theme keys a site may set in editsy.config.ts → the CSS variables they drive. */
const THEME_VARS: Record<string, string> = {
  accent: "--accent",
  accentInk: "--accent-ink",
  bg: "--bg",
  panel: "--panel",
  ink: "--ink",
  muted: "--muted",
  line: "--line",
  gold: "--gold",
  font: "--app-font",
};

/** Apply site theming via CSSOM (setProperty validates values; no injection). */
function applyTheme(theme: Record<string, string> | null): void {
  if (!theme) return;
  for (const [key, value] of Object.entries(theme)) {
    const cssVar = THEME_VARS[key];
    if (cssVar && typeof value === "string") {
      document.documentElement.style.setProperty(cssVar, value);
    }
  }
}

/** Sidebar order: global first, then home, then the rest alphabetically. */
function sortFiles(files: string[]): string[] {
  const rank = (f: string) => {
    const base = f.split("/").pop()!.replace(/\.(ts|json|md)$/, "").toLowerCase();
    if (base === "global" || base === "globals" || base === "settings") return 0;
    if (base === "home" || base === "index") return 1;
    return 2;
  };
  return [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Sidebar sections: one per directory, shallow first. */
function groupByDir(files: string[]): { dir: string; files: string[] }[] {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    if (!map.has(dir)) map.set(dir, []);
    map.get(dir)!.push(f);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].split("/").length - b[0].split("/").length || a[0].localeCompare(b[0]))
    .map(([dir, files]) => ({ dir, files }));
}

/** Human summary of what changed between the loaded snapshot and the draft. */
function changedFields(a: import("./types").FieldNode, b: import("./types").FieldNode, path: string[], out: string[]): void {
  if (out.length >= 9) return;
  if (a.kind !== b.kind) {
    out.push(path.join(" › ") || "content");
    return;
  }
  switch (b.kind) {
    case "object": {
      const aFields = (a as import("./types").ObjectField).fields;
      for (const [key, child] of Object.entries(b.fields)) {
        if (aFields[key]) changedFields(aFields[key], child, [...path, labelize(key)], out);
      }
      return;
    }
    case "collection": {
      const aItems = (a as import("./types").CollectionField).items;
      if (aItems.length !== b.items.length) {
        out.push([...path, "items added or removed"].join(" › "));
      }
      b.items.forEach((item, i) => {
        const src = item.__src;
        if (src !== undefined && aItems[src]) {
          changedFields(aItems[src], item, [...path, `item ${i + 1}`], out);
        }
      });
      if (b.items.some((it, i) => it.__src !== i) && aItems.length === b.items.length) {
        out.push([...path, "items reordered"].join(" › "));
      }
      return;
    }
    case "list":
      if (JSON.stringify((a as typeof b).items) !== JSON.stringify(b.items)) {
        out.push(path.join(" › "));
      }
      return;
    default:
      if ((a as typeof b).value !== b.value) out.push(path.join(" › "));
  }
}

/**
 * Everything the editor holds for one content file. Drafts live here per
 * file, so switching files never risks (or even mentions) losing edits.
 */
interface Entry {
  doc: ContentDoc | null;
  snapshot: ContentDoc | null;
  rev: string | undefined;
  issues: Issue[];
  dirty: boolean;
  /**
   * Keep streaming this file into the preview even once clean. Set after a
   * publish in github mode: the deployed site won't actually serve the new
   * content until its rebuild finishes, so dropping the overlay right after
   * publishing would make the preview appear to REVERT the saved edits.
   */
  published: boolean;
}

type Entries = Record<string, Entry>;

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entries>({});
  const [review, setReview] = useState<SaveResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOn, setPreviewOn] = useState(true);
  const [previewKey, setPreviewKey] = useState(0);
  const [assets, setAssets] = useState<string[]>([]);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [justPublished, setJustPublished] = useState<{ files: number; at: number } | null>(null);
  const [restored, setRestored] = useState<string[]>([]);
  const [fileQuery, setFileQuery] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const draftTimer = useRef<number | undefined>(undefined);
  const entriesRef = useRef<Entries>({});
  entriesRef.current = entries;
  const fileRef = useRef<string | null>(null);
  fileRef.current = file;

  const entry = file ? entries[file] : undefined;
  const dirtyFiles = Object.entries(entries).filter(([, e]) => e.dirty && e.doc);
  const anyDirty = dirtyFiles.length > 0;
  const isGithub = state?.mode === "github";

  /**
   * Stream unsaved (and freshly published) values into the preview iframe,
   * debounced, and mirror dirty files into localStorage (crash insurance).
   * Covers every file with edits, not just the open one, so a page using
   * several content files previews coherently. Files whose content spans
   * several exports stream one draft per export.
   */
  const postDraft = useCallback((immediate = false) => {
    window.clearTimeout(draftTimer.current);
    const send = () => {
      const win = iframeRef.current?.contentWindow;
      for (const [f, e] of Object.entries(entriesRef.current)) {
        if (!e.doc) continue;
        if (e.dirty) storeDraft(f, e.rev, toValues(e.doc.root));
        if (!win || !(e.dirty || e.published)) continue;
        if (e.doc.exports) {
          const root = e.doc.root as ObjectField;
          for (const key of e.doc.exports) {
            const field = root.fields[key];
            if (!field) continue;
            win.postMessage(
              { type: "editsy:draft", file: f, exportName: key, content: toPlainContent(field) },
              "*",
            );
          }
        } else {
          win.postMessage({ type: "editsy:draft", file: f, content: toPlainContent(e.doc.root) }, "*");
        }
      }
    };
    if (immediate) send();
    else draftTimer.current = window.setTimeout(send, 150);
  }, []);

  const postFileReset = useCallback((f: string) => {
    iframeRef.current?.contentWindow?.postMessage({ type: "editsy:reset", file: f }, "*");
  }, []);

  // A freshly (re)loaded or navigated site page announces itself; catch it
  // up on drafts and publish overlays right away.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "editsy:ready") postDraft(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [postDraft]);

  const refreshAssets = useCallback(() => {
    api
      .assets()
      .then((a) => setAssets(a.assets))
      .catch(() => undefined);
  }, []);

  const boot = useCallback(() => {
    setNeedsLogin(false);
    setError(null);
    setEntries({});
    setJustPublished(null);
    api
      .state()
      .then((s) => {
        const sorted = { ...s, files: sortFiles(s.files) };
        applyTheme(s.theme);
        setState(sorted);
        if (sorted.files.length > 0) setFile(sorted.files[0]!);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setNeedsLogin(true);
        else setError(e.message);
      });
    refreshAssets();
  }, [refreshAssets]);

  useEffect(boot, [boot]);

  /** Fetch a file into the entries map (replacing any existing entry). */
  const fetchFile = useCallback(async (f: string) => {
    setError(null);
    try {
      const { doc, issues, rev } = await api.content(f);
      if (doc) tagSources(doc.root);
      const snapshot = doc ? structuredClone(doc) : null;

      // A stored draft from a previous session, still valid for this exact
      // file revision and actually different from what's on disk → restore
      // it as unsaved edits. Anything off about it → clean load.
      let restoredDoc: ContentDoc | null = null;
      const stored = doc ? readStoredDraft(f) : null;
      if (doc && stored) {
        if (stored.rev === rev) {
          try {
            const candidate = structuredClone(doc);
            applyStoredValues(candidate.root, stored.values);
            if (JSON.stringify(toValues(candidate.root)) !== JSON.stringify(toValues(doc.root))) {
              restoredDoc = candidate;
            } else {
              clearStoredDraft(f);
            }
          } catch {
            clearStoredDraft(f);
          }
        } else {
          clearStoredDraft(f); // the file moved on; the old draft no longer applies
        }
      }

      const next: Entries = {
        ...entriesRef.current,
        [f]: {
          doc: restoredDoc ?? doc,
          snapshot,
          rev,
          issues,
          dirty: restoredDoc !== null,
          published: entriesRef.current[f]?.published ?? false,
        },
      };
      entriesRef.current = next;
      setEntries(next);
      if (restoredDoc) {
        setRestored((r) => (r.includes(f) ? r : [...r, f]));
        postDraft();
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [postDraft]);

  useEffect(() => {
    if (file && !entriesRef.current[file]) void fetchFile(file);
  }, [file, fetchFile]);

  /** Refetch the open file from the backend, dropping any local edits to it. */
  const reloadFile = useCallback(() => {
    const f = fileRef.current;
    if (!f) return;
    clearStoredDraft(f); // "reload" means drop my edits, stored ones included
    const wasPublished = entriesRef.current[f]?.published ?? false;
    void fetchFile(f).then(() => {
      if (wasPublished) postDraft(true);
      else postFileReset(f);
    });
  }, [fetchFile, postDraft, postFileReset]);

  const touch = useCallback(() => {
    const f = fileRef.current;
    if (!f) return;
    setEntries((es) => {
      const e = es[f];
      return e ? { ...es, [f]: { ...e, dirty: true } } : es;
    });
    postDraft();
  }, [postDraft]);

  const discard = useCallback(() => {
    const f = fileRef.current;
    const e = f ? entriesRef.current[f] : undefined;
    if (!f || !e?.snapshot) return;
    clearStoredDraft(f);
    setRestored((r) => r.filter((x) => x !== f));
    const next: Entries = {
      ...entriesRef.current,
      [f]: { ...e, doc: structuredClone(e.snapshot), dirty: false },
    };
    entriesRef.current = next;
    setEntries(next);
    // A published file keeps its overlay (now equal to the saved content);
    // anything else reverts the preview to what the site serves.
    if (e.published) postDraft(true);
    else postFileReset(f);
  }, [postDraft, postFileReset]);

  // Tab title mirrors the editing state.
  useEffect(() => {
    const name = file ? fileTitle(file) : "editsy";
    document.title = `${anyDirty ? "• " : ""}${name} · editsy`;
  }, [anyDirty, file]);

  const savePayload = () =>
    dirtyFiles.map(([f, e]) => ({ file: f, values: toValues(e.doc!.root), baseRev: e.rev }));

  const requestSave = async () => {
    if (!anyDirty) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.save(savePayload(), true);
      if (res.results.every((r) => !r.changed)) {
        // Edits round-tripped to no actual change; quietly mark clean.
        setEntries((es) => {
          const next = { ...es };
          for (const r of res.results) {
            const e = next[r.file];
            if (e) next[r.file] = { ...e, dirty: false };
          }
          return next;
        });
        return;
      }
      setReview(res.results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Ctrl/Cmd+S opens the save review; warn before closing with unsaved edits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (anyDirty && !busy && review === null) void requestSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  const confirmSave = async () => {
    setBusy(true);
    try {
      const res = await api.save(savePayload(), false);
      const next: Entries = { ...entriesRef.current };
      for (const r of res.results) {
        const e = next[r.file];
        if (!e?.doc) continue;
        clearStoredDraft(r.file); // saved; the crash copy is obsolete
        // The saved file's array order now IS the doc's item order, so
        // re-tagging keeps collection edits consistent without a refetch.
        tagSources(e.doc.root);
        next[r.file] = {
          ...e,
          rev: r.rev,
          snapshot: structuredClone(e.doc),
          dirty: false,
          published: isGithub ? true : e.published,
        };
      }
      setRestored([]);
      entriesRef.current = next;
      setEntries(next);
      setReview(null);
      if (isGithub) {
        // The commit is in, but the deployed site rebuilds before it shows.
        // Keep the preview overlay (published entries above) and say what's
        // happening instead of reloading into the not-yet-rebuilt site.
        setJustPublished({ files: res.results.filter((r) => r.changed).length, at: Date.now() });
        postDraft(true);
      } else {
        setPreviewKey((k) => k + 1);
      }
    } catch (e) {
      setError((e as Error).message);
      setReview(null);
    } finally {
      setBusy(false);
    }
  };

  /** Copy the open file under a new name: the "new post" workflow. */
  const duplicateFile = async () => {
    const f = fileRef.current;
    if (!f) return;
    const base = f.split("/").pop()!;
    const dot = base.lastIndexOf(".");
    const suggestion = `${base.slice(0, dot)}-2${base.slice(dot)}`;
    const name = window.prompt(
      isGithub
        ? "Name for the copy (created as a commit right away):"
        : "Name for the copy:",
      suggestion,
    );
    if (!name || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { file: created } = await api.duplicate(f, name.trim());
      const s = await api.state();
      setState({ ...s, files: sortFiles(s.files) });
      setFile(created);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // The "rebuilding" note dismisses itself once the rebuild is surely done.
  useEffect(() => {
    if (!justPublished) return;
    const t = window.setTimeout(() => setJustPublished(null), 3 * 60 * 1000);
    return () => window.clearTimeout(t);
  }, [justPublished]);

  if (needsLogin) {
    return <Login onSuccess={boot} />;
  }
  if (!state) {
    return <div className="center-note">{error ?? "loading…"}</div>;
  }

  const saveLabel = !anyDirty
    ? "Saved"
    : (isGithub ? "Save & publish" : "Save") + (dirtyFiles.length > 1 ? ` (${dirtyFiles.length} files)` : "");
  const changedResults = review?.filter((r) => r.changed) ?? [];

  return (
    <AssetsContext.Provider value={{ assets, siteUrl: state.siteUrl, refreshAssets }}>
    <div className="app">
      <datalist id="editsy-assets">
        {assets.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <aside className="sidebar">
        <div className="brand">editsy</div>
        {state.files.length > 8 && (
          <input
            className="file-filter"
            type="search"
            placeholder="filter files…"
            aria-label="Filter files"
            value={fileQuery}
            onChange={(e) => setFileQuery(e.target.value)}
          />
        )}
        <nav>
          {(() => {
            const query = fileQuery.trim().toLowerCase();
            const visible = query
              ? state.files.filter((f) => `${fileTitle(f)} ${f}`.toLowerCase().includes(query))
              : state.files;
            const groups = groupByDir(visible);
            return (
              <>
                {groups.map(({ dir, files }) => (
                  <div className="file-group" key={dir || "."}>
                    {groups.length > 1 && <div className="file-group-label">{dir || "(root)"}</div>}
                    {files.map((f) => (
                      <button
                        key={f}
                        className={`file-link ${f === file ? "active" : ""}`}
                        onClick={() => setFile(f)}
                      >
                        {fileTitle(f)}
                        {entries[f]?.dirty && <span className="dirty-dot" title="unsaved changes" />}
                        <span className="file-path">{f}</span>
                      </button>
                    ))}
                  </div>
                ))}
                {state.files.length > 0 && visible.length === 0 && (
                  <p className="empty-note">Nothing matches "{fileQuery}".</p>
                )}
              </>
            );
          })()}
          {state.files.length === 0 && (
            <p className="empty-note">
              No content files found. Expected <code>content/**/*.ts</code>.
            </p>
          )}
        </nav>
        {state.user && (
          <div className="user-chip">
            <span title={state.user.email}>{state.user.name}</span>
            <button
              className="ghost-btn"
              onClick={async () => {
                if (anyDirty && !window.confirm("Discard unsaved changes?")) return;
                await api.logout().catch(() => undefined);
                boot();
              }}
            >
              log out
            </button>
          </div>
        )}
      </aside>

      <main className="editor-pane">
        {state.warning && <div className="banner warn">{state.warning}</div>}
        {justPublished && (
          <div className="banner ok">
            Published! Your site is rebuilding; the change{justPublished.files === 1 ? " usually goes" : "s usually go"} live
            within a minute or two. You can keep editing.
            <button className="banner-btn" onClick={() => setJustPublished(null)}>
              got it
            </button>
          </div>
        )}
        {restored.length > 0 && (
          <div className="banner info">
            Restored unsaved edits from your last visit: {restored.map(fileTitle).join(", ")}. Save to
            keep them, or Discard to drop them.
            <button className="banner-btn" onClick={() => setRestored([])}>
              got it
            </button>
          </div>
        )}
        <header className="topbar">
          <h1>{file ? fileTitle(file) : "editsy"}</h1>
          <div className="topbar-actions">
            <button className="ghost-btn preview-toggle" onClick={() => setPreviewOn((p) => !p)}>
              {previewOn ? "hide preview" : "show preview"}
            </button>
            {entry?.doc && (
              <button
                className="ghost-btn"
                disabled={busy}
                onClick={() => void duplicateFile()}
                title="Make a copy of this file to start a new one from"
              >
                duplicate
              </button>
            )}
            {entry?.dirty && (
              <button
                className="ghost-btn"
                disabled={busy}
                onClick={discard}
                title={`Undo unsaved changes to ${file ? fileTitle(file) : "this file"}`}
              >
                Discard
              </button>
            )}
            <button className="primary-btn" disabled={!anyDirty || busy} onClick={requestSave}>
              {busy ? "…" : saveLabel}
            </button>
          </div>
        </header>

        {error && (
          <div className="banner error">
            {error}
            {file && (
              <button className="banner-btn" onClick={reloadFile}>
                reload file
              </button>
            )}
          </div>
        )}
        {entry && entry.issues.length > 0 && (
          <div className="banner warn">
            {entry.issues.map((i, n) => (
              <div key={n}>
                line {i.line}: {i.message}
              </div>
            ))}
          </div>
        )}

        {entry?.doc && (
          <div className="form-scroll">
            <NodeEditor node={entry.doc.root} touch={touch} />
          </div>
        )}
        {!entry?.doc && file && (entry?.issues.length ?? 0) === 0 && (
          <div className="center-note">loading…</div>
        )}
      </main>

      {previewOn && (
        <section className="preview-pane">
          <div className="preview-bar">
            <span>{state.siteUrl}</span>
            <button className="ghost-btn" onClick={() => setPreviewKey((k) => k + 1)}>
              reload
            </button>
          </div>
          <iframe ref={iframeRef} key={previewKey} src={state.siteUrl} title="site preview" />
        </section>
      )}

      {review !== null && (
        <div className="modal-backdrop" onClick={() => setReview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{isGithub ? "Publish these changes?" : "Save these changes?"}</h2>
            <p className="modal-sub">
              {changedResults.length === 1
                ? fileTitle(changedResults[0]!.file)
                : `${changedResults.length} pages`}
              {isGithub ? "; everything below goes live together after one rebuild." : ""}
            </p>
            <ul className="change-list">
              {(() => {
                const changes: string[] = [];
                const prefix = changedResults.length > 1;
                for (const r of changedResults) {
                  const e = entries[r.file];
                  if (e?.snapshot && e.doc) {
                    changedFields(e.snapshot.root, e.doc.root, prefix ? [fileTitle(r.file)] : [], changes);
                  }
                }
                if (changes.length === 0) changes.push("content updated");
                return changes.map((c, i) => <li key={i}>{c}</li>);
              })()}
            </ul>
            <details className="diff-details">
              <summary>Show the file changes (technical)</summary>
              <pre className="diff">
                {changedResults
                  .flatMap((r) => r.diff.split("\n"))
                  .map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("+") && !line.startsWith("+++")
                          ? "diff-add"
                          : line.startsWith("-") && !line.startsWith("---")
                            ? "diff-del"
                            : line.startsWith("@@")
                              ? "diff-hunk"
                              : ""
                      }
                    >
                      {line || " "}
                    </div>
                  ))}
              </pre>
            </details>
            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => setReview(null)}>
                Cancel
              </button>
              <button className="primary-btn" disabled={busy} onClick={confirmSave}>
                {busy ? "…" : isGithub ? "Publish" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </AssetsContext.Provider>
  );
}
