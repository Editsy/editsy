/**
 * React helpers for sites using editsy; import from "editsy/react".
 * These are client-side: use them in (or under) a "use client" component.
 *
 * `useEditsy` is what powers live preview. On the deployed/dev site it
 * returns your content untouched. Inside the editsy editor's preview
 * iframe, it receives draft values as you type and re-renders before
 * anything is saved.
 */
import {
  createElement,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
// Extensionless on purpose: this package is consumed as TS source in the
// workspace (webpack can't map .js → .ts) and bundled per-entry by tsup.
import { markdownToHtml } from "./markdown";

interface DraftMessage {
  type: "editsy:draft";
  file: string;
  /** Present when the file's content spans several exports ("default" for the default export). */
  exportName?: string;
  content: unknown;
}
interface ResetMessage {
  type: "editsy:reset";
  file?: string;
}

/** Split a hook spec like "content/home.ts#hero" into path + export name. */
export function parseFileSpec(spec: string): { path: string; exportName?: string } {
  const hash = spec.indexOf("#");
  if (hash < 0) return { path: spec };
  return { path: spec.slice(0, hash), exportName: spec.slice(hash + 1) || undefined };
}

/**
 * Whether a draft message belongs to a hook, by export. A message without
 * an export name comes from a single-export file and matches any hook on
 * that file. A message with one matches the hook naming that export, or,
 * for "default", a hook with no fragment.
 */
export function draftMatches(
  hookExport: string | undefined,
  messageExport: string | undefined,
): boolean {
  if (messageExport === undefined) return true;
  if (hookExport !== undefined) return hookExport === messageExport;
  return messageExport === "default";
}

/**
 * Subscribe a page to editor drafts.
 *
 *   const home = useEditsy(homeContent, "content/home.ts");
 *
 * The second argument is the content file's repo-relative path; it's how
 * the editor knows which drafts belong to this hook. When a file exports
 * several pieces of content, name the one this hook consumes with a
 * fragment:
 *
 *   const hero = useEditsy(heroContent, "content/home.ts#hero");
 */
export function useEditsy<T>(content: T, file: string): T {
  const [draft, setDraft] = useState<T | null>(null);

  useEffect(() => {
    // Not iframed → not in the editor → nothing to do.
    if (typeof window === "undefined" || window.parent === window) return;
    const { path, exportName } = parseFileSpec(file);

    const onMessage = (event: MessageEvent) => {
      // Only the embedding editor may drive drafts.
      if (event.source !== window.parent) return;
      const data = event.data as DraftMessage | ResetMessage | undefined;
      if (!data || typeof data !== "object") return;
      if (data.type === "editsy:draft" && data.file === path && draftMatches(exportName, data.exportName)) {
        setDraft(data.content as T);
      }
      if (data.type === "editsy:reset" && (data.file === undefined || data.file === path)) {
        setDraft(null);
      }
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "editsy:ready" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, [file]);

  return draft ?? content;
}

/**
 * Render an f.markdown() field. Escapes all HTML in the source and only
 * allows http(s)/mailto/relative links, so content can't inject markup.
 */
export function Markdown({
  source,
  className,
  style,
}: {
  source: string;
  className?: string;
  style?: CSSProperties;
}): ReactElement {
  return createElement("div", {
    className,
    style,
    dangerouslySetInnerHTML: { __html: markdownToHtml(source) },
  });
}
