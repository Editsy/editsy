# @editsy/cli

The editsy command line, five commands in all:

- **`editsy init [--root <dir>]`** scaffolds a project: an
  `editsy.config.ts`, the `/editsy` route (when it finds a Next.js App
  Router), a `next.config.ts` with the deployment blocks, a `.env.example`,
  an `AGENTS.md` carrying the conventions that keep the site editable when
  AI agents work on it, and a freshly generated `EDITSY_SECRET`. Strictly
  create-only; existing files are never touched (it prints snippets
  instead).
- **`editsy edit [--port <n>] [--root <dir>] [--no-open]`** serves the local
  content editor over your project's content files. Inferred forms, a diff
  review before every write, conflict detection if something else changed
  the file, and an iframe preview of your dev server.
- **`editsy check [--root <dir>]`** validates that content files hold only
  plain, JSON-serializable literals (wrapped in `defineContent()` /
  `defineCollection()` or not). Exit code 1 on issues. Made for CI.
- **`editsy doctor [--root <dir>]`** checks the whole setup in actionable
  terms: content files, the editor UI, auth config, the Next integration,
  and a LIVE test of the GitHub token (catches expired and read-only tokens
  that otherwise fail silently at publish time). Reads `.env` files for
  presence checks; never prints a secret's value. Exit code 1 on problems.
- **`editsy hash-password`** prints an editor entry with a scrypt hash for
  remote-mode logins (see `@editsy/next`). Run it with no argument and it
  prompts without echoing, so the password stays out of your shell history.

Configuration is optional. If you want it, `editsy.config.ts` at the
project root:

```ts
export default {
  content: ["content/**/*.{ts,json,md}"], // globs locating content files
  assets: "public",                 // image-picker root
  siteUrl: "http://localhost:3000", // dev server shown in the preview pane
  theme: { accent: "#2f8f85" },     // optional: the editor wears your colors
};
```

Theme keys: `accent`, `accentInk`, `bg`, `panel`, `ink`, `muted`, `line`,
`gold` (offset shadows), `font`. All optional; unset keys keep the defaults.

One note on install size: this package depends on `typescript` at runtime.
That's on purpose, since saves are edits to your actual TypeScript AST,
and the compiler's own parser is the only tool I trust to read it.

This package also exports the programmatic API that framework adapters
build on: the fetch-style request handler, the `ContentBackend` interface
(local disk and GitHub implementations included), and the auth utilities.
If you're integrating editsy somewhere new, start here.

Full story: [github.com/editsy/editsy](https://github.com/editsy/editsy). MIT.
