import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authFromEnv,
  checkLogin,
  createLoginToken,
  createSession,
  hashPassword,
  loadEditorsFile,
  verifyLoginToken,
  verifyPassword,
  verifySession,
  type AuthConfig,
} from "../src/auth.js";
import { RateLimiter, clientKey } from "../src/rate-limit.js";

const AUTH: AuthConfig = {
  secret: "test-secret-please-rotate",
  editors: [{ name: "Amy", email: "amy@example.com", password: "hunter2!" }],
};

describe("sessions", () => {
  it("round-trips a signed session", () => {
    const token = createSession({ name: "Amy", email: "amy@example.com" }, AUTH);
    expect(verifySession(token, AUTH)).toEqual({ name: "Amy", email: "amy@example.com" });
  });

  it("rejects tampered tokens and wrong secrets", () => {
    const token = createSession({ name: "Amy", email: "amy@example.com" }, AUTH);
    expect(verifySession(token + "x", AUTH)).toBeNull();
    expect(verifySession(token.replace(/^./, "Z"), AUTH)).toBeNull();
    expect(verifySession(token, { ...AUTH, secret: "other" })).toBeNull();
    expect(verifySession(undefined, AUTH)).toBeNull();
  });

  it("rejects expired sessions", () => {
    const token = createSession({ name: "Amy", email: "amy@example.com" }, { ...AUTH, maxAgeSeconds: -10 });
    expect(verifySession(token, AUTH)).toBeNull();
  });

  it("dies when the editor's password changes", () => {
    const token = createSession({ name: "Amy", email: "amy@example.com" }, AUTH);
    const rotated: AuthConfig = {
      ...AUTH,
      editors: [{ name: "Amy", email: "amy@example.com", password: "new-password" }],
    };
    expect(verifySession(token, rotated)).toBeNull();
  });

  it("dies when the editor is removed from the list", () => {
    const token = createSession({ name: "Amy", email: "amy@example.com" }, AUTH);
    expect(verifySession(token, { ...AUTH, editors: [] })).toBeNull();
  });

  it("does not leak across editors sharing a server (per-editor keys)", () => {
    const two: AuthConfig = {
      ...AUTH,
      editors: [...AUTH.editors, { name: "Bob", email: "bob@example.com", password: "hunter2!" }],
    };
    const token = createSession({ name: "Amy", email: "amy@example.com" }, two);
    // A payload swapped to Bob's email must not verify with Amy's signature.
    const [payload] = token.split(".");
    const swapped = Buffer.from(payload!, "base64url").toString("utf8").replace(/amy@/g, "bob@");
    const forged = `${Buffer.from(swapped, "utf8").toString("base64url")}.${token.split(".")[1]}`;
    expect(verifySession(forged, two)).toBeNull();
  });

  it("reflects a rename immediately; the name comes from the list, not the token", () => {
    const token = createSession({ name: "Amy", email: "amy@example.com" }, AUTH);
    const renamed: AuthConfig = {
      ...AUTH,
      editors: [{ name: "Amy Q.", email: "amy@example.com", password: "hunter2!" }],
    };
    expect(verifySession(token, renamed)).toEqual({ name: "Amy Q.", email: "amy@example.com" });
  });
});

describe("login", () => {
  it("accepts the right password, case-insensitive email", async () => {
    expect(await checkLogin("AMY@example.com", "hunter2!", AUTH)).toEqual({
      name: "Amy",
      email: "amy@example.com",
    });
  });

  it("rejects wrong credentials", async () => {
    expect(await checkLogin("amy@example.com", "wrong", AUTH)).toBeNull();
    expect(await checkLogin("bob@example.com", "hunter2!", AUTH)).toBeNull();
  });
});

describe("password hashing", () => {
  it("round-trips and rejects wrong passwords", async () => {
    const hash = hashPassword("skate2026!");
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword("skate2026!", hash)).toBe(true);
    expect(await verifyPassword("skate2027!", hash)).toBe(false);
    expect(await verifyPassword("skate2026!", "garbage")).toBe(false);
  });

  it("new hashes carry their cost parameters", () => {
    // scrypt$N$r$p$salt$hash; the cost can be raised later without
    // invalidating anyone's password, because each hash names its own.
    expect(hashPassword("pw")).toMatch(/^scrypt\$131072\$8\$1\$[\w-]+\$[\w-]+$/);
  });

  it("verifies hashes from the early parameterless format", async () => {
    // scrypt$salt$hash written by 0.0.10 and before (Node's N=16384 defaults).
    // "pw" hashed with a fixed salt, generated with scryptSync(…, {defaults}).
    const legacy = "scrypt$AAAAAAAAAAAAAAAAAAAAAA$v7dCKJJTWcwDJCNIBH_UNscvxo7L97fhqLlMFPlvIaE";
    expect(await verifyPassword("pw", legacy)).toBe(true);
    expect(await verifyPassword("nope", legacy)).toBe(false);
  });

  it("refuses hashes demanding absurd costs (hostile editors file)", async () => {
    const salt = "AAAAAAAAAAAAAAAAAAAAAA";
    expect(await verifyPassword("pw", `scrypt$268435456$8$1$${salt}$${salt}`)).toBe(false); // ~256 GiB
    expect(await verifyPassword("pw", `scrypt$16384$999$1$${salt}$${salt}`)).toBe(false); // ~2 GiB
    expect(await verifyPassword("pw", `scrypt$131073$8$1$${salt}$${salt}`)).toBe(false); // not a power of 2
    expect(await verifyPassword("pw", `scrypt$not$a$number$${salt}$${salt}`)).toBe(false);
  });

  it("checkLogin accepts passwordHash editors", async () => {
    const auth: AuthConfig = {
      secret: "s",
      editors: [{ name: "Amy", email: "amy@example.com", passwordHash: hashPassword("pw") }],
    };
    expect(await checkLogin("amy@example.com", "pw", auth)).toEqual({ name: "Amy", email: "amy@example.com" });
    expect(await checkLogin("amy@example.com", "nope", auth)).toBeNull();
  });

  it("rejects login for magic-link-only editors (no password set)", async () => {
    const auth: AuthConfig = { secret: "s", editors: [{ name: "Amy", email: "amy@example.com" }] };
    expect(await checkLogin("amy@example.com", "", auth)).toBeNull();
    expect(await checkLogin("amy@example.com", "anything", auth)).toBeNull();
  });
});

