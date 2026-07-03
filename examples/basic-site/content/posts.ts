import { defineCollection, f } from "editsy";

// A collection: add, duplicate, reorder, or delete items in editsy.
export default defineCollection([
  {
    title: "Hello from the example site",
    date: "2026-01-15",
    image: f.image("/images/leaf.svg"),
    published: true,
    tags: ["news", "example"],
    summary: f.markdown(
      "Posts are just objects in an array. This one has a **title**, a date, an image, tags, and this summary.",
    ),
  },
  {
    title: "A second post, for company",
    date: "2026-02-02",
    image: f.image("/images/wave.svg"),
    published: true,
    tags: ["example"],
    summary: f.markdown("Duplicate this one in the editor and make it your own."),
  },
], {
  // What "+ add item" creates: shape and starting values. With a template,
  // even a collection that's been emptied out can grow again in the editor.
  template: {
    title: "A brand new post",
    date: "2026-01-01",
    image: f.image(""),
    published: false,
    tags: [],
    summary: f.markdown("Say something worth reading."),
  },
});
