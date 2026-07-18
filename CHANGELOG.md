# Changelog

All packages (`editsy`, `@editsy/cli`, `@editsy/editor`, `@editsy/next`,
`@editsy/mcp`) version in lockstep; one entry covers a release of all of them.

## Unreleased

### AI agents get the same keys as editors

- **New package `@editsy/mcp`**: an MCP server exposing four tools
  (`list_content_files`, `read_content`, `write_content`, `check_content`)
  so AI agents edit content through the same pipeline as the editor UI.
  Reads return structured values plus a field map (which strings are
  markdown, which are dates, what a new collection item looks like); writes
  go through the AST rewriter (comments and formatting survive), carry rev
  conflict checks (a file changed underneath the agent is refused, never
  overwritten), stay inside the content globs, and return a unified diff
  for review. Local disk only in this release; remote/GitHub mode is out on
  purpose until agent auth has a design worth trusting. The protocol layer
  is a deliberately small stdio implementation (tools only, one module), so
  the package adds no new third-party dependencies.
- **`editsy init` scaffolds an `AGENTS.md`** carrying the editsy
  conventions, so agent-built sites start editable. Create-only like the
  rest of init: an existing AGENTS.md that mentions editsy is left in
  peace, and one that doesn't gets a paste-in snippet printed instead.

## 0.0.11 (2026-07-06)

### A tiny CMS grows into blogs

- **`f.select()`**: one value from a fixed set, rendered as a dropdown.
  `status: f.select("upcoming", ["upcoming", "sold out", "past"])` is
  type-checked (the value must be an option), edited without typos, and a
  file value that's fallen outside the options stays selectable rather
  than being silently replaced.
- **Duplicate a file from the editor**: the "new post" primitive for
  file-per-entry sites. Names are sanitized server-side (directory parts
  stripped, the source's extension enforced, familiar extensions people
  type from habit handled), the new path must match the content globs, and
  collisions are refused. In git-backed mode the copy is a commit
  immediately, like an upload.
- **The sidebar scales**: files group by folder, and a filter box appears
  once a project passes eight files.

An adversarial pass over all of the above then fixed: duplicate-name
collisions are checked case-insensitively (a case-only "new" name would
overwrite the original on Windows/macOS filesystems); extensionless
sources no longer confuse the name sanitizer; frontmatter values keep
their trailing `# comments` through edits, like real YAML parsers read
them; `editsy init` matches Next's root-`app/`-over-`src/app` precedence;
and the editor package gained its first test suite, covering the
crash-recovery value application.

### Markdown files are content

- `.md` files under the content globs (now `content/**/*.{ts,json,md}` by
  default) are editable: frontmatter keys become inferred fields, the body
  becomes one rich-text markdown field. No YAML dependency; editsy parses
  the frontmatter subset that maps onto its field model (scalars and string
  lists, inline or block style) and flags anything else as an issue rather
  than guessing. Writes stay surgical: only a changed value's bytes on its
  line are replaced, untouched files round-trip byte-exact (CRLF included),
  and quoting and list style are preserved.

### Easier setup

- **`editsy init`** scaffolds a project in one command: `editsy.config.ts`,
  the `/editsy` route (Next.js App Router, `src/app` included), a
  `next.config.ts` with the deployment blocks, a `.env.example`, and a
  freshly generated `EDITSY_SECRET`. Strictly create-only: existing files
  are never touched; where one of yours would need changes, init prints the
  snippet instead of editing it.
- **`editsy doctor`** checks the whole setup and says what's wrong in
  actionable terms: content files, the editor UI, `EDITSY_SECRET`, the
  editors list (warning on plaintext passwords), the Next route and config,
  and a LIVE test of the GitHub token that catches expired and read-only
  tokens before they fail silently at publish time. Reads `.env` files for
  presence checks; never prints a secret's value. Exit code 1 on problems,
  so it can gate CI.

### Hardening

A security pass over the auth stack, from a fresh review before going
public.

- **Login-link emails can't be redirected by a forged Host header.** Magic
  links now build their URL from a configured canonical origin
  (`EDITSY_BASE_URL`, or an absolute `siteUrl`) instead of trusting the
  request's Host header, which closes the classic reset-link-poisoning
  attack. `editsy doctor` warns when SMTP is configured without a base
  URL, and `editsy init`'s `.env.example` includes it.
