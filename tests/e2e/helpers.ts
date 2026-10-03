import { type Cookie, expect, type Page, request, type TestInfo } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { APP_URL, DB_URL } from "./env";

export const PASSWORD = "test-password-123";
export const USERS = {
  founder: "founder@katalab.test",
  member: "member@katalab.test",
  outsider: "outsider@katalab.test",
} as const;
export const CARDS = { draft: "card-draft", approved: "card-approved", review: "card-review", inReview: "card-internal", ready: "card-ready" } as const;

/** Puts the test database and storage back to the seeded fixture. Users get
 *  new ids, so call this before logging in, not after.
 *
 *  It first waits for the queue to go idle: the worker is a separate process,
 *  and a job still running when the storage is wiped would finish afterwards
 *  and write its files into the fresh fixture. */
export const resetFixture = async (): Promise<void> => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const busy = await sql(`select count(*)::int as n from work_queue where status in ('queued', 'running')`).catch(() => [{ n: 0 }]);
    if (Number(busy[0]?.n ?? 0) === 0) break;
    if (Date.now() > deadline) throw new Error("the queue did not go idle before the reset");
    await new Promise((r) => setTimeout(r, 150));
  }
  const res = await fetch(`${DB_URL}/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error(`reset failed: ${res.status}`);
};

/** Runs SQL against the test database directly (to enqueue a job, or to read
 *  back what the app wrote). */
export const sql = async (text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
  const res = await fetch(`${DB_URL}/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, params }) });
  const data = (await res.json()) as { rows?: Record<string, unknown>[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? `sql failed: ${res.status}`);
  return data.rows ?? [];
};

/** Signs in through the real login form. Use it only for tests that are about
 *  signing in: the server allows 10 attempts per email per 15 minutes, so a
 *  suite that logs in this way for every test locks itself out. Everything
 *  else uses signIn(). */
export const login = async (page: Page, email: string, opts: { next?: string } = {}): Promise<void> => {
  await page.goto(opts.next ? `/login?next=${encodeURIComponent(opts.next)}` : "/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /log in|sign in/i }).click();
};

export type UserKey = keyof typeof USERS;

const sessions: Partial<Record<UserKey, Cookie[]>> = {};

/** Logs each user in once, through the API, and keeps the session cookies.
 *  Call it right after resetFixture() (a reset gives users new ids and
 *  invalidates old sessions). */
export const startSessions = async (): Promise<void> => {
  for (const key of Object.keys(USERS) as UserKey[]) {
    const api = await request.newContext({ baseURL: APP_URL });
    const res = await api.post("/api/auth/login", { data: { email: USERS[key], password: PASSWORD } });
    expect(res.ok(), `logging ${key} in over the API`).toBe(true);
    sessions[key] = (await api.storageState()).cookies;
    await api.dispose();
  }
};

/** Starts a test already signed in as `user`, on the calendar. */
export const signInAndOpenCalendar = async (page: Page, user: UserKey): Promise<void> => {
  const cookies = sessions[user];
  if (!cookies) throw new Error(`no session for ${user}: call startSessions() in beforeAll`);
  await page.context().addCookies(cookies);
  await page.goto("/calendar");
};

/** Saves a screenshot under artifacts/ui-screens/<slice>/, named by project
 *  (desktop or phone), for looking at after a run. */
export const shot = async (page: Page, info: TestInfo, slice: string, name: string): Promise<void> => {
  const dir = path.join("artifacts", "ui-screens", slice);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.${info.project.name}.png`), fullPage: true });
};

export const expectNoHorizontalScroll = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "the page should not scroll sideways").toBeLessThanOrEqual(0);
};
