import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../src/markdown.js";

describe("markdownToHtml", () => {
  it("renders the short-form constructs", () => {
    const html = markdownToHtml(
      "## Hello\n\nSome **bold**, *italic*, `code`, and a [link](https://a.b).\n\n- one\n- two\n\n1. first\n2. second",
    );
    expect(html).toContain("<h2>Hello</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://a.b">link</a>');
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  });

  it("renders strike, underline tags, and blockquotes", () => {
    expect(markdownToHtml("~~gone~~ and <u>kept</u>")).toBe(
      "<p><s>gone</s> and <u>kept</u></p>",
    );
    expect(markdownToHtml("> a quote\n> second line")).toBe(
      "<blockquote><p>a quote<br/>second line</p></blockquote>",
    );
    // Only the bare <u> tag is allowed; anything with attributes stays escaped text.
    expect(markdownToHtml('<u onclick="x">nope</u>')).not.toContain("<u ");
  });

  it("escapes raw HTML instead of rendering it", () => {
    const html = markdownToHtml('<img src=x onerror=alert(1)> and <script>hi</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
  });

  it("drops javascript: and other unsafe link targets", () => {
    expect(markdownToHtml("[x](javascript:alert(1))")).not.toContain("<a");
    expect(markdownToHtml("[x](data:text/html,hi)")).not.toContain("<a");
    expect(markdownToHtml("[ok](/local)")).toContain('<a href="/local">ok</a>');
    expect(markdownToHtml("[ok](mailto:a@b.c)")).toContain('<a href="mailto:a@b.c">ok</a>');
  });

  it("renders fenced code blocks, escaping their contents", () => {
    const html = markdownToHtml('Before.\n\n```ts\nconst a = "<b>";\n\nconst b = 2;\n```\n\nAfter.');
    expect(html).toContain("<pre><code>const a = &quot;&lt;b&gt;&quot;;\n\nconst b = 2;</code></pre>");
    expect(html).toContain("<p>Before.</p>");
    expect(html).toContain("<p>After.</p>");
  });

  it("keeps single newlines as line breaks and blank lines as paragraphs", () => {
    expect(markdownToHtml("a\nb\n\nc")).toBe("<p>a<br/>b</p><p>c</p>");
  });

  it("ignores forged fence placeholders (literal NULs in the source)", () => {
    // The renderer marks extracted code fences with NUL-delimited tokens;
    // source text that fakes one must render as nothing, not "undefined".
    const NUL = String.fromCharCode(0);
    expect(markdownToHtml(`${NUL}99${NUL}`)).toBe("");
    expect(markdownToHtml(`${NUL}nonsense${NUL}`)).toBe("");
  });
});
