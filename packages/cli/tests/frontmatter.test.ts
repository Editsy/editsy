/** Markdown content files: frontmatter fields + body, read and written surgically. */
import { describe, expect, it } from "vitest";
import { readContent } from "../src/ast/read.js";
import { applyValues } from "../src/ast/write.js";
import { toValues } from "../src/model.js";

const POST = `---
title: Hello world
date: 2026-07-03
draft: false
rating: 4
subtitle: "Quotes: needed, here"
tags: [intro, news]
categories:
  - guides
  - long reads
---

The **body** with some markdown.

- a list
- inside it
`;

function fields(src: string) {
  const { doc, issues } = readContent("content/post.md", src);
  expect(issues).toEqual([]);
  return (doc!.root as { fields: Record<string, any> }).fields;
}

describe("reading markdown files", () => {
  it("infers fields from frontmatter and puts the body in a markdown field", () => {
    const f = fields(POST);
    expect(f.title).toMatchObject({ kind: "text", value: "Hello world" });
    expect(f.date).toMatchObject({ kind: "date", value: "2026-07-03" });
    expect(f.draft).toMatchObject({ kind: "boolean", value: false });
    expect(f.rating).toMatchObject({ kind: "number", value: 4 });
    expect(f.subtitle).toMatchObject({ kind: "text", value: "Quotes: needed, here" });
    expect(f.tags).toMatchObject({ kind: "list", items: ["intro", "news"] });
    expect(f.categories).toMatchObject({ kind: "list", items: ["guides", "long reads"] });
    expect(f.body).toMatchObject({ kind: "markdown", annotated: true });
    expect(f.body.value).toBe("The **body** with some markdown.\n\n- a list\n- inside it\n");
  });

  it("treats a file without frontmatter as body-only", () => {
    const f = fields("Just some **markdown**.\n");
    expect(Object.keys(f)).toEqual(["body"]);
    expect(f.body.value).toBe("Just some **markdown**.\n");
  });

  it("skips comments and blank lines; flags what it can't represent", () => {
    const src = `---
# a comment
title: Ok

nested:
  key: value
body: collides
title: duplicate
---
text
`;
    const { doc, issues } = readContent("content/x.md", src);
    const messages = issues.map((i) => i.message).join("\n");
    expect(messages).toContain("nested");
    expect(messages).toContain("reserved");
    expect(messages).toContain("duplicate");
    const f = (doc!.root as any).fields;
    expect(f.title.value).toBe("Ok");
    expect(f.body.value).toBe("text\n");
  });

  it("separates trailing comments from values, like real YAML parsers", () => {
    const src = `---
draft: false # flip before launch
url: https://a.b/page#anchor
quoted: "kept # inside" # outside
weird: "closed" trailing junk
---
body
`;
    const { doc, issues } = readContent("content/x.md", src);
    const f = (doc!.root as any).fields;
    expect(f.draft).toMatchObject({ kind: "boolean", value: false });
    // A # without preceding whitespace is part of the value (URLs!).
    expect(f.url.value).toBe("https://a.b/page#anchor");
    expect(f.quoted.value).toBe("kept # inside");
    expect(f.weird).toBeUndefined();
    expect(issues.map((i) => i.message).join()).toContain("after its quoted value");
  });

  it("refuses a file whose frontmatter never closes", () => {
    const { doc, issues } = readContent("content/x.md", "---\ntitle: Oops\n");
    expect(doc).toBeUndefined();
    expect(issues[0]!.message).toContain("never closes");
  });
});

describe("writing markdown files", () => {
  it("is byte-identical when nothing changed", () => {
    const { doc } = readContent("content/post.md", POST);
    expect(applyValues("content/post.md", POST, toValues(doc!.root))).toBe(POST);
  });

  it("edits one scalar surgically, leaving every other byte alone", () => {
    const out = applyValues("content/post.md", POST, { title: "New title" });
    expect(out).toBe(POST.replace("title: Hello world", "title: New title"));
  });

  it("quotes strings that need it, keeps dates bare, and rereads cleanly", () => {
    const out = applyValues("content/post.md", POST, {
      title: "Tricky: value",
      date: "2027-01-01",
      draft: true,
      rating: 5,
    });
    expect(out).toContain('title: "Tricky: value"');
    expect(out).toContain("date: 2027-01-01");
    expect(out).toContain("draft: true");
    expect(out).toContain("rating: 5");
    const f = fields(out);
    expect(f.title.value).toBe("Tricky: value");
  });

  it("rewrites lists in their original style", () => {
    const out = applyValues("content/post.md", POST, {
      tags: ["a", "b c"],
      categories: ["one", "two: three"],
    });
    expect(out).toContain("tags: [a, b c]");
    expect(out).toContain('categories:\n  - one\n  - "two: three"');
    const f = fields(out);
    expect(f.tags.items).toEqual(["a", "b c"]);
    expect(f.categories.items).toEqual(["one", "two: three"]);
  });

  it("replaces the body without touching the frontmatter", () => {
    const out = applyValues("content/post.md", POST, { body: "A new body.\n\nTwo paragraphs." });
    expect(out).toContain("title: Hello world");
    expect(out.endsWith("---\n\nA new body.\n\nTwo paragraphs.\n")).toBe(true);
  });

  it("keeps CRLF files CRLF", () => {
    const crlf = POST.replace(/\n/g, "\r\n");
    const out = applyValues("content/post.md", crlf, { title: "New", body: "Fresh body." });
    expect(out).toContain("title: New\r\n");
    expect(out.endsWith("---\r\n\r\nFresh body.\r\n")).toBe(true);
    expect(out).not.toMatch(/[^\r]\n/); // no stray bare-LF lines
  });

  it("ignores unknown keys and refuses type mismatches", () => {
    expect(applyValues("content/post.md", POST, { notAField: "x" })).toBe(POST);
    expect(() => applyValues("content/post.md", POST, { rating: "five" })).toThrow(/number/);
    expect(() => applyValues("content/post.md", POST, { tags: "not-a-list" })).toThrow(/list/);
  });

  it("writes a body-only file as just the body", () => {
    const out = applyValues("content/x.md", "Old text.\n", { body: "New text." });
    expect(out).toBe("New text.\n");
  });

  it("edits a value without eating its trailing comment", () => {
    const src = "---\ndraft: false # flip before launch\n---\nbody\n";
    const out = applyValues("content/x.md", src, { draft: true });
    expect(out).toBe("---\ndraft: true # flip before launch\n---\nbody\n");
  });
});
