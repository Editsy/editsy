import { describe, expect, it } from "vitest";
import { readContent } from "../src/ast/read.js";
import { applyValues } from "../src/ast/write.js";
import { toValues, type CollectionValue, type Value } from "../src/model.js";

/** Read a file, get its editable values, mutate them, write back. */
function roundTrip(src: string, mutate: (values: Value) => Value, file = "content/x.ts"): string {
  const { doc, issues } = readContent(file, src);
  expect(issues).toEqual([]);
  const values = mutate(toValues(doc!.root));
  return applyValues(file, src, values);
}

const HOME = `import { defineContent, f } from 'editsy';

// The homepage. Keep the hero punchy.
export default defineContent({
  hero: {
    heading: 'Old heading', // shown above the fold
    body: f.markdown('Old **body**.'),
    count: 3,
    live: false,
  },
  tags: ['a', 'b'],
});
`;

describe("applyValues", () => {
  it("is byte-identical when nothing changed", () => {
    expect(roundTrip(HOME, (v) => v)).toBe(HOME);
  });

  it("edits a string in place, preserving quotes and comments", () => {
    const out = roundTrip(HOME, (v: any) => {
      v.hero.heading = "New heading";
      return v;
    });
    expect(out).toContain("heading: 'New heading', // shown above the fold");
    expect(out).toContain("// The homepage. Keep the hero punchy.");
    expect(out).toBe(HOME.replace("'Old heading'", "'New heading'"));
  });

  it("edits inside f.* annotations without touching the wrapper", () => {
    const out = roundTrip(HOME, (v: any) => {
      v.hero.body = "New *body*.";
      return v;
    });
    expect(out).toContain("body: f.markdown('New *body*.'),");
  });

  it("edits numbers and booleans", () => {
    const out = roundTrip(HOME, (v: any) => {
      v.hero.count = 7;
      v.hero.live = true;
      return v;
    });
    expect(out).toContain("count: 7,");
    expect(out).toContain("live: true,");
  });

  it("escapes special characters in strings", () => {
    const out = roundTrip(HOME, (v: any) => {
      v.hero.heading = "It's \"quoted\"\nand multi-line";
      return v;
    });
    expect(out).toContain(`'It\\'s "quoted"\\nand multi-line'`);
    // Result must still parse as a valid content file.
    const reread = readContent("content/x.ts", out);
    expect(reread.issues).toEqual([]);
    expect((reread.doc!.root as any).fields.hero.fields.heading.value).toBe(
      "It's \"quoted\"\nand multi-line",
    );
  });

  it("round-trips an unwrapped content file (existing-site adoption)", () => {
    const plain = `// no editsy imports anywhere
export default {
  hero: { heading: "Old", live: true },
  tags: ["a"],
} as const;
`;
    const out = roundTrip(plain, (v: any) => {
      v.hero.heading = "New";
      return v;
    });
    expect(out).toBe(plain.replace('"Old"', '"New"'));
  });

  it("round-trips JSON files and emits valid JSON on structural rebuilds", () => {
    const src = `{\n  "title": "Old",\n  "tags": ["a"]\n}\n`;
    const out = roundTrip(src, (v: any) => {
      v.title = "New";
      return v;
    }, "content/site.json");
    expect(out).toBe(src.replace('"Old"', '"New"'));

    const coll = `[\n  { "title": "One", "n": 1 }\n]\n`;
    const { doc } = readContent("content/posts.json", coll);
    const values = toValues(doc!.root) as CollectionValue;
    values.items.push({ $src: 0, value: { title: "Two", n: 2 } });
    const grown = applyValues("content/posts.json", coll, values);
    expect(() => JSON.parse(grown)).not.toThrow();
    expect(JSON.parse(grown)).toHaveLength(2);
  });

  it("rewrites a string list when items are added", () => {
    const out = roundTrip(HOME, (v: any) => {
      v.tags = ["a", "b", "c"];
      return v;
    });
    expect(out).toContain("tags: ['a', 'b', 'c'],");
  });

  it("escapes control characters so the file stays valid (TS and JSON alike)", () => {
    // A paste can carry invisible control characters; they must become
    // explicit \u escapes, not raw bytes (raw C0 bytes are illegal in JSON).
    const evil = "before\u0000middle\u0007after";
    const ts = roundTrip(HOME, (v: any) => {
      v.hero.heading = evil;
      return v;
    });
    expect(ts).toContain("\\u0000");
    expect(readContent("content/x.ts", ts).issues).toEqual([]);
    expect((readContent("content/x.ts", ts).doc!.root as any).fields.hero.fields.heading.value).toBe(evil);

    const json = roundTrip(`{\n  "title": "Old"\n}\n`, (v: any) => {
      v.title = evil;
      return v;
    }, "content/site.json");
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).title).toBe(evil);
  });

  it("keeps CRLF faithful through template literals", () => {
    // Template literals normalize \r\n to \n at PARSE time, so a raw CR
    // written into backticks would silently change the value on reread.
    const src = "export default { a: `one` };\n";
    const out = applyValues("content/x.ts", src, { a: "one\r\ntwo" });
    const reread = readContent("content/x.ts", out);
    expect(reread.issues).toEqual([]);
    expect((reread.doc!.root as any).fields.a.value).toBe("one\r\ntwo");
  });

  it("edits an f.select value inside the call, options untouched", () => {
    const src = `import { defineContent, f } from "editsy";
export default defineContent({
  status: f.select("upcoming", ["upcoming", "sold out", "past"]), // keep me
});
`;
    const out = applyValues("content/e.ts", src, { status: "sold out" });
    expect(out).toBe(src.replace(`f.select("upcoming",`, `f.select("sold out",`));
  });

  it("is not confused by fields named after Object.prototype members", () => {
    // `"constructor" in values` is true for ANY JSON-parsed object via the
    // prototype chain; the writer must check own properties only, or a
    // partial save that doesn't touch such a field explodes.
    const src = `export default {\n  constructor: "keep me",\n  title: "Old",\n};\n`;
    const partial = applyValues("content/x.ts", src, { title: "New" });
    expect(partial).toContain('constructor: "keep me"');
    expect(partial).toContain('title: "New"');
    // And editing the awkwardly named field itself still works.
    const edited = applyValues("content/x.ts", src, { constructor: "changed" } as any);
    expect(edited).toContain('constructor: "changed"');
  });
});

