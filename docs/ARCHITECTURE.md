# editsy architecture

How editsy works and why it's built this way. For the elevator pitch, see
the [README](../README.md); for the agent contract, see
[AI-CONVENTIONS.md](AI-CONVENTIONS.md).

## The core idea

Small sites usually keep their copy in typed TypeScript files, with JSON
for config-shaped content and markdown for posts. editsy treats those
files as the content database: the editor UI is *inferred* from the values
in each file, and saves are rewrites of the file itself. There is no
schema to author, no database, and no separate content store to migrate
into. Git is the history.

## Content files

A content file is most often a TS module whose exports are JSON-serializable
literals: strings, numbers, booleans, arrays, plain objects. No functions,
no JSX, no computed values, no spreads. That constraint is what makes
reliable round-tripping possible, and `editsy check` enforces it (CI-friendly,
exit code 1 on violations).

Two shapes:

- `defineContent({...})`: a single object (a page, the footer, settings)
- `defineCollection([...])`: repeated items (posts, projects, events)

`defineCollection` takes an optional second argument,
`{ template: {...} }`: the shape and starting values of a NEW item. It's
what lets the editor's "+ add item" work on an empty collection (otherwise
adding copies the first existing item's shape), and `f.*` annotations
inside the template carry over to added items.

The wrappers are recommended but optional. A plain object or array default
export works too (`as const`, `satisfies`, and parentheses are seen
through), so editsy can sit on top of an existing site's files unmodified.
The wrappers add compile-time enforcement of the constraints above, plus
the `f.*` field annotations.

Named exports are content too: `export const events = [...]` reads and
writes exactly like a default export. A file with SEVERAL exports (named
and/or default) edits as one form with a section per export, and each
export streams into the live preview separately; a hook names the one it
consumes with a fragment, `useEditsy(hero, "content/home.ts#hero")`. Named
exports that clearly aren't content (functions, components) are skipped
silently, so a content file can hold the occasional helper.

Plain `.json` files are content as well: an object is a page, an array of
objects is a collection (i18n dictionaries, config-style content). Fields
are inference-only there, and writes emit strict JSON.

So are `.md` files, the shape most existing sites keep posts in:
frontmatter keys become inferred fields, the body becomes one rich-text
markdown field. There's no YAML dependency; editsy parses the frontmatter
subset that maps onto its field model (scalar strings, numbers, booleans,
dates, and lists of strings, inline or block style) and flags anything
else (nested maps, block scalars) as an issue instead of guessing. Writes
are surgical here too: only a changed value's bytes on its own line are
replaced, and quoting/list style is preserved.

Files are located by globs, by default `content/**/*.{ts,json,md}` and
`src/content/**/*.{ts,json,md}`, configurable in `editsy.config.ts`.

