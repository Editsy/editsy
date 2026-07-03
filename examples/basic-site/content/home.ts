import { defineContent, f } from "editsy";

// Homepage copy. Every value in this file is editable in editsy.
export default defineContent({
  hero: {
    heading: "A tidy little website.",
    subheading:
      "This is the editsy example site. Every word on this page lives in a content file; open the editor and change any of it.",
    cta: { label: "See the posts", href: f.url("#posts") },
  },
  about: {
    heading: "How this page works",
    body: f.markdown(
      "The copy here comes from `content/home.ts`, the posts below come from `content/posts.ts`, and the footer comes from `content/global.ts`.\n\nRun **npx editsy edit** and try it: edits show up in the preview as you type, and nothing is written until you approve the diff.",
    ),
  },
});
