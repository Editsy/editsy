/**
 * The document model: what the AST layer produces from a content file and
 * what the editor UI renders. Field kinds follow ARCHITECTURE.md D4.
 */

/** String field kinds. `text`/`textarea`/`date` can be inferred; the rest come from `f.*` annotations. */
export type StringKind = "text" | "textarea" | "markdown" | "html" | "image" | "url" | "date" | "select";

export interface StringField {
  kind: StringKind;
  value: string;
  /** True when the kind came from an explicit `f.*` annotation rather than inference. */
  annotated: boolean;
  /** The allowed values, for `f.select()` fields. */
  options?: string[];
}

export interface NumberField {
  kind: "number";
  value: number;
}

export interface BooleanField {
  kind: "boolean";
  value: boolean;
}

/** A `string[]`, rendered as a tag/list editor. */
export interface ListField {
  kind: "list";
  items: string[];
}

/** A plain object, rendered as a fieldset. Insertion order is file order. */
export interface ObjectField {
  kind: "object";
  fields: Record<string, FieldNode>;
}

/** An array of objects, rendered as a collection with add/duplicate/delete/reorder. */
export interface CollectionField {
  kind: "collection";
  items: ObjectField[];
  /**
   * New-item shape and defaults, from `defineCollection(items, { template })`.
   * Lets the editor add a first item to an EMPTY collection; without it, add
   * copies the first existing item's shape.
   */
  template?: ObjectField;
}

export type FieldNode =
  | StringField
  | NumberField
  | BooleanField
  | ListField
  | ObjectField
  | CollectionField;

export interface ContentDoc {
  /** Path relative to the project root, forward slashes. */
  file: string;
  /** Which wrapper the file used. */
  type: "content" | "collection";
  root: ObjectField | CollectionField;
  /**
   * Present when the file's editable content comes from several exports
   * (named exports and/or a default). The root is then an object whose keys
   * are these export names ("default" for the default export), and live
   * preview streams each export separately.
   */
  exports?: string[];
}

/** A save refused because the values don't fit the file (shape mismatch, unparseable file). */
export class WriteError extends Error {
  constructor(
    message: string,
    public file: string,
    public line?: number,
  ) {
    super(line ? `${file}:${line}: ${message}` : `${file}: ${message}`);
  }
}

/** A problem found while reading or checking a content file. */
export interface Issue {
  message: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

// ---------------------------------------------------------------------------
// Values tree: what the editor sends back on save. Mirrors the file's
// structure. Collections are explicit so the writer can preserve `f.*`
// annotations and comments across add/duplicate/reorder (see write.ts).
// ---------------------------------------------------------------------------

export type Value =
  | string
  | number
  | boolean
  | string[]
  | CollectionValue
  | { [key: string]: Value };

export interface CollectionItemValue {
  /**
   * Index of the original array element this item derives from (its
   * template). Present for surviving/duplicated items; absent only for
   * items built from scratch. The writer clones the template's source text
   * (keeping `f.*` wrappers and comments) and applies the values into it.
   */
  $src?: number;
  /**
   * True when the item was created from the collection's declared template
   * (`defineCollection(items, { template })`). The writer clones the
   * template's source text, same treatment as `$src`.
   */
  $template?: boolean;
  value: { [key: string]: Value };
}

export interface CollectionValue {
  $collection: true;
  items: CollectionItemValue[];
}

export function isCollectionValue(v: Value): v is CollectionValue {
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as CollectionValue).$collection === true;
}

/** Convert a parsed document node to the editable values tree. */
export function toValues(node: FieldNode): Value {
  switch (node.kind) {
    case "text":
    case "textarea":
    case "markdown":
    case "html":
    case "image":
    case "url":
    case "date":
    case "select":
      return node.value;
    case "number":
    case "boolean":
      return node.value;
    case "list":
      return [...node.items];
    case "object": {
      const out: { [key: string]: Value } = {};
      for (const [key, child] of Object.entries(node.fields)) out[key] = toValues(child);
      return out;
    }
    case "collection":
      return {
        $collection: true,
        items: node.items.map((item, i) => ({
          $src: i,
          value: toValues(item) as { [key: string]: Value },
        })),
      };
  }
}
