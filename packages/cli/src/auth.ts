/**
 * Editor auth for remote mode (D8): password login for a configured list of
 * editors, session in a signed HttpOnly cookie. No database; the editor
 * list and signing secret come from options/env. Local `editsy edit` runs
 * with auth disabled (the server never leaves localhost).
 */
import { createHmac, createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

export interface Editor {
  name: string;
  email: string;
  /** Plaintext password: fine for dev, use passwordHash for anything deployed. */
  password?: string;
  /** scrypt hash produced by `editsy hash-password`. Safe to commit (like .htpasswd). */
  passwordHash?: string;
  /** Omit both password fields for a magic-link-only editor. */
}

export interface AuthConfig {
  editors: Editor[];
  /** HMAC signing secret for session cookies. Long and random. */
  secret: string;
  /** Session lifetime in seconds. Default 14 days. */
  maxAgeSeconds?: number;
}

export interface SessionUser {
  name: string;
  email: string;
}

const COOKIE_NAME = "editsy_session";
const DEFAULT_MAX_AGE = 14 * 24 * 60 * 60;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

/** Constant-time string comparison (hash first so lengths never differ). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Per-editor signing key: the global secret mixed with the editor's email
 * and current credential. Tokens signed with it die the moment the editor
 * is removed from the list or their password changes: stateless
 * revocation, no session store needed. NUL separators keep a crafted
 * email from colliding with another editor's email+credential string.
 */
function editorKey(editor: Editor, secret: string): string {
  const credential = editor.passwordHash ?? editor.password ?? "";
  return createHmac("sha256", secret)
    .update(`editsy-editor-key\0${editor.email.toLowerCase()}\0${credential}`)
    .digest("base64url");
}

/** Signed-token core: `t` separates token kinds so one can never stand in for another. */
function createToken(data: Record<string, unknown>, expSeconds: number, key: string): string {
  const exp = Math.floor(Date.now() / 1000) + expSeconds;
  const payload = b64url(Buffer.from(JSON.stringify({ ...data, exp }), "utf8"));
  return `${payload}.${sign(payload, key)}`;
}

/**
 * Verify a token bound to an editor. The payload is decoded FIRST (it's
 * attacker-supplied JSON either way) to learn which editor's key should
 * have signed it; the signature check then uses that key, so a token only
 * verifies while its editor exists with an unchanged credential. Name and
 * email come from the current editors list, not the token, so a rename
 * shows up on the next request.
 */
function verifyEditorToken(token: string | undefined, kind: string, auth: AuthConfig): SessionUser | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  let data: { t?: unknown; exp?: unknown; email?: unknown };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof data;
  } catch {
    return null;
  }
  if (typeof data.email !== "string") return null;
  const editor = findEditor(data.email, auth);
  if (!editor) return null;
  if (!safeEqual(token.slice(dot + 1), sign(payload, editorKey(editor, auth.secret)))) return null;
  if (data.t !== kind) return null;
  if (typeof data.exp !== "number" || data.exp * 1000 < Date.now()) return null;
  return { name: editor.name, email: editor.email };
}

export function createSession(user: SessionUser, auth: AuthConfig): string {
  const editor = findEditor(user.email, auth);
  if (!editor) throw new Error(`can't create a session for an unknown editor: ${user.email}`);
  return createToken(
    { t: "session", email: editor.email },
    auth.maxAgeSeconds ?? DEFAULT_MAX_AGE,
    editorKey(editor, auth.secret),
  );
}

export function verifySession(token: string | undefined, auth: AuthConfig): SessionUser | null {
  return verifyEditorToken(token, "session", auth);
}

/** Short-lived token embedded in a magic-link email. Not usable as a session cookie. */
export function createLoginToken(email: string, auth: AuthConfig): string {
  const editor = findEditor(email, auth);
  if (!editor) throw new Error(`can't create a login token for an unknown editor: ${email}`);
  return createToken({ t: "magic", email: editor.email }, LOGIN_TOKEN_SECONDS, editorKey(editor, auth.secret));
}

