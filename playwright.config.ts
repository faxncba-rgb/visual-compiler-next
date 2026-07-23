import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:4273",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "DEMO_PORT=4273 npm run dev:demo",
      url: "http://127.0.0.1:4273/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        "STUDIO_PORT=3100 DEMO_SITE_INTERNAL_URL=http://127.0.0.1:4273 DEMO_SITE_PUBLIC_URL=http://127.0.0.1:4273 npm run dev:studio",
      url: "http://127.0.0.1:3100/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