New files come from duplicating an existing one in the editor (the "new
post" workflow for file-per-entry sites): names are sanitized server-side,
the new path must match the content globs, collisions are refused
case-insensitively, and in git-backed mode the copy is a commit
immediately.

## Field inference

The editing form comes from the values, not from a schema:

| Value | Field |
|---|---|
| short string | text input |
| string ≥ ~120 chars or with newlines | textarea |
| string shaped `YYYY-MM-DD` | date picker |
| number / boolean | matching inputs |
| `string[]` | list editor |
| array of objects | collection (add / duplicate / reorder / delete) |
| nested object | fieldset |

Where inference can't guess, `f.*` annotations pin the field down:
`f.markdown()` (WYSIWYG editing, markdown on disk), `f.html()` (WYSIWYG
over an HTML fragment a site already stores; unsanitized by editsy, the
site is responsible for sanitizing it before rendering if there's more
than one trusted editor), `f.image()` (picker over the public-assets
folder, with thumbnails, plus upload: validated server-side, written
under `uploads/`, an immediate commit in git-backed mode, and SVG is
refused because it can carry scripts), `f.url()`, `f.date()`,
`f.textarea()`, `f.text()`, and `f.select()` (one value from a fixed set,
a dropdown in the editor, type-checked so the value must be an option).
At runtime every `f.*` helper returns its argument unchanged; the call
expression in the source is the annotation,
and the site consumes plain data. Key names become form labels
(`heroImage` → "Hero Image"), which is why content files should use
human-readable keys.

## Reading and writing

Parsing uses the TypeScript compiler API directly (just the parse tree, no
type checker), so the engine runs in Node and in the browser.

The writer never mutates the AST. It walks the parse tree alongside the new
values and emits position-based text edits against the original source,
applied back to front. Anything untouched survives byte-for-byte: comments,
quote style, formatting. When collection items are added, duplicated, or
reordered, each surviving item is rendered from its original source text
(with its field edits applied inside that slice), so comments and `f.*`
annotations travel with the item. There is no regex anywhere in the writer.

One documented limitation: when an array is structurally rebuilt, comments
*between* items (rather than inside them) can be dropped.

Every save is preceded by a review step showing the exact unified diff of
the file change. Saves also carry a revision (a content hash locally, the
blob SHA on GitHub); if the file changed since the editor loaded it, by
another editor, a coding agent, or a `git pull`, the save is refused with a
reload prompt instead of clobbering.

## Two modes, one backend seam

The editor UI and the HTTP API are shared between modes. All content I/O
goes through a `ContentBackend` interface (`listContentFiles`, `readContent`,
`writeContent`, an optional batched `writeMany`, `listAssets`), and the API
is a fetch-style
`Request → Response` handler, so the same code serves both:

- **Local mode**: `npx editsy edit` runs a small server on 127.0.0.1
  backed by the local disk. No auth: it never leaves localhost. The
  preview pane iframes your dev server.
- **Remote mode**: `@editsy/next` mounts the same editor and API at a
  route on the deployed site (`yoursite.com/editsy`, one catch-all route
  file). The backend is the GitHub API: reads fetch from the repo, saves
  become commits (attributed per editor with an `Edited-by:` trailer), and
  publishing is whatever redeploy your host already does on push. GitHub's
  SHA check backs the conflict refusal.

The GitHub token is a fine-grained PAT (or GitHub App installation token)
scoped to the one repo, held server-side in env.

Because every publish costs a rebuild, a publish covering several edited
files is ONE commit, made through the Git Data API: the changed files go
into one tree, one commit, and a fast-forward-only ref update, which
doubles as an atomic conflict check against concurrent publishes (if the
branch moved since the editor read it, the update fails and nothing is
written). Single-file saves use the simpler contents API.

The rebuild also shapes the editor's after-publish behavior. The commit
lands immediately, but the deployed site serves the old build until the
rebuild finishes, so reloading the preview right after publishing would
show the OLD content and read as "my edits vanished." Instead the editor
keeps streaming the published values into the preview (they are exactly
what the deploy will serve), shows a "your site is rebuilding" note, and
lets editing continue. In local mode saves hit disk and the dev server
reflects them instantly, so there the preview simply reloads.

## Auth, without a database

Remote mode needs logins for non-technical editors, and deliberately has no
user database: editors live in an env var (`EDITSY_EDITORS`) or a
committed `editsy.editors.json`, and sessions are stateless HMAC-signed
HttpOnly cookies (with the `__Host-` prefix on HTTPS). Tokens are signed
with a per-editor key derived from the editor's credential, so removing an
editor or changing their password revokes their sessions and outstanding
login links immediately: stateless revocation, no session store. It's a
ladder; sites use the rungs their setup supports, and the login screen
adapts:

1. **Password**: works everywhere. Passwords are scrypt-hashed
   (`editsy hash-password` prints an entry; hashes are safe to commit, same
   idea as `.htpasswd`). Each hash carries its own cost parameters, so the
   work factor can rise without invalidating existing passwords. Plaintext
   is tolerated for dev. Login attempts are rate-limited per client+email,
   with timing kept flat across unknown-email and wrong-password paths.
2. **Emailed login links**: enabled by SMTP credentials
   (`EDITSY_SMTP_URL`), the credential nearly every site owner has. Links
   are 15-minute signed tokens, kind-tagged so a link token can never pose
   as a session cookie; the request endpoint never reveals who is an
   editor. Link URLs are built from the configured canonical origin
   (`EDITSY_BASE_URL`), never a forgeable Host header. Editors without a
   password are link-only. Other transports can implement the small
   `Mailer` interface.

A production deployment with no auth configured answers 503 rather than
exposing an open editor. The target security bar: a well-kept WordPress
install, with far less surface area.

## Live preview

The preview pane shows the real site. In local mode, saves hit disk and the
framework's HMR refreshes the iframe. On top of that, both modes support
*pre-save* preview: the editor streams debounced drafts into the iframe via
`postMessage`, and the `useEditsy(content, "content/file.ts")` hook from
`editsy/react` swaps them into React state. On the live site the hook is
inert; inside the editor, typing updates the preview immediately, and
Discard restores the on-disk state. The hook only accepts messages from its
parent window.

Caveat: content consumed in React *server* components can't live-update in
the client; pages that want keystroke preview consume content in client
components. Everything else falls back to refresh-on-save.

Markdown fields render on sites via the `Markdown` component
(`editsy/react`), which escapes all HTML and restricts link targets to
http(s)/mailto/relative, so content can never inject markup. In the editor,
markdown fields are WYSIWYG (ProseMirror via TipTap, markdown↔HTML behind
the scenes) with a raw-markdown toggle; the file keeps clean markdown.

## Package layout

```
packages/editsy   runtime: defineContent, f.*, editsy/react, editsy/markdown
packages/cli      `editsy` CLI + the API core, backends, auth (also the
                  programmatic API adapters build on)
packages/editor   the editing UI (Vite + React), served by cli and next
packages/next     the deployed-site adapter (one route + env vars)
packages/mcp      MCP server: AI agents read/write content through the
                  same pipeline (see AI-CONVENTIONS.md)
examples/basic-site  a small Next.js site used for docs, tests, demos
```

MIT. Versions move in lockstep; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Neighbors

Closest relatives are Keystatic, TinaCMS, and Decap: file-based,
git-backed editors, all good tools. Differences that matter here:

| | Keystatic / Tina / Decap | editsy |
|---|---|---|
| Content format | Markdown / YAML / JSON | The TS, JSON, and markdown files the site already has |
| Schema | Config you author | Inferred from the values |
| Adoption | Restructure content around their model | Point it at existing files |
| Non-GitHub editor logins | Their hosted cloud services | Self-hosted password/email auth, no service |

editsy also ships an agent contract
([AI-CONVENTIONS.md](AI-CONVENTIONS.md)): sites built by AI coding agents
that follow it are editable by construction.

## Non-goals

editsy is not a page builder or a design system, and it has no i18n,
roles, workflows, drafts, or scheduling. Structure and layout stay in
code, where the developer (human or agent) owns them, and editsy edits
content within the model you defined. That's the whole idea.

## Known limitations

- An empty collection with no `template` can't infer an item shape, so
  "add item" there needs at least one existing item (or a template).
- Magic links are time-limited but not single-use (stateless tradeoff).
- Comment preservation between structurally-rebuilt collection items is
  best-effort, as noted above.
