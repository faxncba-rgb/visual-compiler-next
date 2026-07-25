import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  // Studio owns one managed Chromium session and in-memory capture registry.
  // Serial E2E avoids cross-test contention with that intentionally singleton
  // local demonstration process.
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4273",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "SSO_FIXTURE_PORT=4275 npm run dev:sso-fixture",
      url: "http://127.0.0.1:4275/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        "DEMO_PORT=4273 SSO_AUTH_ORIGIN=http://127.0.0.1:4275 npm run dev:demo",
      url: "http://127.0.0.1:4273/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        "USE_LIVE_OPENAI=false MANAGED_BROWSER_HEADLESS=true STUDIO_PORT=3100 DEMO_SITE_INTERNAL_URL=http://127.0.0.1:4273 DEMO_SITE_PUBLIC_URL=http://127.0.0.1:4273 NCBA_TRAINING_ORIGIN=http://127.0.0.1:4273 ALLOW_EXPLICIT_LOCAL_SSO_FIXTURE=true SSO_FIXTURE_AUTH_ORIGIN=http://127.0.0.1:4275 WORKFLOW_STORAGE_DIR=/private/tmp/visual-compiler-next-e2e-workflows E2E_SEED_WORKFLOW_PATH=compiled-workflows/pending-review.workflow.json npm run dev:studio",
      url: "http://127.0.0.1:3100/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
