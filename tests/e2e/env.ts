import os from "node:os";
import path from "node:path";

/**
 * The environment every process under test runs in: the PGlite test database
 * (never the real one in .env), a throwaway storage folder, and a sentinel in
 * place of every paid provider's key, so anything that tries to spend money
 * fails loudly instead of succeeding.
 */
export const DB_PORT = 4455;
export const APP_PORT = 3199;
export const DB_URL = `http://127.0.0.1:${DB_PORT}`;
export const APP_URL = `http://localhost:${APP_PORT}`;
export const STORAGE_ROOT = path.join(os.tmpdir(), "katalab-ui-fixture");

const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "HIGGSFIELD_API_KEY",
  "HIGGSFIELD_API_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_PREMIUM_PRICE_ID",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "ELEVENLABS_API_KEY",
];

export const testEnv = (): Record<string, string> => ({
  ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
  ...Object.fromEntries(PROVIDER_KEYS.map((k) => [k, "disabled-in-tests"])),
  KATALAB_TEST_DB_URL: DB_URL,
  STORAGE_ROOT,
  KATALAB_STUB_PROVIDERS: "1",
  // A fixed "today" (Monday, day 4 of the fixture plan) for the calendar.
  KATALAB_NOW: "2026-10-12T12:00:00Z",
  NEXT_DIST_DIR: ".next-test",
  NODE_OPTIONS: "--max-old-space-size=4096",
});
