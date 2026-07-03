import { describe, expect, it } from "vitest";
import { readContent } from "../src/ast/read.js";
import type { CollectionField, ObjectField, StringField } from "../src/model.js";

const HOME = `import { defineContent, f } from "editsy";

export default defineContent({
  hero: {
    heading: "We put the world's leading lighting brands to work.",
    body: f.markdown("Some **markdown** here."),
    image: f.image("/photos/hero.jpg"),
    cta: { label: "See the work", href: f.url("/work") },
  },
  stats: { projects: 42, featured: true },
  tags: ["lighting", "design"],
});
`;

describe("readContent", () => {
  it("infers fields from a defineContent object", () => {
    const { doc, issues } = readContent("content/home.ts", HOME);
    expect(issues).toEqual([]);
    expect(doc?.type).toBe("content");
    const root = doc!.root as ObjectField;
    const hero = root.fields.hero as ObjectField;

    expect(hero.fields.heading).toMatchObject({ kind: "text", annotated: false });
    expect(hero.fields.body).toMatchObject({ kind: "markdown", annotated: true, value: "Some **markdown** here." });
    expect(hero.fields.image).toMatchObject({ kind: "image", value: "/photos/hero.jpg" });
    expect((hero.fields.cta as ObjectField).fields.href).toMatchObject({ kind: "url", value: "/work" });

    const stats = root.fields.stats as ObjectField;
    expect(stats.fields.projects).toMatchObject({ kind: "number", value: 42 });
    expect(stats.fields.featured).toMatchObject({ kind: "boolean", value: true });
    expect(root.fields.tags).toMatchObject({ kind: "list", items: ["lighting", "design"] });
  });

  it("infers textarea for long or multi-line strings", () => {
    const long = "x".repeat(140);
    const src = `import { defineContent } from "editsy";
export default defineContent({ a: "${long}", b: "short", c: \`line one
line two\` });
`;
    const { doc } = readContent("content/t.ts", src);
    const root = doc!.root as ObjectField;
    expect((root.fields.a as StringField).kind).toBe("textarea");
    expect((root.fields.b as StringField).kind).toBe("text");
    expect((root.fields.c as StringField).kind).toBe("textarea");
  });

  it("infers date fields from ISO strings and accepts f.date", () => {
    const src = `import { defineContent, f } from "editsy";
export default defineContent({ when: "2026-10-09", explicit: f.date("2026-12-12"), notDate: "2026-10-09 7pm" });
`;
    const { doc, issues } = readContent("content/d.ts", src);
    expect(issues).toEqual([]);
    const root = doc!.root as ObjectField;
    expect(root.fields.when).toMatchObject({ kind: "date", value: "2026-10-09", annotated: false });
    expect(root.fields.explicit).toMatchObject({ kind: "date", annotated: true });
    expect((root.fields.notDate as StringField).kind).toBe("text");
  });

  it("reads defineCollection into a collection doc", () => {
    const src = `import { defineCollection } from "editsy";
export default defineCollection([
  { title: "Skate Night", date: "2026-08-01" },
  { title: "Winter Jam", date: "2026-12-12" },
]);
`;
    const { doc, issues } = readContent("content/events.ts", src);
    expect(issues).toEqual([]);
    expect(doc?.type).toBe("collection");
    const root = doc!.root as CollectionField;
    expect(root.items).toHaveLength(2);
    expect(root.items[1]!.fields.title).toMatchObject({ value: "Winter Jam" });
  });

  it("accepts a plain object default export (no wrapper needed)", () => {
    const { doc, issues } = readContent(
      "content/x.ts",
      `export default { heading: "Hi", count: 2 };\n`,
    );
    expect(issues).toEqual([]);
    expect(doc?.type).toBe("content");
    expect((doc!.root as ObjectField).fields.heading).toMatchObject({ value: "Hi" });
  });

  it("accepts a plain array default export as a collection", () => {
    const { doc, issues } = readContent(
      "content/items.ts",
      `export default [{ title: "One" }, { title: "Two" }];\n`,
    );
    expect(issues).toEqual([]);
    expect(doc?.type).toBe("collection");
    expect((doc!.root as CollectionField).items).toHaveLength(2);
  });

  it("sees through `as const` and `satisfies`", () => {
    const asConst = readContent("content/a.ts", `export default { a: "x" } as const;\n`);
    expect(asConst.issues).toEqual([]);
    expect(asConst.doc?.type).toBe("content");
    const sat = readContent(
      "content/b.ts",
      `type T = { a: string };\nexport default { a: "x" } satisfies T;\n`,
    );
    expect(sat.issues).toEqual([]);
    expect(sat.doc?.type).toBe("content");
  });

  it("reads JSON content files (object and collection)", () => {
    const obj = readContent("content/site.json", `{\n  "title": "Hi",\n  "count": 3\n}\n`);
    expect(obj.issues).toEqual([]);
    expect(obj.doc?.type).toBe("content");
    expect((obj.doc!.root as ObjectField).fields.title).toMatchObject({ value: "Hi" });
    const arr = readContent("content/posts.json", `[{ "title": "One" }, { "title": "Two" }]\n`);
    expect(arr.doc?.type).toBe("collection");
    expect((arr.doc!.root as CollectionField).items).toHaveLength(2);
  });

  it("still flags a default export that isn't content-shaped", () => {
    const { doc, issues } = readContent("content/x.ts", `export default 42;\n`);
    expect(doc).toBeUndefined();
    expect(issues[0]!.message).toContain("object literal");
  });

  it("flags functions, spreads, and mixed arrays", () => {
    const src = `import { defineContent } from "editsy";
const shared = { a: 1 };
export default defineContent({
  bad1: () => "no",
  ...shared,
  bad2: [1, "mixed"],
});
`;
    const { issues } = readContent("content/bad.ts", src);
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toContain("plain literals");
    expect(messages).toContain("spreads");
    expect(messages).toContain("not mixed");
  });
});

