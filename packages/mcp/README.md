# @editsy/mcp

An MCP server for [editsy](https://editsy.dev): AI agents read and edit a
site's content files through the same safe pipeline the editor UI uses.
Values change, comments and formatting stay, stale writes are refused, and
every save returns a diff.

An agent can already open your content files and edit the source directly,
so what this buys you is the guarantees around that edit: the write goes
through editsy's AST rewriter instead of a text patch, it can't touch
anything outside your content globs, a file that changed underneath the
agent is refused rather than overwritten, and what comes back is a
reviewable diff. It also means agents without shell access (or that you'd
rather not give it) can still edit content.

## Setup

Run it from the root of a site that has content files editsy can read
(see [editsy](https://npmjs.com/package/editsy) if you're starting fresh).

Claude Code:

```sh
claude mcp add editsy -- npx -y @editsy/mcp
```

Any client that takes a JSON server config (Cursor, Claude Desktop, ...):

```json
{
  "mcpServers": {
    "editsy": {
      "command": "npx",
      "args": ["-y", "@editsy/mcp", "--root", "/path/to/your/site"]
    }
  }
}
```

`--root` defaults to the working directory; pass it when the client starts
the server somewhere else.

## Tools

| Tool | What it does |
| --- | --- |
| `list_content_files` | The editable files (everything matching the project's content globs) |
| `read_content` | One file as structured values, plus a field map (text vs markdown vs date vs select) and a `rev` |
| `write_content` | Save edited values; preserves comments/formatting, checks `rev` for conflicts, returns a unified diff |
| `check_content` | Validate every content file, the same check `npx editsy check` runs in CI |

## Scope, on purpose

This release is local disk only: the server edits files in the working
tree, and your normal git flow is the review step. It does not talk to the
GitHub backend or publish commits, and it has no auth of its own, the same
trust model as running `editsy edit` locally. If an agent should not be
able to edit your working tree, don't give it this server.

Building a site with an agent rather than editing content? That contract
is [AI-CONVENTIONS.md](https://github.com/editsy/editsy/blob/main/docs/AI-CONVENTIONS.md).

MIT. Part of [github.com/editsy/editsy](https://github.com/editsy/editsy).
