/** The pure parts of the live-preview hook: spec parsing and draft matching. */
import { describe, expect, it } from "vitest";
import { draftMatches, parseFileSpec } from "../src/react.js";

describe("parseFileSpec", () => {
  it("splits an export fragment off the path", () => {
    expect(parseFileSpec("content/home.ts")).toEqual({ path: "content/home.ts" });
    expect(parseFileSpec("content/home.ts#hero")).toEqual({
      path: "content/home.ts",
      exportName: "hero",
    });
    // A trailing empty fragment means "no export named".
    expect(parseFileSpec("content/home.ts#")).toEqual({ path: "content/home.ts" });
  });
});

describe("draftMatches", () => {
  it("a message without an export (single-export file) matches any hook", () => {
    expect(draftMatches(undefined, undefined)).toBe(true);
    expect(draftMatches("hero", undefined)).toBe(true);
  });

  it("a per-export message matches the hook naming that export", () => {
    expect(draftMatches("hero", "hero")).toBe(true);
    expect(draftMatches("faq", "hero")).toBe(false);
  });

  it("the default export reaches hooks with no fragment", () => {
    expect(draftMatches(undefined, "default")).toBe(true);
    expect(draftMatches(undefined, "hero")).toBe(false);
  });
});