export function verifyLoginToken(token: string | undefined, auth: AuthConfig): SessionUser | null {
  return verifyEditorToken(token, "magic", auth);
}

const LOGIN_TOKEN_SECONDS = 15 * 60;

// ---------------------------------------------------------------------------
// Passwords: scrypt hashes (node built-in, no dependency). Format:
//   scrypt$<N>$<r>$<p>$<saltB64url>$<hashB64url>
// The cost parameters travel WITH the hash so they can be raised later
// without invalidating anyone's password. Hashes from the parameterless
// early format (scrypt$<salt>$<hash>, Node's N=16384 defaults) still verify.
// ---------------------------------------------------------------------------

const SCRYPT_PREFIX = "scrypt$";
/** Current cost for NEW hashes (OWASP's scrypt recommendation): N=2^17, r=8, p=1. */
const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1 };
/** What the early parameterless format used (Node's defaults). */
const SCRYPT_LEGACY_PARAMS = { N: 16384, r: 8, p: 1 };

/** scrypt needs 128·N·r bytes; Node's default 32 MiB cap is below N=2^17's need. */
function maxmemFor(params: { N: number; r: number }): number {
  return 128 * params.N * params.r * 2;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const { N, r, p } = SCRYPT_PARAMS;
  const hash = scryptSync(password, salt, 32, { N, r, p, maxmem: maxmemFor(SCRYPT_PARAMS) });
  return `${SCRYPT_PREFIX}${N}$${r}$${p}$${b64url(salt)}$${b64url(hash)}`;
}

function parseStoredHash(
  stored: string,
): { salt: Buffer; expected: Buffer; N: number; r: number; p: number } | null {
  if (!stored.startsWith(SCRYPT_PREFIX)) return null;
  const parts = stored.slice(SCRYPT_PREFIX.length).split("$");
  if (parts.length === 2) {
    // Early parameterless format.
    return {
      salt: Buffer.from(parts[0]!, "base64url"),
      expected: Buffer.from(parts[1]!, "base64url"),
      ...SCRYPT_LEGACY_PARAMS,
    };
  }
  if (parts.length !== 5) return null;
  const [N, r, p] = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  // Sanity-bound the cost so a hostile "hash" can't demand gigabytes:
  // scrypt wants 128·N·r bytes, so cap that product at 256 MiB (2× the
  // current default's need) alongside the individual parameter bounds.
  if (![N, r, p].every(Number.isInteger) || N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1 || p > 16) {
    return null;
  }
  if (128 * N * r > 256 * 1024 * 1024) return null;
  return { salt: Buffer.from(parts[3]!, "base64url"), expected: Buffer.from(parts[4]!, "base64url"), N, r, p };
}

/** Async on purpose: scrypt at these costs takes ~100 ms and must not block the event loop. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const { salt, expected, N, r, p } = parsed;
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, expected.length, { N, r, p, maxmem: maxmemFor({ N, r }) }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function findEditor(email: string, auth: AuthConfig): Editor | undefined {
  return auth.editors.find((e) => e.email.toLowerCase() === email.toLowerCase());
}

export async function checkLogin(email: string, password: string, auth: AuthConfig): Promise<SessionUser | null> {
  // Burn comparable time whether or not the email matches, to keep timing flat.
  const editor = findEditor(email, auth);
  const stored = editor?.passwordHash ?? editor?.password;
  let ok: boolean;
  if (!editor || stored === undefined) {
    await verifyPassword(password, dummyHash());
    ok = false;
  } else if (editor.passwordHash) {
    ok = await verifyPassword(password, editor.passwordHash);
  } else {
    await verifyPassword(password, dummyHash()); // keep hash cost in the plaintext path too
    ok = safeEqual(password, stored);
  }
  return ok && editor ? { name: editor.name, email: editor.email } : null;
}

// Lazy: hashing at current cost takes ~100 ms, which belongs on the first
// login attempt, not on module load (serverless cold starts import this).
let dummy: string | undefined;
function dummyHash(): string {
  return (dummy ??= hashPassword("editsy-dummy"));
}

/**
 * Over HTTPS the cookie gets the `__Host-` prefix: the browser then refuses
 * to accept it from a non-secure connection, from a subdomain, or with a
 * narrowed Path, locking the session to exactly this origin. Plain HTTP
 * (local dev behind auth) keeps the unprefixed name, since browsers reject
 * `__Host-` cookies outright there.
 */
