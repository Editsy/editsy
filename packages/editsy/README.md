# editsy

> The little CMS that lives in your repo · [editsy.dev](https://editsy.dev)

Small Next.js and React sites usually keep their copy in typed TypeScript
files. That works great right up until someone who doesn't code needs to
change something. editsy puts an editing UI on top of those files (JSON
and markdown files too): no database, no hosted dashboard, and your files
stay the source of truth.

Already have files like that? editsy edits plain object/array default
exports as-is (`as const` and `satisfies` included), with no code changes:
just `npx editsy edit`.

This package is the optional-but-recommended runtime, and it's intentionally
tiny: `defineContent`, `defineCollection`, and the `f.*` field helpers are
all identity functions. They add type constraints (no functions or JSX
sneaking into content) and field annotations that inference can't guess;
your site just consumes plain data.

```ts
// content/home.ts
import { defineContent, f } from "editsy";

export default defineContent({
  hero: {
    heading: "Skate nights, all winter long.",
    body: f.markdown("We rent the rink, **you show up**."),
    poster: f.image("/posters/skate.jpg"),
    cta: { label: "See the schedule", href: f.url("/events") },
    firstSession: "2026-10-09", // ISO dates get a date picker for free
  },
});
```

Then edit in the browser:

```sh
npx editsy edit
```

Field types are inferred from your values (short string → text input, long →
textarea, `YYYY-MM-DD` → date picker, arrays of objects → collections with
add/duplicate/reorder). The `f.*` helpers pin down the rest: `text`,
`textarea`, `markdown`, `html`, `image`, `url`, `date`, and `select` (a
type-safe dropdown: `f.select("upcoming", ["upcoming", "past"])`). Plain `.json` content
files work too, same editor, no wrappers, and so do named exports
(`export const events = [...]`) and `.md` files with frontmatter (keys
become fields, the body edits as rich text). Every save shows a diff of the file change
before writing, and the writes are AST rewrites, so your comments and
formatting survive.

Collections can declare what a new item looks like with
`defineCollection(items, { template: {...} })`, so the editor's "+ add
item" starts from your defaults (annotations included) and even an empty
collection can grow.

`f.html()` is for sites that already store HTML fragments; prefer
`f.markdown()` for new content. It's unsanitized: whatever an editor saves
is exactly what your site renders, so if you have more than one trusted
editor, sanitize the value yourself before rendering it.

Want to hand editing to someone non-technical, on the deployed site, with a
login and no git anywhere in sight? That's [@editsy/next](https://npmjs.com/package/@editsy/next).

Docs and the rest of the story: [github.com/editsy/editsy](https://github.com/editsy/editsy). MIT.
