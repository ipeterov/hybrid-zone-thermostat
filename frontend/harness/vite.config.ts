import { defineConfig } from "vite";

// The harness's dev server (see playwright.config.ts). Resolves packages'
// production builds, as the real bundle does, so Lit runs without its
// dev-mode checks and their console warning.
export default defineConfig({
  resolve: {
    conditions: ["module", "browser", "production"],
  },
});