const EVENTS = `import { defineCollection, f } from "editsy";

export default defineCollection([
  {
    title: "Skate Night", // the summer one
    poster: f.image("/posters/skate.jpg"),
    spots: 40,
  },
  {
    title: "Winter Jam",
    poster: f.image("/posters/winter.jpg"),
    spots: 25,
  },
]);
`;

function eventsValues(src: string): CollectionValue {
  const { doc } = readContent("content/events.ts", src);
  return toValues(doc!.root) as CollectionValue;
}

describe("applyValues on collections", () => {
  it("edits one item's field in place", () => {
    const v = eventsValues(EVENTS);
    (v.items[0]!.value.spots as number) = 55;
    const out = applyValues("content/events.ts", EVENTS, v);
    expect(out).toBe(EVENTS.replace("spots: 40", "spots: 55"));
  });

  it("reorders items, keeping comments and annotations with them", () => {
    const v = eventsValues(EVENTS);
    v.items.reverse();
    const out = applyValues("content/events.ts", EVENTS, v);
    expect(out.indexOf("Winter Jam")).toBeLessThan(out.indexOf("Skate Night"));
    expect(out).toContain(`title: "Skate Night", // the summer one`);
    expect(out).toContain(`f.image("/posters/winter.jpg")`);
    expect(readContent("content/events.ts", out).issues).toEqual([]);
  });

  it("duplicates an item as a template: annotations survive, values change", () => {
    const v = eventsValues(EVENTS);
    v.items.push({
      $src: 0,
      value: { title: "Future Skate", poster: "/posters/future.jpg", spots: 60 },
    });
    const out = applyValues("content/events.ts", EVENTS, v);
    expect(out).toContain(`title: "Future Skate"`);
    expect(out).toContain(`f.image("/posters/future.jpg")`);
    const reread = readContent("content/events.ts", out);
    expect(reread.issues).toEqual([]);
    expect((reread.doc!.root as any).items).toHaveLength(3);
  });

  it("deletes an item", () => {
    const v = eventsValues(EVENTS);
    v.items = [v.items[1]!];
    const out = applyValues("content/events.ts", EVENTS, v);
    expect(out).not.toContain("Skate Night");
    expect(out).toContain("Winter Jam");
    expect(readContent("content/events.ts", out).issues).toEqual([]);
  });

  it("throws a helpful error on a shape mismatch", () => {
    const v = eventsValues(EVENTS);
    (v.items[0]!.value.spots as unknown as string) = "not a number";
    expect(() => applyValues("content/events.ts", EVENTS, v)).toThrow(/expected a number/);
  });
});

