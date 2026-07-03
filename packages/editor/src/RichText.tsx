/**
 * WYSIWYG editing for f.markdown() fields. The file keeps clean markdown;
 * the editor shows formatted text. markdown → HTML via editsy's safe
 * renderer, HTML → markdown via turndown on every change. A "md" toggle
 * shows the raw source for people who like it that way.
 *
 * Underline has no markdown syntax, so it round-trips as a literal `<u>`
 * tag, the one piece of inline HTML editsy's renderer allows.
 */
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { markdownToHtml } from "editsy/markdown";
import { useRef, useState } from "react";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  codeBlockStyle: "fenced",
});
turndown.addRule("underline", {
  filter: ["u"],
  replacement: (content) => `<u>${content}</u>`,
});
turndown.addRule("strike", {
  filter: ["s", "del"],
  replacement: (content) => `~~${content}~~`,
});

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

interface RichTextProps {
  value: string;
  onChange: (value: string) => void;
  /** "markdown" (default) stores markdown; "html" stores the HTML fragment as-is. */
  mode?: "markdown" | "html";
}

type BlockStyle = "p" | "h2" | "h3" | "quote";

export function RichText({ value, onChange, mode = "markdown" }: RichTextProps) {
  const [raw, setRaw] = useState(false);
  // What we last emitted; lets us tell our own updates from external ones.
  const lastEmitted = useRef(value);
  const toSurface = (v: string) => (mode === "html" ? v : markdownToHtml(v));
  const fromSurface = (html: string) => (mode === "html" ? html : htmlToMarkdown(html));

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
      Underline,
      Link.configure({ openOnClick: false }),
    ],
    content: toSurface(value),
    onUpdate: ({ editor }) => {
      const next = fromSurface(editor.getHTML());
      lastEmitted.current = next;
      onChange(next);
    },
    editorProps: {
      attributes: { class: "richtext-surface" },
    },
  });

  // External change (discard, raw-tab edit): resync the rich editor.
  if (editor && value !== lastEmitted.current) {
    lastEmitted.current = value;
    queueMicrotask(() => editor.commands.setContent(toSurface(value), false));
  }

  const setLink = () => {
    if (!editor) return;
    const current = editor.getAttributes("link").href as string | undefined;
    const href = window.prompt("Link to (URL or /path):", current ?? "");
    if (href === null) return;
    if (href === "") {
      editor.chain().focus().unsetLink().run();
      return;
    }
    // Match what sites will actually render: the markdown renderer only
    // allows http(s), mailto, and site-relative targets. Refusing here
    // beats silently dropping the link at display time.
    if (!/^(https?:|mailto:)/i.test(href.trim()) && !/^[/#.]/.test(href.trim())) {
      window.alert("Links must be http(s), mailto, or a site path like /about.");
      return;
    }
    editor.chain().focus().setLink({ href: href.trim() }).run();
  };

  const blockStyle: BlockStyle = !editor
    ? "p"
    : editor.isActive("heading", { level: 2 })
      ? "h2"
      : editor.isActive("heading", { level: 3 })
        ? "h3"
        : editor.isActive("blockquote")
          ? "quote"
          : "p";

  const setBlockStyle = (style: BlockStyle) => {
    if (!editor) return;
    const chain = editor.chain().focus();
    if (editor.isActive("blockquote") && style !== "quote") chain.lift("blockquote");
    if (style === "p") chain.setParagraph().run();
    else if (style === "h2") chain.setHeading({ level: 2 }).run();
    else if (style === "h3") chain.setHeading({ level: 3 }).run();
    else chain.setParagraph().setBlockquote().run();
  };

  return (
    <div className="richtext">
      <div className="richtext-toolbar">
        {editor && !raw && (
          <>
            <select
              className="block-select"
              title="Style for the current paragraph"
              value={blockStyle}
              onChange={(e) => setBlockStyle(e.target.value as BlockStyle)}
            >
              <option value="p">Text</option>
              <option value="h2">Heading</option>
              <option value="h3">Subheading</option>
              <option value="quote">Quote</option>
            </select>
            <span className="toolbar-gap" />
            <ToolButton
              label="B"
              title="Bold"
              active={editor.isActive("bold")}
              onClick={() => editor.chain().focus().toggleBold().run()}
            />
            <ToolButton
              label="I"
              title="Italic"
              active={editor.isActive("italic")}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            />
            <ToolButton
              label="U"
              title="Underline"
              active={editor.isActive("underline")}
              onClick={() => editor.chain().focus().toggleUnderline().run()}
            />
            <ToolButton
              label="S"
              title="Strikethrough"
              active={editor.isActive("strike")}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            />
            <ToolButton
              label="‹›"
              title="Inline code"
              active={editor.isActive("code")}
              onClick={() => editor.chain().focus().toggleCode().run()}
            />
            <span className="toolbar-gap" />
            <ToolButton
              label="••"
              title="Bullet list"
              active={editor.isActive("bulletList")}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            />
            <ToolButton
              label="1."
              title="Numbered list"
              active={editor.isActive("orderedList")}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            />
            <ToolButton
              label="🔗"
              title="Link"
              active={editor.isActive("link")}
              onClick={setLink}
            />
          </>
        )}
        <span className="toolbar-spring" />
        <ToolButton
          label={mode === "html" ? "‹html›" : "md"}
          title={mode === "html" ? "Raw HTML view" : "Raw markdown view"}
          active={raw}
          onClick={() => setRaw(!raw)}
        />
      </div>
      {raw ? (
        <textarea
          className="richtext-raw"
          rows={Math.min(14, Math.max(4, value.split("\n").length + 1))}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <EditorContent editor={editor} />
      )}
    </div>
  );
}

function ToolButton({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      className={`tool-btn ${active ? "active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
