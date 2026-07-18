# editsy

> The little CMS that lives in your repo · [editsy.dev](https://editsy.dev) · made by [Kite & Rail](https://kiteandrail.com)

[![npm](https://img.shields.io/npm/v/editsy)](https://www.npmjs.com/package/editsy)
[![CI](https://github.com/editsy/editsy/actions/workflows/ci.yml/badge.svg)](https://github.com/editsy/editsy/actions)
[![minzipped size](https://img.shields.io/bundlephobia/minzip/editsy)](https://bundlephobia.com/package/editsy)
[![downloads](https://img.shields.io/npm/dm/editsy)](https://www.npmjs.com/package/editsy)
[![license](https://img.shields.io/npm/l/editsy)](LICENSE)

If you build small Next.js or React sites, you've probably ended up with a
file like this:

```ts
// content/home.ts
export default {
  hero: {
    heading: "Skate nights, all winter long.",
    cta: { label: "See the schedule", href: "/events" },
  },
};
```

It's a setup that works beautifully for developers: typed, versioned, and
no infrastructure to babysit. The catch shows up later, when someone who
doesn't code needs to fix a typo or add an event and the instructions
start with "first, install VS Code..."

editsy puts an editing UI on top of the content files you already have,
so there's no database to run, no hosted dashboard, and no rebuilding your
site around somebody else's content model. Your files stay the source of
truth, and edits land in them as clean, reviewable diffs.

## How it works

Already have content files like the one above? You don't need to change
them. Anything matching the content globs (`content/**/*.{ts,json,md}` by
default, configurable) that exports a plain object or array is editable as-is,
including default exports, named `export const`, `as const`, and
`satisfies`. Run `npx editsy edit` and you're editing.

The `defineContent` wrapper and `f.*` helpers are there when you want more:
type-checking that keeps functions and JSX out of content, and field
annotations for the things inference can't guess (markdown, images):

```ts
import { defineContent, f } from "editsy";

export default defineContent({
  hero: {
    heading: "Skate nights, all winter long.",
    body: f.markdown("We rent the rink, **you show up**."),
    poster: f.image("/posters/skate.jpg"),
    firstSession: "2026-10-09",
  },
});
```

Then run `npx editsy edit`. The editing form is inferred from your values:
short strings become text inputs, long ones become textareas, `2026-10-09`
gets a date picker, and arrays of objects become collections you can add
to, reorder, and duplicate. The `f.*` helpers cover the rest (markdown,
images, links), and they're just identity functions, so your site keeps
consuming plain data. Image fields pick from your public assets, or upload
new ones, validated server-side and dropped under `uploads/`. Collections can
declare what a new item looks like with
`defineCollection(items, { template: {...} })`, so "+ add item" starts
from your defaults and even an empty collection can grow.

Markdown fields get a proper rich-text editor (bold looks bold, lists look
like lists) while the file keeps clean markdown underneath, and there's a
raw view for when you'd rather see the markdown itself. Sites render those
fields with the `Markdown` component from `editsy/react`, which escapes
everything, so content can't smuggle HTML into your pages.

Sites that keep posts in `.md` files are covered too: frontmatter keys
become form fields, and the body edits as rich text. The writes are just as
surgical there, with no YAML parser dependency and quoting and list style
preserved.

The preview pane shows your actual site, and it updates as you type, before
you save. (One hook makes that work: `useEditsy`, see the example site.)
Changed your mind? Discard puts everything back the way it was. When you do
save, you review the exact file diff first. Saves are AST rewrites of your
actual TypeScript, not regex surgery, so comments, quote style, and
formatting survive untouched.

There's also `npx editsy check` for CI, so nothing unserializable sneaks
into a content file.

## Handing over the keys

This is the part I built editsy for: letting a non-technical person edit
the site without touching git, GitHub, or a terminal.

Add one route to your Next.js app (or run `npx editsy init`, which creates
it and the rest of the scaffolding for you):

```ts
// app/editsy/[[...editsy]]/route.ts
import { createEditsy } from "@editsy/next";

export const { GET, POST } = createEditsy();
```

Now `yoursite.com/editsy` is a login page. Editors sign in with a password
or an emailed login link, edit with the same diff-review flow, and hit
publish. Behind the scenes that's a git commit, credited to the editor,
with edits across several files landing as one commit and one rebuild, and
your host redeploys like it would for any other push. While the rebuild
runs, the editor keeps previewing the published content and says the site
is on its way, so there's no "did my changes vanish?" moment. This does
assume pushes to your branch trigger a deployment, which is how Vercel,
Netlify, and friends already work. See [@editsy/next](packages/next) for
the env vars.

There's deliberately no user database. Editors live in an env var or a
committed `editsy.editors.json` with scrypt-hashed passwords (the same
idea as `.htpasswd`), sessions are signed cookies, and login attempts are
rate limited. The security bar I aim for is a well-kept WordPress install,
with a lot less surface area.

## Works nicely with AI coding agents

If an AI agent builds or maintains your site, point it at
[docs/AI-CONVENTIONS.md](docs/AI-CONVENTIONS.md) from your project's agent
instructions. An agent that follows it produces sites that are
editable by construction: all human copy in content files, components
rendering from them, nothing hardcoded in JSX. Sites written by humans who
keep to the same habit get the same benefit.

When the task is editing the content itself, there's
[`@editsy/mcp`](packages/mcp): an MCP server that gives agents the same
pipeline the editor uses. They read a content file as structured values,
send back edits, and the save preserves comments and formatting, refuses
stale writes, and returns a diff to review. Register it with your MCP
client from the site's repo:

```sh
claude mcp add editsy -- npx -y @editsy/mcp
```

## Status

Pre-alpha. Both modes work end to end, there's a decent test suite (175
tests, including the AST round-trip and auth), and the first production
sites publish through it, but it's early and the docs are still catching
up to the code. Expect some sharp edges, and please tell me what breaks.

editsy is itsy bitsy on purpose. Page building, design systems, i18n,
workflows, and roles are jobs for a bigger tool; structure and layout stay
in code, where they belong, and editsy edits content within the model you
defined. That's the whole idea.

## Development

```sh
pnpm install
pnpm -r test
pnpm --filter @editsy/editor build
pnpm --filter @editsy/cli dev edit --root examples/basic-site
# → http://localhost:4499  (run the example's `next dev` too for the preview pane)
```

No global pnpm? Prefix commands with `corepack`, which ships with Node.

Design decisions and the roadmap live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). MIT licensed.
