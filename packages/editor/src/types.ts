/**
 * Wire types shared with @editsy/cli (see packages/cli/src/model.ts; keep in
 * sync by hand until the packages get a build step to share from).
 *
 * Client-only extension: collection item ObjectFields carry `__src`, the
 * index of the original array element they derive from, so the writer can
 * clone source text (preserving f.* annotations and comments) on
 * add/duplicate/reorder.
 */

export type StringKind = "text" | "textarea" | "markdown" | "html" | "image" | "url" | "date" | "select";

export interface StringField {
  kind: StringKind;
  value: string;
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
export interface ListField {
  kind: "list";
  items: string[];
}
export interface ObjectField {
  kind: "object";
  fields: Record<string, FieldNode>;
  /** Client-only: template index for collection items. */
  __src?: number;
  /** Client-only: item created from the collection's declared template. */
  __template?: boolean;
}
export interface CollectionField {
  kind: "collection";
  items: ObjectField[];
  /** New-item shape/defaults from `defineCollection(items, { template })`. */
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
  file: string;
  type: "content" | "collection";
  root: ObjectField | CollectionField;
  /** Export names when the file's content spans several exports ("default" for the default). */
  exports?: string[];
}

export interface Issue {
  message: string;
  line: number;
  column: number;
}

export type Value =
  | string
  | number
  | boolean
  | string[]
  | CollectionValue
  | { [key: string]: Value };

export interface CollectionItemValue {
  $src?: number;
  /** Item created from the collection's declared template. */
  $template?: boolean;
  value: { [key: string]: Value };
}
export interface CollectionValue {
  $collection: true;
  items: CollectionItemValue[];
}

/** Convert the (client-annotated) node tree back to the values tree the server saves. */
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
        items: node.items.map((item) => ({
          $src: item.__src,
          ...(item.__template && item.__src === undefined ? { $template: true } : {}),
          value: toValues(item) as { [key: string]: Value },
        })),
      };
  }
}

/**
 * Convert a node tree to the plain data shape the site consumes (what the
 * content file exports at runtime). Used to stream drafts into the preview
 * iframe for `useEditsy` live preview.
 */
export function toPlainContent(node: FieldNode): unknown {
  switch (node.kind) {
    case "text":
    case "textarea":
    case "markdown":
    case "html":
    case "image":
    case "url":
    case "date":
    case "select":
    case "number":
    case "boolean":
      return node.value;
    case "list":
      return [...node.items];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.fields)) out[key] = toPlainContent(child);
      return out;
    }
    case "collection":
      return node.items.map((item) => toPlainContent(item));
  }
}

/** Tag collection items with their original index (recursively) after a load. */
export function tagSources(node: FieldNode): void {
  if (node.kind === "collection") {
    node.items.forEach((item, i) => {
      item.__src = i;
      delete item.__template; // once saved, an item is a real element
      tagSources(item);
    });
  } else if (node.kind === "object") {
    for (const child of Object.values(node.fields)) tagSources(child);
  }
}

/**
 * Apply a stored values tree (a previous session's unsaved edits) onto a
 * freshly loaded node tree, in place. Throws on any mismatch; callers
 * treat that as "not restorable" and keep the clean load. Only valid when
 * the stored values were captured against the SAME file revision, so
 * collection `$src` indices still point at the right items.
 */
export function applyStoredValues(node: FieldNode, value: Value): void {
  switch (node.kind) {
    case "text":
    case "textarea":
    case "markdown":
    case "html":
    case "image":
    case "url":
    case "date":
    case "select":
      if (typeof value !== "string") throw new Error("draft shape mismatch");
      node.value = value;
      return;
    case "number":
      if (typeof value !== "number") throw new Error("draft shape mismatch");
      node.value = value;
      return;
    case "boolean":
      if (typeof value !== "boolean") throw new Error("draft shape mismatch");
      node.value = value;
      return;
    case "list":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw new Error("draft shape mismatch");
      }
      node.items = [...(value as string[])];
      return;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("draft shape mismatch");
      }
      for (const [key, child] of Object.entries(node.fields)) {
        if (Object.hasOwn(value, key)) {
          applyStoredValues(child, (value as Record<string, Value>)[key]!);
        }
      }
      return;
    }
    case "collection": {
      const v = value as CollectionValue;
      if (typeof v !== "object" || v === null || v.$collection !== true || !Array.isArray(v.items)) {
        throw new Error("draft shape mismatch");
      }
      const originals = node.items;
      node.items = v.items.map((iv) => {
        let base: ObjectField;
        if (iv.$src !== undefined && originals[iv.$src]) {
          base = structuredClone(originals[iv.$src]!);
          base.__src = iv.$src;
        } else if (iv.$template && node.template) {
          base = structuredClone(node.template);
          delete base.__src;
          base.__template = true;
        } else {
          throw new Error("draft item has no restorable template");
        }
        applyStoredValues(base, iv.value);
        return base;
      });
      return;
    }
  }
}

/** Deep-clone a node and blank its leaf values (for create-from-blank). */
export function blankClone(node: ObjectField): ObjectField {
  const clone = structuredClone(node);
  const blank = (n: FieldNode): void => {
    switch (n.kind) {
      case "text":
      case "textarea":
      case "markdown":
      case "image":
      case "url":
        n.value = "";
        break;
      case "number":
        n.value = 0;
        break;
      case "boolean":
        n.value = false;
        break;
      case "list":
        n.items = [];
        break;
      case "object":
        for (const child of Object.values(n.fields)) blank(child);
        break;
      case "collection":
        n.items = [];
        break;
    }
  };
  blank(clone);
  return clone;
}
