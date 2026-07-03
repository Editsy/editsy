/**
 * The editor's pure logic: value conversion, source tagging, and (the
 * fiddliest of the three) applying a stored crash-recovery draft back onto a
 * freshly loaded node tree. The UI itself is exercised in the browser; the
 * correctness-critical parts live here where they can run in CI.
 */
import { describe, expect, it } from "vitest";
import {
  applyStoredValues,
  blankClone,
  tagSources,
  toValues,
  type CollectionField,
  type ObjectField,
} from "../src/types";

function doc(): ObjectField {
  return {
    kind: "object",
    fields: {
      title: { kind: "text", value: "Old", annotated: false },
      status: { kind: "select", value: "upcoming", annotated: true, options: ["upcoming", "past"] },
      posts: {
        kind: "collection",
        items: [
          { kind: "object", fields: { name: { kind: "text", value: "One", annotated: false } } },
          { kind: "object", fields: { name: { kind: "text", value: "Two", annotated: false } } },
        ],
        template: {
          kind: "object",
          fields: { name: { kind: "text", value: "New post", annotated: false } },
        },
      },
    },
  };
}

describe("tagSources / toValues", () => {
  it("tags collection items and round-trips through values", () => {
    const root = doc();
    tagSources(root);
    const values = toValues(root) as { posts: { items: { $src?: number }[] } };
    expect(values.posts.items.map((i) => i.$src)).toEqual([0, 1]);
  });

  it("emits $template for template-created items and clears the flag on retag", () => {
    const root = doc();
    tagSources(root);
    const coll = root.fields.posts as CollectionField;
    const fresh = structuredClone(coll.template!);
    fresh.__template = true;
    coll.items.push(fresh);

    const values = toValues(root) as { posts: { items: { $src?: number; $template?: boolean }[] } };
    expect(values.posts.items[2]).toMatchObject({ $template: true });
    expect(values.posts.items[2]!.$src).toBeUndefined();

    // After a save the item is a real element; retagging must say so.
    tagSources(root);
    const after = toValues(root) as { posts: { items: { $src?: number; $template?: boolean }[] } };
    expect(after.posts.items[2]).toMatchObject({ $src: 2 });
    expect(after.posts.items[2]!.$template).toBeUndefined();
  });
});

describe("applyStoredValues (crash recovery)", () => {
  it("restores scalars, selects, and collection edits including reorders", () => {
    const root = doc();
    tagSources(root);
    const draft = structuredClone(root);
    (draft.fields.title as { value: string }).value = "Recovered";
    (draft.fields.status as { value: string }).value = "past";
    (draft.fields.posts as CollectionField).items.reverse();
    const stored = toValues(draft);

    const target = doc();
    tagSources(target);
    applyStoredValues(target, stored);
    expect((target.fields.title as { value: string }).value).toBe("Recovered");
    expect((target.fields.status as { value: string }).value).toBe("past");
    const items = (target.fields.posts as CollectionField).items;
    expect(items.map((i) => (i.fields.name as { value: string }).value)).toEqual(["Two", "One"]);
    expect(items.map((i) => i.__src)).toEqual([1, 0]);
  });

  it("rebuilds template-created items from the collection's template", () => {
    const root = doc();
    tagSources(root);
    const stored = {
      posts: {
        $collection: true,
        items: [
          { $src: 0, value: { name: "One" } },
          { $template: true, value: { name: "Drafted offline" } },
        ],
      },
    };
    applyStoredValues(root, stored as never);
    const items = (root.fields.posts as CollectionField).items;
    expect(items).toHaveLength(2);
    expect((items[1]!.fields.name as { value: string }).value).toBe("Drafted offline");
    expect(items[1]!.__template).toBe(true);
  });

  it("throws on anything it can't restore faithfully; callers fall back to a clean load", () => {
    const root = doc();
    tagSources(root);
    expect(() => applyStoredValues(root, { title: 42 } as never)).toThrow(/mismatch/);
    const scratch = {
      posts: { $collection: true, items: [{ value: { name: "no template info" } }] },
    };
    expect(() => applyStoredValues(doc(), scratch as never)).toThrow(/restorable/);
  });
});

describe("blankClone", () => {
  it("blanks free-text values but keeps a select on a valid option", () => {
    const item: ObjectField = {
      kind: "object",
      fields: {
        name: { kind: "text", value: "Keep me not", annotated: false },
        status: { kind: "select", value: "past", annotated: true, options: ["upcoming", "past"] },
      },
    };
    const blank = blankClone(item);
    expect((blank.fields.name as { value: string }).value).toBe("");
    expect((blank.fields.status as { value: string }).value).toBe("past");
  });
});
