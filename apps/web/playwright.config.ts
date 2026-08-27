import { defineConfig } from "@playwright/test";

const repoRoot = "../..";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:7788",
  },
  webServer: [
    {
      command: "FIXTURE_DIR=fixtures/redacted PORT=7789 pnpm --filter engine start",
      url: "http://127.0.0.1:7789/sessions",
      cwd: repoRoot,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "pnpm dev",
      url: "http://127.0.0.1:7788",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
