/**
 * editsy runtime, deliberately near-zero.
 *
 * `defineContent` / `defineCollection` are identity functions: they exist so
 * the editsy AST layer can find your content in the file, and so TypeScript
 * can constrain values to JSON-serializable literals (no functions, no JSX).
 *
 * `f.*` field helpers likewise return their argument untouched. The call
 * expression itself (`f.markdown("…")`) is the annotation the editor reads
 * to pick a field widget. Your site consumes plain data at runtime.
 */

/** A JSON-serializable content value. Functions and class instances are excluded by construction. */
export type ContentValue =
  | string
  | number
  | boolean
  | ContentValue[]
  | { [key: string]: ContentValue };

/** A content object: string keys, serializable values. Keys become edit-form labels. */
export type Content = { [key: string]: ContentValue };

/** Wrap a page/concern's content object. The editor infers fields from the values. */
export function defineContent<T extends Content>(content: T): T {
  return content;
}

/** Options for defineCollection. */
export interface CollectionOptions<T> {
  /**
   * The shape (and default values) of a NEW item, used by the editor's
   * "+ add item" button. Without it, adding copies the first existing item's
   * shape, which means an empty collection can't grow from the editor at
   * all. With it, even an empty collection can, and new items start from
   * your defaults. `f.*` annotations inside the template carry over to
   * added items.
   */
  template?: T;
}

/** Wrap repeated content (projects, events, testimonials). The editor gets add/duplicate/delete/reorder. */
export function defineCollection<T extends Content>(items: T[], _opts?: CollectionOptions<T>): T[] {
  return items;
}

/**
 * Field annotations for when inference isn't enough.
 * Zero-cost: each returns its argument; the AST layer reads the call.
 */
export const f = {
  /** Single-line text (this is also the inference default for short strings). */
  text: (value: string): string => value,
  /** Force a multi-line editor even for a short string. */
  textarea: (value: string): string => value,
  /** Markdown editor. */
  markdown: (value: string): string => value,
  /** Image path under the public-assets root (e.g. "/photos/x.jpg"). */
  image: (value: string): string => value,
  /** Link: internal path or full URL. */
  url: (value: string): string => value,
  /** ISO date, "YYYY-MM-DD" (also inferred automatically for strings in that shape). */
  date: (value: string): string => value,
  /**
   * One value from a fixed set, shown as a dropdown in the editor. Options should
   * read like labels; editors see them verbatim.
   *
   *   status: f.select("upcoming", ["upcoming", "sold out", "past"]),
   */
  select: <T extends string>(value: T, _options: readonly T[]): T => value,
  /**
   * An HTML fragment, edited as rich text. For sites that already store
   * HTML strings; prefer f.markdown() for new content instead.
   *
   * SECURITY: editsy does not sanitize this value. Whatever HTML an editor
   * saves here is exactly what your site renders, so if you render it with
   * `dangerouslySetInnerHTML` (or equivalent), anyone who can save this
   * field can inject arbitrary markup and scripts into your pages for every
   * visitor. That's an acceptable risk for a single trusted maintainer; it
   * is not once you have multiple editors, a shared GitHub token, or any
   * editor account you wouldn't hand your GitHub push access to directly.
   * If that's your setup, sanitize the value yourself before rendering
   * (e.g. with a library like DOMPurify) rather than rendering it as-is.
   */
  html: (value: string): string => value,
} as const;

/** The set of field-annotation names, shared with the AST layer. */
export type AnnotationKind = keyof typeof f;