describe("named exports", () => {
  it("reads a single named export exactly like a default export", () => {
    const { doc, issues } = readContent(
      "content/events.ts",
      `export const events = [\n  { title: "One" },\n];\n`,
    );
    expect(issues).toEqual([]);
    expect(doc?.type).toBe("collection");
    expect(doc?.exports).toBeUndefined();
    expect((doc!.root as CollectionField).items).toHaveLength(1);
  });

  it("wraps several exports into an object doc keyed by export name", () => {
    const src = `import { defineContent, defineCollection } from "editsy";
export const hero = defineContent({ heading: "Hi" });
export const faq = defineCollection([{ q: "Why?", a: "Because." }]);
export default { footer: "Bye" };
`;
    const { doc, issues } = readContent("content/home.ts", src);
    expect(issues).toEqual([]);
    expect(doc?.exports).toEqual(["hero", "faq", "default"]);
    const root = doc!.root as ObjectField;
    expect((root.fields.hero as ObjectField).fields.heading).toMatchObject({ value: "Hi" });
    expect((root.fields.faq as CollectionField).items).toHaveLength(1);
    expect((root.fields.default as ObjectField).fields.footer).toMatchObject({ value: "Bye" });
  });

  it("treats a named scalar or string-list export as an editable field", () => {
    const src = `export const tagline = "Small sites, kept simple.";\nexport const tags = ["a", "b"];\n`;
    const { doc, issues } = readContent("content/misc.ts", src);
    expect(issues).toEqual([]);
    expect(doc?.exports).toEqual(["tagline", "tags"]);
    const root = doc!.root as ObjectField;
    expect(root.fields.tagline).toMatchObject({ kind: "text", value: "Small sites, kept simple." });
    expect(root.fields.tags).toMatchObject({ kind: "list", items: ["a", "b"] });
  });

  it("silently skips named exports that clearly aren't content", () => {
    const src = `export const fmt = (d: string) => d.toUpperCase();
export const content = { heading: "Hi" };
`;
    const { doc, issues } = readContent("content/mixed.ts", src);
    expect(issues).toEqual([]);
    expect(doc?.exports).toBeUndefined(); // one editable export → direct root
    expect((doc!.root as ObjectField).fields.heading).toMatchObject({ value: "Hi" });
  });
});

describe("f.select", () => {
  it("parses the value and its options", () => {
    const src = `import { defineContent, f } from "editsy";
export default defineContent({ status: f.select("upcoming", ["upcoming", "sold out", "past"]) });
`;
    const { doc, issues } = readContent("content/e.ts", src);
    expect(issues).toEqual([]);
    expect((doc!.root as ObjectField).fields.status).toMatchObject({
      kind: "select",
      value: "upcoming",
      options: ["upcoming", "sold out", "past"],
      annotated: true,
    });
  });

  it("flags a missing options list and a value outside the options", () => {
    const noOptions = readContent(
      "content/e.ts",
      `import { f } from "editsy";\nexport default { s: f.select("a") };\n`,
    );
    expect(noOptions.issues.map((i) => i.message).join()).toContain("needs its options");

    const stray = readContent(
      "content/e.ts",
      `import { f } from "editsy";\nexport default { s: f.select("x", ["a", "b"]) };\n`,
    );
    expect(stray.issues.map((i) => i.message).join()).toContain(`isn't one of its options`);
  });
});

describe("defineCollection template", () => {
  it("reads the template shape (with defaults) alongside the items", () => {
    const src = `import { defineCollection, f } from "editsy";
export default defineCollection([], {
  template: { title: "New event", date: f.date("2026-01-01") },
});
`;
    const { doc, issues } = readContent("content/events.ts", src);
    expect(issues).toEqual([]);
    const root = doc!.root as CollectionField;
    expect(root.items).toEqual([]);
    expect(root.template!.fields.title).toMatchObject({ kind: "text", value: "New event" });
    expect(root.template!.fields.date).toMatchObject({ kind: "date", annotated: true });
  });

  it("flags a malformed options argument instead of guessing", () => {
    const { issues } = readContent(
      "content/e.ts",
      `import { defineCollection } from "editsy";\nexport default defineCollection([], 42 as never);\n`,
    );
    expect(issues.map((i) => i.message).join("\n")).toContain("second argument");
  });
});
