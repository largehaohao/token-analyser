import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const repoRoot = "../..";
const fixtureHome = fileURLToPath(
  new URL("./test-results/engine", import.meta.url),
);
const enginePort = process.env.E2E_ENGINE_PORT ?? "7799";
const webPort = process.env.E2E_WEB_PORT ?? "7798";
const quotedFixtureHome = `'${fixtureHome.replaceAll("'", "'\\''")}'`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `mkdir -p ${quotedFixtureHome} && printf '{"power":{"prometheus_url":"http://127.0.0.1:1"}}' > ${quotedFixtureHome}/config.json && TOKEN_ANALYSER_HOME=${quotedFixtureHome} FIXTURE_DIR=fixtures/redacted PORT=${enginePort} pnpm --filter engine start`,
      url: `http://127.0.0.1:${enginePort}/sessions`,
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
        `TOKEN_ANALYSER_API_URL=http://127.0.0.1:${enginePort} pnpm --filter web dev --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
