# editsy conventions for AI coding agents

You are building or modifying a site that uses **editsy**, a file-based CMS
that turns a site's content files (TypeScript, JSON, or markdown) into an
editing UI. Follow these rules and the site's copy becomes editable by
non-developers with zero extra work.

## The one rule

**All human-editable copy lives in content files, never inline in
components.** If a human might want to reword it, it belongs in
`content/*.ts` wrapped in `defineContent()` (single objects) or
`defineCollection()` (repeated items). Components import content and render
it.

## Content file rules

1. Values must be JSON-serializable literals: strings, numbers, booleans,
   arrays, plain objects. **No functions, no JSX, no computed values, no
   spreads** inside `defineContent(...)` / `defineCollection(...)`.
   (editsy can also edit plain unwrapped default exports, so existing
   sites work without changes, but when *you* write or touch a content
   file, use the wrappers: they enforce these rules at the type level.)
2. One file per page or per concern: `content/home.ts`, `content/about.ts`,
   `content/projects.ts`. Shared bits (footer, contact details) in
   `content/global.ts`. Default exports and named `export const` both work;
   a file with several exports edits as one form with a section per export.
   Sites that keep posts in `.md` files can leave them there: frontmatter
   keys and the body are editable too, under the same content globs.
2b. Give every `defineCollection` a **template**: the shape and starting
   values of a new item:

   ```ts
   export default defineCollection([...items], {
     template: { title: "New project", date: "2026-01-01", summary: f.markdown("") },
   });
   ```

   Without one, the editor's "+ add item" copies the first existing item's
   shape, and an empty collection can't grow at all.
3. Use `f.*` field annotations when inference isn't enough:
   `f.markdown()` for rich text, `f.image()` for images (paths under
   `/public`), `f.url()` for links, `f.textarea()` to force multi-line,
   `f.date()` for dates, and `f.select()` for one value from a fixed set
   (`status: f.select("upcoming", ["upcoming", "sold out", "past"])`;
   the editor shows a dropdown, and the options should read like labels).
   Store dates as ISO `"YYYY-MM-DD"` strings; they
   get a date picker automatically, and format them for display in the
   component, not in the content. Use `f.html()` only when a site already
   stores HTML fragments; default to `f.markdown()` for new rich text, since
   it renders through editsy's escaping-safe `Markdown` component.
   `f.html()` fields are rendered exactly as saved with no sanitization: if
   you use one, either render it with `dangerouslySetInnerHTML` only when
   you're confident every editor is fully trusted, or sanitize the value
   yourself first (e.g. with DOMPurify) and say so in a comment next to the
   render call, the same way you would for any other unsanitized HTML.
4. Give fields human-readable key names (`heading`, not `h1Txt`); keys
   become edit-form labels.
5. Keep structure/layout decisions OUT of content: no class names, no raw
   variant enums a non-developer wouldn't understand. When an editor DOES
   need a choice (a status, a badge), give it to them as `f.select()` with
   options that read like labels. Content is words, images, links, item
   lists, and the occasional labeled choice.

## Component rules

6. Import content at the top of the page/component and render from it.
   Where the site should support editsy's live preview (recommended for
   pages), consume content in a client component through `useEditsy`,
   passing the content file's repo-relative path:

   ```tsx
   "use client";
   import { useEditsy } from "editsy/react";
   import homeContent from "@/content/home";

   export default function Home() {
     const home = useEditsy(homeContent, "content/home.ts");
     return <h1>{home.hero.heading}</h1>;
   }
   ```

   On the live site the hook is a no-op; inside the editsy editor it makes
   edits appear in the preview before they're saved. When a file has several
   exports, name the one this hook consumes with a fragment:
   `useEditsy(hero, "content/home.ts#hero")`.

6b. Render `f.markdown()` fields with the `Markdown` component from
   `editsy/react` (it escapes HTML and restricts link targets; never
   render markdown fields with `dangerouslySetInnerHTML` yourself):

   ```tsx
   import { Markdown } from "editsy/react";
   <Markdown source={home.about.body} />
   ```

7. Never transform copy in ways that break editing expectations (e.g. don't
   `.toUpperCase()` a heading in JSX if the design needs caps; use CSS, so
   what the editor types is what appears).
8. For collections, render whatever the array holds; item count must never
   be hardcoded. Empty and one-item states must look fine.

## What NOT to do

- Don't hardcode copy in JSX "temporarily"; wire it through content from the
  first draft.
- Don't add fields the design doesn't render, or render things not in content.
- Don't edit content-file *values* when asked to change design/structure;
  don't restructure content files when asked to change copy (just change the
  values).

## Editing content values over MCP

The rules above are for building and changing the site's code. When the
task is editing the *content* (copy changes, new collection items, fixed
typos, updated dates), prefer the `@editsy/mcp` server when the project has
it configured: `read_content` returns a file as structured values with a
field map, `write_content` saves them through editsy's own rewriter
(comments and formatting survive, stale writes are refused, and you get a
diff back), and `check_content` validates the project afterward. Editing
the file text directly works too; the MCP route just can't produce an
invalid content file.

## Checklist before you finish a task

- [ ] Every visible string traces to a `content/*.ts` file
- [ ] `npx editsy check` passes
- [ ] New repeated sections use `defineCollection`, with a `template`
- [ ] Field keys read like labels a client would understand
- [ ] Markdown fields render through `Markdown` from `editsy/react`
- [ ] Pages consume content via `useEditsy` in a client component (live preview)