describe("applyValues on named exports", () => {
  it("edits a single named export like a default export", () => {
    const src = `export const events = [\n  { title: "One" },\n];\n`;
    const v = eventsValues(src);
    (v.items[0]!.value.title as string) = "First";
    const out = applyValues("content/events.ts", src, v);
    expect(out).toBe(src.replace('"One"', '"First"'));
  });

  it("edits several exports independently, leaving untouched ones byte-identical", () => {
    const src = `import { defineContent } from "editsy";
export const hero = defineContent({ heading: "Old" }); // keep this comment
export const tagline = "Small sites.";
export default { footer: "Bye" };
`;
    const out = applyValues("content/home.ts", src, {
      hero: { heading: "New" },
      tagline: "Tiny sites.",
    });
    expect(out).toContain('heading: "New" }); // keep this comment');
    expect(out).toContain('"Tiny sites."');
    expect(out).toContain('footer: "Bye"'); // untouched export, untouched bytes
    expect(readContent("content/home.ts", out).issues).toEqual([]);
  });
});

describe("applyValues with a collection template", () => {
  const SRC = `import { defineCollection, f } from "editsy";

export default defineCollection([
  {
    title: "Skate Night",
    poster: f.image("/posters/skate.jpg"),
  },
], {
  template: {
    title: "New event", // give it a name
    poster: f.image(""),
  },
});
`;

  it("builds $template items from the template source; annotations survive", () => {
    const v = eventsValues(SRC);
    v.items.push({
      $template: true,
      value: { title: "Roll Bounce", poster: "/posters/roll.jpg" },
    });
    const out = applyValues("content/events.ts", SRC, v);
    expect(out).toContain(`title: "Roll Bounce", // give it a name`);
    expect(out).toContain(`f.image("/posters/roll.jpg")`);
    const reread = readContent("content/events.ts", out);
    expect(reread.issues).toEqual([]);
    expect((reread.doc!.root as any).items).toHaveLength(2);
    // The template itself is untouched in the options argument.
    expect(out).toContain(`template: {\n    title: "New event", // give it a name`);
  });

  it("grows an EMPTY collection from its template", () => {
    const empty = `import { defineCollection } from "editsy";\nexport default defineCollection([], {\n  template: { title: "New event" },\n});\n`;
    const out = applyValues("content/events.ts", empty, {
      $collection: true,
      items: [{ $template: true, value: { title: "First ever" } }],
    });
    expect(out).toContain(`title: "First ever"`);
    const reread = readContent("content/events.ts", out);
    expect(reread.issues).toEqual([]);
  });

  it("falls back to printing values when an item has no template at all", () => {
    const v = eventsValues(SRC);
    v.items.push({ value: { title: "From scratch", poster: "/p.jpg" } });
    const out = applyValues("content/events.ts", SRC, v);
    expect(out).toContain(`title: "From scratch"`);
    expect(readContent("content/events.ts", out).issues).toEqual([]);
  });
});
