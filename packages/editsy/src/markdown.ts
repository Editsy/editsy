/**
 * A deliberately small markdown → HTML renderer, shared by the editor's
 * WYSIWYG surface and sites rendering f.markdown() fields (via
 * `editsy/react`). It covers what short-form site copy actually uses:
 * headings, bold, italic, inline code, links, bullet/numbered lists,
 * paragraphs, line breaks.
 *
 * Safety first: everything is HTML-escaped before any markdown transform,
 * and link hrefs are restricted to http(s), mailto, and site-relative
 * paths. Raw HTML in the source renders as visible text, never as markup.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[/#.]/.test(trimmed)) return trimmed;
  return null;
}

function inline(s: string): string {
  return (
    s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/~~([^~]+)~~/g, "<s>$1</s>")
      // Underline has no markdown syntax; a bare <u> tag (already escaped
      // above) is the one piece of inline HTML editsy allows through.
      .replace(/&lt;u&gt;/g, "<u>")
      .replace(/&lt;\/u&gt;/g, "</u>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
        const safe = safeHref(href);
        return safe ? `<a href="${safe}">${text}</a>` : text;
      })
  );
}

// Placeholder delimiter for extracted code fences: NUL can't appear in
// legitimate content and survives String.trim().
const TOKEN = String.fromCharCode(0);

export function markdownToHtml(source: string): string {
  // Pull fenced code blocks out first; they may contain blank lines and
  // must never be treated as markdown.
  const fences: string[] = [];
  const withTokens = source.replace(/\r\n/g, "\n").replace(/```\w*\n([\s\S]*?)```/g, (_m, code: string) => {
    fences.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return TOKEN + (fences.length - 1) + TOKEN;
  });

  const blocks = escapeHtml(withTokens).split(/\n{2,}/);
  return blocks
    .filter((b) => b.trim())
    .map((block) => {
      const trimmed = block.trim();
      if (trimmed.startsWith(TOKEN) && trimmed.endsWith(TOKEN)) {
        // Only accept placeholders WE created. Source text can technically
        // contain a literal NUL (a paste, a hostile value), and a forged
        // token must degrade to nothing rather than "undefined".
        const inner = trimmed.slice(1, -1);
        if (/^\d+$/.test(inner) && fences[Number(inner)] !== undefined) {
          return fences[Number(inner)]!;
        }
        return "";
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(block.trim());
      if (heading) {
        const level = heading[1]!.length;
        return `<h${level}>${inline(heading[2]!)}</h${level}>`;
      }
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*&gt;\s?/.test(l))) {
        const innerText = lines.map((l) => l.replace(/^\s*&gt;\s?/, "")).join("<br/>");
        return `<blockquote><p>${inline(innerText)}</p></blockquote>`;
      }
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
        return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
      }
      return `<p>${lines.map(inline).join("<br/>")}</p>`;
    })
    .join("");
}
