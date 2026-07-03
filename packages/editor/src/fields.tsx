/** Recursive field editors. Components mutate the node tree in place and call `touch()`. */
import { createContext, useContext, useRef, useState } from "react";
import { api } from "./api";
import { RichText } from "./RichText";
import type { FieldNode, ObjectField, StringField } from "./types";
import { blankClone, tagSources } from "./types";

/** Assets under the public root + the site URL (for thumbnails), provided by App. */
export const AssetsContext = createContext<{
  assets: string[];
  siteUrl: string;
  /** Refetch the assets list (after an upload). */
  refreshAssets: () => void;
}>({
  assets: [],
  siteUrl: "",
  refreshAssets: () => undefined,
});

/**
 * Object URLs for images uploaded THIS session. In remote mode the site
 * won't actually serve a fresh upload until its next rebuild, so thumbnails
 * come from the local file until then.
 */
const sessionThumbs = new Map<string, string>();

/** camelCase / snake_case key → human label ("heroImage" → "Hero Image"). */
export function labelize(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface EditorProps<T extends FieldNode> {
  node: T;
  touch: () => void;
}

export function NodeEditor({ node, touch }: EditorProps<FieldNode>) {
  switch (node.kind) {
    case "text":
    case "url":
      return <StringInput node={node} touch={touch} />;
    case "date":
      return <DateInput node={node} touch={touch} />;
    case "select":
      return <SelectInput node={node} touch={touch} />;
    case "image":
      return <ImageInput node={node} touch={touch} />;
    case "textarea":
      return <TextareaInput node={node} touch={touch} />;
    case "markdown":
    case "html":
      return (
        <RichText
          mode={node.kind}
          value={node.value}
          onChange={(value) => {
            node.value = value;
            touch();
          }}
        />
      );
    case "number":
      return (
        <input
          type="number"
          value={Number.isFinite(node.value) ? node.value : 0}
          onChange={(e) => {
            node.value = Number(e.target.value);
            touch();
          }}
        />
      );
    case "boolean":
      return (
        <label className="toggle">
          <input
            type="checkbox"
            checked={node.value}
            onChange={(e) => {
              node.value = e.target.checked;
              touch();
            }}
          />
          <span>{node.value ? "yes" : "no"}</span>
        </label>
      );
    case "list":
      return <ListEditor node={node} touch={touch} />;
    case "object":
      return <ObjectEditor node={node} touch={touch} />;
    case "collection":
      return <CollectionEditor node={node} touch={touch} />;
  }
}

function StringInput({ node, touch }: EditorProps<StringField>) {
  return (
    <div className={`string-input kind-${node.kind}`}>
      {node.kind !== "text" && <span className="kind-tag">{node.kind}</span>}
      <input
        type="text"
        value={node.value}
        onChange={(e) => {
          node.value = e.target.value;
          touch();
        }}
      />
    </div>
  );
}

/** Dropdown over the options an f.select() field declares. */
function SelectInput({ node, touch }: EditorProps<StringField>) {
  const options = node.options ?? [];
  // A value outside the declared options (the file changed, or the options
  // did) stays selectable so opening the editor doesn't silently change it.
  const stray = node.value !== "" && !options.includes(node.value);
  return (
    <div className="string-input kind-select">
      <select
        className="field-select"
        value={node.value}
        onChange={(e) => {
          node.value = e.target.value;
          touch();
        }}
      >
        {stray && <option value={node.value}>{node.value} (not in the options)</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Date picker for ISO "YYYY-MM-DD" values (inferred or via f.date). */
function DateInput({ node, touch }: EditorProps<StringField>) {
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(node.value) || node.value === "";
  return (
    <div className="string-input kind-date">
      <span className="kind-tag">date</span>
      <div className="date-row">
        <input
          type="date"
          value={valid ? node.value : ""}
          onChange={(e) => {
            node.value = e.target.value;
            touch();
          }}
        />
        {!valid && <span className="date-note">was: “{node.value}”; pick a date to replace it</span>}
      </div>
    </div>
  );
}

/** Image picker (D4): choose from assets (with a thumbnail) or upload a new one. */
function ImageInput({ node, touch }: EditorProps<StringField>) {
  const { siteUrl, refreshAssets } = useContext(AssetsContext);
  const [thumbOk, setThumbOk] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onFile = async (file: File) => {
    setUploading(true);
    setNote(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("couldn't read the file"));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const { path } = await api.upload(file.name, base64);
      // The site may not serve the new file until a rebuild; thumbnail from
      // the local bytes meanwhile.
      sessionThumbs.set(path, URL.createObjectURL(file));
      node.value = path;
      setThumbOk(true);
      touch();
      refreshAssets();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const thumbSrc = sessionThumbs.get(node.value) ?? siteUrl + node.value;
  return (
    <div className="string-input kind-image">
      <span className="kind-tag">image</span>
      <div className="image-row">
        {node.value && thumbOk && (
          <img
            className="image-thumb"
            src={thumbSrc}
            alt=""
            onError={() => setThumbOk(false)}
            onLoad={() => setThumbOk(true)}
          />
        )}
        <input
          type="text"
          list="editsy-assets"
          placeholder="/path/under/public"
          value={node.value}
          onChange={(e) => {
            node.value = e.target.value;
            setThumbOk(true);
            touch();
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
          }}
        />
        <button
          className="ghost-btn"
          disabled={uploading}
          title="Upload an image (goes into the site's assets)"
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? "uploading…" : "upload"}
        </button>
      </div>
      {note && <span className="date-note">{note}</span>}
    </div>
  );
}

function TextareaInput({ node, touch }: EditorProps<StringField>) {
  return (
    <div className={`string-input kind-${node.kind}`}>
      <textarea
        rows={Math.min(12, Math.max(3, node.value.split("\n").length + 1))}
        value={node.value}
        onChange={(e) => {
          node.value = e.target.value;
          touch();
        }}
      />
    </div>
  );
}

function ListEditor({ node, touch }: EditorProps<{ kind: "list"; items: string[] }>) {
  return (
    <div className="list-editor">
      {node.items.map((item, i) => (
        <div className="list-row" key={i}>
          <input
            type="text"
            value={item}
            onChange={(e) => {
              node.items[i] = e.target.value;
              touch();
            }}
          />
          <button
            className="icon-btn"
            title="Remove"
            aria-label="Remove"
            onClick={() => {
              node.items.splice(i, 1);
              touch();
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="ghost-btn"
        onClick={() => {
          node.items.push("");
          touch();
        }}
      >
        + add
      </button>
    </div>
  );
}

export function ObjectEditor({ node, touch }: EditorProps<ObjectField>) {
  return (
    <div className="object-editor">
      {Object.entries(node.fields).map(([key, child]) => (
        <div className="field" key={key}>
          <label className="field-label">{labelize(key)}</label>
          <NodeEditor node={child} touch={touch} />
        </div>
      ))}
    </div>
  );
}

function itemTitle(item: ObjectField, index: number): string {
  for (const child of Object.values(item.fields)) {
    if ((child.kind === "text" || child.kind === "textarea") && child.value.trim()) {
      return child.value.length > 48 ? child.value.slice(0, 48) + "…" : child.value;
    }
  }
  return `Item ${index + 1}`;
}

function CollectionEditor({
  node,
  touch,
}: EditorProps<{ kind: "collection"; items: ObjectField[]; template?: ObjectField }>) {
  const move = (from: number, to: number) => {
    if (to < 0 || to >= node.items.length) return;
    const [item] = node.items.splice(from, 1);
    node.items.splice(to, 0, item!);
    touch();
  };

  return (
    <div className="collection-editor">
      {node.items.map((item, i) => (
        <details className="collection-item" key={i} open={node.items.length <= 3}>
          <summary>
            <span className="item-title">{itemTitle(item, i)}</span>
            <span className="item-actions" onClick={(e) => e.preventDefault()}>
              <button
                className="icon-btn"
                title="Move up"
                aria-label="Move up"
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
              >
                ↑
              </button>
              <button
                className="icon-btn"
                title="Move down"
                aria-label="Move down"
                disabled={i === node.items.length - 1}
                onClick={() => move(i, i + 1)}
              >
                ↓
              </button>
              <button
                className="icon-btn"
                title="Duplicate"
                aria-label="Duplicate"
                onClick={() => {
                  const clone = structuredClone(item);
                  node.items.splice(i + 1, 0, clone);
                  touch();
                }}
              >
                ⧉
              </button>
              <button
                className="icon-btn danger"
                title="Delete"
                aria-label="Delete"
                onClick={() => {
                  node.items.splice(i, 1);
                  touch();
                }}
              >
                ×
              </button>
            </span>
          </summary>
          <ObjectEditor node={item} touch={touch} />
        </details>
      ))}
      <button
        className="ghost-btn"
        disabled={node.items.length === 0 && !node.template}
        title={
          node.template
            ? "Add a new item from the collection's template"
            : node.items.length === 0
              ? "An empty collection has no shape to copy; give defineCollection a { template } or add the first item in the file"
              : "Add a new item (blank copy of the first item's shape)"
        }
        onClick={() => {
          let item: ObjectField;
          if (node.template) {
            // The declared template arrives with the author's defaults.
            item = structuredClone(node.template);
            delete item.__src;
            item.__template = true;
          } else {
            item = blankClone(node.items[0]!);
          }
          node.items.push(item);
          touch();
        }}
      >
        + add item
      </button>
    </div>
  );
}

/** After a successful save the file is re-read; re-tag sources for the next edit session. */
export { tagSources };
