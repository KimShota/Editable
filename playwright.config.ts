import { defineConfig } from "@playwright/test";
import { APP_PORT, APP_URL, DB_PORT, DB_URL, STORAGE_ROOT, testEnv } from "./tests/e2e/env";

/**
 * Browser smoke tests (plan/ui-ux-full-flow.md §9): one per slice, run
 * against a throwaway database and storage folder with every paid provider
 * disabled. `npm run test:e2e` starts everything it needs.
 *
 * Chrome is used from the system install (PLAYWRIGHT_CHANNEL=chromium to use
 * Playwright's own download instead, after `npx playwright install chromium`).
 */

const channel = process.env.PLAYWRIGHT_CHANNEL === "chromium" ? undefined : "chrome";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  // One shared database and one worker: tests that change data reset it first.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "artifacts/e2e-results",
  globalSetup: "./tests/e2e/globalSetup.ts",
  webServer: [
    {
      command: `npm run -s test:db-server -- --port ${DB_PORT} --storage ${STORAGE_ROOT}`,
      url: `${DB_URL}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: testEnv(),
    },
    {
      command: `npx next dev -p ${APP_PORT}`,
      url: `${APP_URL}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: testEnv(),
    },
  ],
  use: {
    baseURL: APP_URL,
    channel,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
});