function cookieName(secure: boolean): string {
  return secure ? `__Host-${COOKIE_NAME}` : COOKIE_NAME;
}

export function sessionFromRequest(req: Request, auth: AuthConfig): SessionUser | null {
  const cookies = req.headers.get("cookie") ?? "";
  for (const name of [`__Host-${COOKIE_NAME}`, COOKIE_NAME]) {
    const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    const user = verifySession(match?.[1], auth);
    if (user) return user;
  }
  return null;
}

export function sessionCookie(token: string, auth: AuthConfig, secure: boolean): string {
  const maxAge = auth.maxAgeSeconds ?? DEFAULT_MAX_AGE;
  return `${cookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${cookieName(secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/**
 * Read auth config from the environment and/or an editors file:
 *   EDITSY_SECRET  - signing secret (required to enable auth)
 *   EDITSY_EDITORS - JSON: [{ "name", "email", "password" | "passwordHash" }, ...]
 *   editsy.editors.json at the project root - same array shape; the
 *   .htpasswd-style option (hashed passwords are safe to commit).
 * Env and file editors are merged; env wins on duplicate emails.
 */
export function authFromEnv(
  env: Record<string, string | undefined> = process.env,
  editorsFile?: Editor[],
): AuthConfig | undefined {
  const secret = env.EDITSY_SECRET;
  if (!secret) return undefined;
  const fromEnv = env.EDITSY_EDITORS ? parseEditors(env.EDITSY_EDITORS, "EDITSY_EDITORS") : [];
  const seen = new Set(fromEnv.map((e) => e.email.toLowerCase()));
  const editors = [...fromEnv, ...(editorsFile ?? []).filter((e) => !seen.has(e.email.toLowerCase()))];
  if (editors.length === 0) return undefined;
  return { editors, secret };
}

/**
 * Load editsy.editors.json from the project root, if present.
 *
 * Unlike EDITSY_EDITORS (an env var, never committed), this file is
 * specifically meant to be checked into git; the whole point is the
 * .htpasswd pattern of hashed credentials living safely in version control.
 * A plaintext `password` here would defeat that, so it's rejected outright
 * rather than merely discouraged in a comment nobody will read under
 * deadline pressure.
 */
export async function loadEditorsFile(root: string): Promise<Editor[] | undefined> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    const raw = await readFile(join(root, "editsy.editors.json"), "utf8");
    const editors = parseEditors(raw, "editsy.editors.json");
    const plaintext = editors.filter((e) => e.password && !e.passwordHash);
    if (plaintext.length > 0) {
      throw new Error(
        `editsy.editors.json can only hold hashed passwords (this file is meant to be committed): ` +
          `${plaintext.map((e) => e.email).join(", ")} ${plaintext.length === 1 ? "has" : "have"} a plaintext ` +
          `"password" field. Run \`npx editsy hash-password <password>\` and use "passwordHash" instead.`,
      );
    }
    return editors;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function parseEditors(raw: string, source: string): Editor[] {
  let editors: Editor[];
  try {
    editors = JSON.parse(raw) as Editor[];
  } catch {
    throw new Error(`${source} must be JSON: [{"name","email","password"|"passwordHash"}, ...]`);
  }
  if (!Array.isArray(editors)) {
    throw new Error(
      `${source} must be a JSON ARRAY, even for one editor: [{"name","email","password"|"passwordHash"}]. ` +
        `Got a bare object instead; wrap it in [ ].`,
    );
  }
  if (editors.some((e) => !e.name || !e.email)) {
    throw new Error(`${source} entries need at least name and email`);
  }
  return editors;
}
