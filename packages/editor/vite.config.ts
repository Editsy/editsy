import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    // During editor development, run `editsy edit` in a test project and
    // proxy the API to it.
    proxy: { "/api": "http://localhost:4499" },
  },
});
