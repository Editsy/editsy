// The editsy admin, served by the site itself (remote mode, D8).
// Editors visit /editsy, log in, edit, publish. Backed by the local
// filesystem under `next dev`; set EDITSY_GITHUB_* env vars in production
// so saves become commits.
import { createEditsy } from "@editsy/next";

export const { GET, POST } = createEditsy();