describe("magic-link tokens", () => {
  it("round-trips for a known editor", () => {
    const token = createLoginToken("amy@example.com", AUTH);
    expect(verifyLoginToken(token, AUTH)).toEqual({ name: "Amy", email: "amy@example.com" });
  });

  it("is not accepted as a session cookie (and vice versa)", () => {
    const magic = createLoginToken("amy@example.com", AUTH);
    expect(verifySession(magic, AUTH)).toBeNull();
    const session = createSession({ name: "Amy", email: "amy@example.com" }, AUTH);
    expect(verifyLoginToken(session, AUTH)).toBeNull();
  });

  it("rejects a link whose editor has since been removed", () => {
    const token = createLoginToken("amy@example.com", AUTH);
    expect(verifyLoginToken(token, { ...AUTH, editors: [] })).toBeNull();
  });

  it("refuses to mint tokens for unknown editors", () => {
    expect(() => createLoginToken("stranger@example.com", AUTH)).toThrow(/unknown editor/);
  });
});

describe("rate limiter", () => {
  it("allows up to the limit, then refuses within the window", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(false);
    expect(limiter.allow("other")).toBe(true);
  });

  it("caps memory when an attacker sprays unique keys inside one window", () => {
    const limiter = new RateLimiter(3, 60_000);
    for (let i = 0; i < 200_000; i++) limiter.allow(`spray-${i}`);
    // Every key is fresh (inside the window), so stale cleanup can't help;
    // only the hard cap keeps the map bounded (cap + one sweep stride).
    const hits = (limiter as unknown as { hits: Map<string, number[]> }).hits;
    expect(hits.size).toBeLessThanOrEqual(51_000);
  });
});

describe("clientKey", () => {
  it("uses the LAST X-Forwarded-For hop, not the first", () => {
    // The last hop is what a trusted edge/proxy appended; the first hop is
    // whatever the original request claimed and is fully attacker-controlled
    // on a direct request. Keying on the first hop would let an attacker
    // bypass rate limiting by sending a new made-up value every time.
    const req = new Request("http://x", { headers: { "x-forwarded-for": "attacker-supplied, 10.0.0.1, 1.2.3.4" } });
    expect(clientKey(req)).toBe("1.2.3.4");
  });

  it("falls back to a constant with no header", () => {
    expect(clientKey(new Request("http://x"))).toBe("direct");
  });
});

describe("loadEditorsFile", () => {
  it("loads an editsy.editors.json with hashed passwords", async () => {
    const dir = await mkdtemp(join(tmpdir(), "editsy-editors-"));
    try {
      await writeFile(
        join(dir, "editsy.editors.json"),
        JSON.stringify([{ name: "Amy", email: "amy@example.com", passwordHash: hashPassword("pw") }]),
      );
      const editors = await loadEditorsFile(dir);
      expect(editors?.[0]?.name).toBe("Amy");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a committed plaintext password (this file is meant to be committed)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "editsy-editors-"));
    try {
      await writeFile(
        join(dir, "editsy.editors.json"),
        JSON.stringify([{ name: "Amy", email: "amy@example.com", password: "oops-plaintext" }]),
      );
      await expect(loadEditorsFile(dir)).rejects.toThrow(/plaintext/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when there's no editors file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "editsy-editors-"));
    try {
      expect(await loadEditorsFile(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("authFromEnv", () => {
  it("returns undefined when unset and parses when set", () => {
    expect(authFromEnv({})).toBeUndefined();
    const parsed = authFromEnv({
      EDITSY_SECRET: "s",
      EDITSY_EDITORS: JSON.stringify(AUTH.editors),
    });
    expect(parsed?.editors[0]?.name).toBe("Amy");
  });

  it("throws on malformed editor JSON", () => {
    expect(() => authFromEnv({ EDITSY_SECRET: "s", EDITSY_EDITORS: "nope" })).toThrow(/JSON/);
    expect(() =>
      authFromEnv({ EDITSY_SECRET: "s", EDITSY_EDITORS: JSON.stringify([{ name: "x" }]) }),
    ).toThrow(/need at least name and email/);
  });

  it("gives a specific error for a bare editor object instead of an array", () => {
    // The exact mistake it's easy to make pasting hash-password's output:
    // forgetting to wrap the single-editor object in [ ].
    expect(() =>
      authFromEnv({
        EDITSY_SECRET: "s",
        EDITSY_EDITORS: JSON.stringify({ name: "Amy", email: "amy@example.com", passwordHash: "x" }),
      }),
    ).toThrow(/must be a JSON ARRAY/);
  });

  it("merges file editors under env editors, env winning on duplicates", () => {
    const auth = authFromEnv(
      { EDITSY_SECRET: "s", EDITSY_EDITORS: JSON.stringify([{ name: "Env Amy", email: "amy@example.com" }]) },
      [
        { name: "File Amy", email: "amy@example.com" },
        { name: "Bob", email: "bob@example.com" },
      ],
    );
    expect(auth?.editors.map((e) => e.name)).toEqual(["Env Amy", "Bob"]);
  });
});
