import { defineConfig } from "vite";

// The panel and the card, each one self-contained ES module (Lit bundled
// in), written into the integration so HA serves them and a release zip
// carries them. That folder is gitignored.
export default defineConfig({
  build: {
    outDir: "custom_components/hybrid_zone_thermostat/frontend",
    emptyOutDir: true,
    lib: {
      entry: {
        panel: "frontend/src/panel.ts",
        card: "frontend/src/card.ts",
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      // Shared chunks get a content hash in their name, so a new build
      // never reuses a cached one.
      output: { chunkFileNames: "[name]-[hash].js" },
    },
  },
});
