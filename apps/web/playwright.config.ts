import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const repoRoot = "../..";
const fixtureHome = fileURLToPath(
  new URL("./test-results/engine", import.meta.url),
);
const quotedFixtureHome = `'${fixtureHome.replaceAll("'", "'\\''")}'`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:7798",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `TOKEN_ANALYSER_HOME=${quotedFixtureHome} FIXTURE_DIR=fixtures/redacted PORT=7799 pnpm --filter engine start`,
      url: "http://127.0.0.1:7799/sessions",
      cwd: repoRoot,
      // Never reuse a live user's engine for mutation tests.
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The engine is started by the first webServer entry. Starting the root
      // dev script here launches a second engine and can take the Vite child
      // down when that duplicate hits EADDRINUSE.
      command:
        "TOKEN_ANALYSER_API_URL=http://127.0.0.1:7799 pnpm --filter web dev --port 7798 --strictPort",
      url: "http://127.0.0.1:7798",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
