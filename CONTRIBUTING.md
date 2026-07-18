# Contributing to editsy

Thanks for looking under the hood. It's a pnpm workspace:

```
packages/editsy   the runtime (defineContent, f.*), tiny on purpose
packages/cli      AST engine, check, the edit server, auth, backends
packages/editor   the web UI (Vite + React)
packages/next     the "admin on your deployed site" adapter
packages/mcp      the MCP server for AI agents (stdio, tools only)
examples/basic-site   a small Next.js site used for docs, tests, demos
docs/             architecture decisions + the AI agent conventions
```

## Getting set up

```sh
pnpm install
pnpm -r build          # cli exposes its built dist, so build once first
pnpm -r test
pnpm --filter @editsy/cli dev edit --root examples/basic-site
```

If you don't have pnpm installed globally, prefix commands with `corepack`.

To work on the remote mode, run the example site (`pnpm --filter
example-basic-site dev`) and visit `/editsy`; dev login credentials are in
the example's `.env.development`.

## Before you open a PR

- `pnpm -r test` and `pnpm -r check-types` pass
- If you touched the AST engine, add a round-trip test; byte-fidelity of
  untouched source is the core promise and tests are how we keep it
- If you touched `@editsy/cli` source, rebuild it before testing the
  example site (the site consumes the built dist)
- New behavior that changes the design should update
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) so the doc and the code
  don't drift apart
- Public-facing copy (README, package pages) stays warm and plainspoken:
  concrete over superlative, full connected sentences rather than punchy
  fragments, show the code instead of calling anything "powerful", and say
  plainly what editsy doesn't do

Small PRs land fastest. If you're planning something big, open an issue
first so we can talk it through.

## Releasing (maintainers)

Versions move in lockstep across packages for now, and main only takes
pull requests, so a release starts as a PR like anything else:

```sh
git switch -c release-0.0.x
pnpm -r exec npm version 0.0.x   # bump each package
pnpm -r build && pnpm -r test
git commit -am "release: 0.0.x"
git push -u origin release-0.0.x # open the PR, let CI pass, merge
```

Then publish and tag from the merged main:

```sh
git switch main && git pull
pnpm publish -r --access public  # prompts for the npm OTP
git tag v0.0.x && git push origin v0.0.x
```

