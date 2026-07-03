import type { NextConfig } from "next";

const config: NextConfig = {
  // These workspace packages ship TypeScript source in dev; let Next
  // transpile them. (@editsy/cli resolves to its built dist and needs no
  // transpilation.)
  transpilePackages: ["editsy", "@editsy/next"],
  // The two blocks every deployed /editsy needs (this example never
  // deploys, but it's what people copy): keep the cli out of the route
  // bundle, and ship the editor's assets with the route.
  serverExternalPackages: ["@editsy/cli"],
  outputFileTracingIncludes: {
    "/editsy/**": [
      "./node_modules/**/@editsy/editor/dist/**",
      "./node_modules/**/@editsy/editor/package.json",
    ],
  },
};

export default config;
