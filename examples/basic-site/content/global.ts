import { defineContent, f } from "editsy";

// Shared bits: site name, footer. Used across every page.
export default defineContent({
  siteName: "Example Site",
  footer: {
    tagline: "Built with editsy, the little CMS that lives in your repo.",
    email: "hello@example.com",
    website: f.url("https://editsy.dev"),
    // f.html: for HTML fragments a site already has. Edited as rich text,
    // rendered unsanitized (see Footer.tsx). Prefer f.markdown for new copy.
    finePrint: f.html("<p>© Example Site. Some <em>rights</em> reserved, the fun ones waived.</p>"),
  },
});
