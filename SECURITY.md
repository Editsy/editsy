# Security policy

editsy's remote mode is an authenticated write path into a git repository,
so I take reports seriously.

**Please don't open public issues for vulnerabilities.** Use GitHub's
private vulnerability reporting on this repository ("Security" tab →
"Report a vulnerability"). I'll acknowledge within a few days.

Scope worth probing: the auth broker (`packages/cli/src/auth.ts`: scrypt
hashes carrying their cost parameters, per-editor token keys so a password
change or removal revokes sessions and login links, `__Host-` session
cookies on HTTPS, rate limiting), magic-link URL construction (built from
`EDITSY_BASE_URL` rather than the Host header when configured), the save
path (file validation against content globs, path traversal, the disk
backend's own root containment), image upload (`/api/upload`: extension
allowlist that deliberately excludes SVG, magic-byte checks, name
sanitization, size cap, never-overwrite writes), and the GitHub backend
(token handling, commit scope).

Known, accepted limitations rather than open reports:

- Login rate limiting is in-memory per server instance. On serverless hosts
  that scale to multiple concurrent instances, the effective limit is
  higher than the configured one. It's meant to blunt casual brute force,
  not to be the only defense on a high-traffic public deployment.
- The rate limiter's client key prefers the last `X-Forwarded-For` hop
  (the one a trusted edge/proxy appends) over the first (fully
  client-controlled), but this is a heuristic: hosts that don't append a
  trustworthy hop, or put it somewhere else, can still be spoofed.
- The rate limiter's memory is hard-capped; past the cap it evicts
  oldest-tracked keys, so a sustained unique-key spray can cycle its own
  key out. Bounded memory beats a perfect count here; see the previous
  two points.
- Magic-link tokens are stateless (signed, 15-minute expiry) and are NOT
  single-use within that window. Making them single-use needs shared
  storage editsy deliberately doesn't have, and would also let corporate
  mail scanners that prefetch links burn them before the editor clicks.
- Session revocation is per-editor, not per-session. Changing an editor's
  password (or removing them) kills all their sessions at once; there is
  no way to revoke one device's session and keep another's, and no "log
  out everywhere" short of a credential change. Rotating `EDITSY_SECRET`
  still revokes everything for everyone.
- When no `EDITSY_BASE_URL` (or absolute `siteUrl`) is configured,
  magic-link emails fall back to building their URL from the request,
  whose host is the Host header. Hosts that pin that header (Vercel,
  Netlify) are fine; behind a proxy that doesn't, a forged header could
  redirect a login link. `editsy doctor` warns about exactly this.
- `/api/request-link` may answer faster for unknown emails than for known
  ones (the SMTP send is synchronous), so response timing can leak whether
  an address is an editor. The per-client rate limit (5 requests / 15 min)
  keeps enumeration impractically slow.
- `f.html()` fields are rendered exactly as saved, with no sanitization.
  This is by design (see the field's doc comment), not a bug to report.

Out of scope: the local `editsy edit` server binds to 127.0.0.1 without
auth by design; reports that require an attacker already running code on
the same machine aren't treated as vulnerabilities.

Supported version: the latest published release. Pre-1.0, fixes ship as the
next patch release rather than backports.