- **Password hashes carry their cost parameters**
  (`scrypt$N$r$p$salt$hash`), so the work factor can be raised later
  without invalidating anyone's password. New hashes use OWASP's
  recommended cost (N=2^17, up from Node's N=2^14 default); hashes from
  the old parameterless format still verify. Hostile parameter values are
  bounded, and verification moved off the event loop (async scrypt).
- **Sessions end when they should.** Cookies and magic links are now
  signed with a per-editor key derived from the editor's credential, so
  removing an editor or changing their password immediately invalidates
  their sessions and outstanding login links. Stateless revocation, still
  no database. Existing sessions from earlier versions are invalidated by
  this change; editors just log in again.
- **Session cookies get the `__Host-` prefix on HTTPS** (locked to the
  origin, Secure, no subdomain or path tricks), and TLS-terminating
  proxies are recognized via `X-Forwarded-Proto`.
- **`LocalDiskBackend` refuses paths outside the project root** even when
  called programmatically. The API layer already allowlisted paths, but
  the backend is exported too, so containment now lives where the disk is
  touched.

An earlier pass over the write path and renderer:

- The value printer escapes remaining C0 control characters explicitly
  (a paste can carry them; raw they're invisible in TS and outright illegal
  in JSON) and escapes CR in template literals (backticks normalize CRLF at
  parse time, which silently changed the value on reread).
- The markdown renderer ignores forged code-fence placeholders (a literal
  NUL in hostile source rendered the string "undefined").
- The rich-text link dialog refuses targets sites would refuse to render
  (anything other than http(s), mailto, or a site path), instead of
  silently dropping the link at display time.
- The `editsy` runtime declares `sideEffects: false` for bundler
  tree-shaking.

## 0.0.10 (2026-07-03)

Fixes from the first real production runs of 0.0.9.

- **Publishes deploy again.** Commits made by editsy now carry the git
  identity of the GitHub token's owner, with the human editor credited in
  the commit message (`Edited-by: name <email>`), as before. Setting the
  editor as the commit author looked right in git but broke deployment:
  hosts like Vercel refuse to build commits whose author email doesn't
  match a real account, so every publish landed in the repo and then
  silently never went live.
- **Locating the editor UI survives bundlers.** When a site's webpack build
  inlines `@editsy/cli` into the route bundle, module resolution runs from
  `.next/server/...` and can't see into pnpm's store, so a correctly deployed
  `/editsy` then claimed "the editor UI isn't built". The Vercel guide now
  leads with `serverExternalPackages: ["@editsy/cli"]`, and
  `resolveEditorDist` falls back to scanning the working directory's
  package-manager layouts so even bundled deployments recover.

## 0.0.9 (2026-07-03)

### Publishing that respects the rebuild

- Edits across several content files now publish as **one commit** (Git Data
  API: one tree, one commit, a fast-forward-only ref update), so one
  publish means one rebuild rather than one per file. The whole batch is
  refused if any file changed underneath you.
- The editor keeps a draft **per file**: switching files no longer asks you
  to discard anything, the sidebar marks every file with unsaved edits, and
  Save reviews and publishes them together.
- After publishing on a git-backed site, the editor no longer reloads the
  preview into the old deployment (which looked like the edits had been
  lost). The preview keeps showing the published content and a note explains
  the site is rebuilding. Editing can continue immediately.

### Content files, more shapes

- **Named exports are content.** `export const events = [...]` reads and
  writes exactly like a default export. A file with several exports (named
  and/or default) edits as one form with a section per export; hooks name
  the export they consume with a fragment:
  `useEditsy(hero, "content/home.ts#hero")`. Named exports that clearly
  aren't content (functions, components) are skipped without complaint.
- **Empty collections can grow.** `defineCollection(items, { template })`
  declares the shape and starting values of a new item; "+ add item" works
  even on an empty collection, and `f.*` annotations inside the template
  carry over to added items (the template's source text is cloned, same as
  duplicating an existing item).

### Editor quality of life

- **Image upload.** Image fields gained an upload button. Files are
  validated server-side (png/jpg/webp/gif/avif only; no SVG, which can
  carry scripts; magic-byte checks; 4 MB cap; sanitized names), land under
  `uploads/` in the assets folder, and never overwrite anything (collisions
  get a numeric suffix). In git-backed mode an upload is an immediate
  commit, like a media library.

- **Crash insurance.** Unsaved edits are mirrored into localStorage, tied
  to the exact file revision they were made against. After a crash or an
  accidentally closed tab, the editor restores them (as unsaved edits, with
  a note), and quietly drops them if the file has moved on.
- `editsy hash-password` with no argument prompts for the password without
  echoing it, so it never lands in your shell history. Piped stdin works
  too.
- **Phones work.** Below tablet width the editor reflows: the file list
  becomes a horizontal strip, the form goes full-width with 16px inputs
  (no iOS focus-zoom), and the preview pane steps aside: fix a typo from
  your phone, publish, done. Keyboard focus states and icon-button labels
  got an accessibility pass along the way.

### Security and hardening

- `/api/save` requires `baseRev`; omitting it used to silently skip the
  conflict check.
- Login rate limiting keys on the last `X-Forwarded-For` hop (the first is
  attacker-controlled), and the limiter's memory is hard-capped against
  unique-key spray.
- `GitHubBackend` refuses to work from a truncated tree listing instead of
  silently missing files.
- `editsy.editors.json` refuses plaintext passwords (the file is meant to be
  committed; hashes only).
- `@editsy/next` turns configuration and backend errors into clear responses
  instead of opaque platform crash pages, and warns in the editor when
  production saves would hit a non-persistent local disk.
- The writer no longer trips over content fields named after
  `Object.prototype` members (`constructor`, `toString`, ...).
- Editor asset serving uses boundary-aware path containment.

Also: `engines` (Node >= 18.18) and a `next` peer dependency declared
everywhere, `@editsy/next` grew its first test suite, CI tests the Node
floor and current LTS.

## 0.0.7 and earlier

Released before this changelog existed: the AST-preserving editor core,
local `editsy edit`, remote mode (`@editsy/next` + GitHub backend), the auth
ladder (scrypt passwords, magic links, rate limiting), live preview with
WYSIWYG markdown, JSON content files, `f.html`, and editor theming.
