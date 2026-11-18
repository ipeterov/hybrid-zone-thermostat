import { defineConfig, devices } from "@playwright/test";

const port = 5179;

// Browser tests against the harness page (frontend/harness), served by
// Vite straight from the TypeScript sources.
export default defineConfig({
  testDir: "frontend/tests",
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [["list"], ["junit", { outputFile: "playwright-results.xml" }]]
    : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // The HA app on Apple devices is WebKit, which differs on focus,
    // hover and clipping; tests tagged @webkit run there too.
    { name: "webkit", grep: /@webkit/, use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `npx vite frontend/harness --port ${port} --strictPort`,
    port,
    reuseExistingServer: !process.env.CI,
  },
});
