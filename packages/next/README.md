# @editsy/next

Serve the editsy content editor from your deployed Next.js site. Editors
visit `yoursite.com/editsy`, log in (no GitHub account, no local setup),
edit with a diff review, and publish. The publish is a git commit behind the
scenes, so your host redeploys the site like it would for any push.

## Setup

`npx editsy init` scaffolds all of this (create-only, never overwrites).
By hand, it's one catch-all route, `app/editsy/[[...editsy]]/route.ts`:

```ts
import { createEditsy } from "@editsy/next";

export const { GET, POST } = createEditsy();
```

When you're done configuring, `npx editsy doctor` verifies the whole setup,
including a live test of the GitHub token.

Then environment variables:

| Variable | Purpose |
|---|---|
| `EDITSY_SECRET` | Session-cookie signing secret (long + random) |
| `EDITSY_EDITORS` | The editors list, a JSON ARRAY (shape below) |
| `EDITSY_SMTP_URL` | `smtps://user:pass@host`, enables "email me a login link" |
| `EDITSY_EMAIL_FROM` | Sender for login emails (default: the SMTP user) |
| `EDITSY_BASE_URL` | The site's canonical origin (`https://www.example.com`); login-link emails build their URLs from it instead of the request's Host header |
| `EDITSY_GITHUB_REPO` | `owner/repo`, enables the GitHub backend (saves become commits) |
| `EDITSY_GITHUB_TOKEN` | Fine-grained PAT with contents read/write on that one repo |
| `EDITSY_GITHUB_BRANCH` | Branch to commit to (default `main`) |

One assumption worth stating: publishing works by committing to that
branch, so **pushes to it should trigger an automatic deployment** (the
default on Vercel, Netlify, and similar hosts). Without deploy-on-push,
publishes land safely in git but only go live on your next manual deploy.

## The editors list

`EDITSY_EDITORS` is a JSON array; keep the `[ ]` even for one editor:

```json
[
  { "name": "Amy", "email": "amy@example.com", "passwordHash": "scrypt$..." },
  { "name": "Sam", "email": "sam@example.com" }
]
```

Each entry needs `name` and `email`, plus one of:

- `passwordHash`: what `npx editsy hash-password` prints (run it with no
  argument and it prompts without echoing). The right choice for anything
  deployed.
- `password`: plaintext, tolerated for quick local testing only.
- neither: link-only login (needs `EDITSY_SMTP_URL`), a good default for
  non-technical folks.

You can also commit the same array as `editsy.editors.json` at the project
root, but **only with `passwordHash`**: that file is specifically meant to
be checked into git (the `.htpasswd` pattern), and `loadEditorsFile`
refuses to load it if any entry has a plaintext `password`. Env and file
merge, with env winning on duplicate emails. Login attempts are rate
limited either way, and emailed login links switch on automatically when
SMTP credentials are present.

Set `EDITSY_BASE_URL` whenever email login is on. Most platforms pin the
Host header, but the canonical origin removes the question entirely, and
`npx editsy doctor` will nag you about it. Sessions are `__Host-`-prefixed
HttpOnly cookies on HTTPS, and changing an editor's password (or removing
the editor) logs them out everywhere on the spot.

Each publish commits with the editor credited (`Edited-by: name <email>`),
and conflicts (a file changed since it was loaded) are refused with a reload
prompt rather than clobbered; GitHub's own SHA check backs that up. Edits
across several content files publish as ONE commit (so one rebuild), and the
whole batch is refused if any file is stale.

A publish goes live only after your host rebuilds the site, usually a minute
or two. The editor says so: after publishing it keeps showing the new
content in the preview and puts up a "your site is rebuilding" note instead
of flashing back to the old build. Editors can keep editing the whole time.

Image uploads are validated server-side (no SVG, magic-byte checks, 4 MB
cap) and commit immediately, each upload its own commit under the
assets folder's `uploads/`, so it also triggers a rebuild.

Without the GitHub variables the backend is the local filesystem. That's
right for `next dev`; in production it means saves write to whatever
filesystem the deployed function has, which on most serverless hosts
(Vercel included) is read-only or reset on every deploy, so edits can fail
or quietly not persist. In that case the editor shows a warning banner
rather than pretending everything's fine; set the GitHub variables to fix
it. If auth isn't configured at all in production, the route answers 503
instead of exposing an open editor to the internet.

Options if you need them:
`createEditsy({ basePath, config: { content, assets, siteUrl }, backend, auth, mailer })`.
The `ContentBackend` interface lives in `@editsy/cli` if you want to bring
your own storage.

## Deploying on Vercel (and other serverless hosts)

The editor's UI assets (`@editsy/editor`'s built `dist/`) are read from disk
at request time, so Next's bundler can't discover them on its own. Add this
to `next.config.ts`, matching wherever your `app/editsy/...` route lives:

```ts
import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["@editsy/cli"],
  outputFileTracingIncludes: {
    "/editsy/**": [
      "./node_modules/**/@editsy/editor/dist/**",
      "./node_modules/**/@editsy/editor/package.json",
    ],
  },
};

export default config;
```

Every line of that snippet earns its keep, and each omission fails
silently, serving "The editor UI isn't built" or a blank page instead of
an error:

- `serverExternalPackages` keeps `@editsy/cli` out of the route's webpack
  bundle. Inlined, the cli's code runs from `.next/server/...`, where the
  runtime lookup that locates the editor UI can't see into your package
  manager's store. External, it runs from node_modules and resolution just
  works. (editsy also ships a store-scanning fallback, but don't lean on
  it.)

- The include-glob **key** must not contain literal `[` `]` characters.
  Next matches the key as a picomatch glob against its internal route path
  (e.g. `/app/editsy/[[...editsy]]`), and picomatch parses square brackets
  as its own character-class syntax, not literal text. A key that mirrors
  your route folder's brackets, like `"/editsy/[[...editsy]]"`, will never
  match. A bracket-free wildcard like `"/editsy/**"` does.
- The include-glob **value** can't assume `@editsy/editor` is hoisted to
  your project's top-level `node_modules`. It's a dependency of
  `@editsy/cli`/`@editsy/next`, not of your project directly, so pnpm's
  default (non-hoisted) install layout nests it inside their own isolated
  store entries instead of your project root. The recursive `**` before
  `@editsy/editor` in the snippet above finds it regardless of package
  manager or hoisting layout.
- The **package.json** line matters too: the editor's on-disk location is
  found at runtime by resolving `@editsy/editor`, and a pruned serverless
  bundle only contains traced files. Recent editsy versions can fall back
  to resolving a dist file directly, but tracing the package.json is the
  reliable route.

Verify it worked by checking the build output for your route's trace file
(`.next/server/app/editsy/[[...editsy]]/route.js.nft.json`) and confirming
it lists files under `@editsy/editor/dist`, or just visit `/editsy` after
deploying.

Full story: [github.com/editsy/editsy](https://github.com/editsy/editsy). MIT.
