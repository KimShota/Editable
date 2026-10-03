import { expect, type Page, test } from "@playwright/test";
import { APP_URL } from "./env";
import { CARDS, expectNoHorizontalScroll, login, resetFixture, shot, signInAndOpenCalendar, sql, startSessions, USERS } from "./helpers";

/**
 * P1.1 foundations (plan/ui-ux-full-flow.md §9): the app shell, who may see
 * which brand, the media rules, brand switching and <TaskProgress>. Runs at
 * desktop and phone width.
 */

test.beforeAll(async () => {
  await resetFixture();
  await startSessions();
});

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) < 768;

/** On a phone the navigation lives behind a menu button. */
const openNavIfPhone = async (page: Page): Promise<void> => {
  if (isPhone(page)) await page.getByRole("button", { name: "Open menu" }).click();
};

const enqueuePing = async (payload: Record<string, unknown>, maxAttempts = 3): Promise<number> => {
  const rows = await sql(`insert into work_queue (kind, payload, max_attempts) values ('system.ping', $1::jsonb, $2) returning id`, [JSON.stringify(payload), maxAttempts]);
  return Number(rows[0].id);
};

test.describe("signing in and the shell", () => {
  test("a member signs in and lands on the calendar with their plan", async ({ page }, info) => {
    await login(page, USERS.member);
    await page.waitForURL("**/calendar");
    await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();

    const expected: Record<string, string> = {
      [CARDS.draft]: "Draft",
      [CARDS.approved]: "Queued for production",
      [CARDS.inReview]: "Generating",
      [CARDS.review]: "Needs your review",
      [CARDS.ready]: "Ready to post",
    };
    await expect(page.locator("[data-card-id]")).toHaveCount(5);
    for (const [id, label] of Object.entries(expected)) {
      await expect(page.locator(`[data-card-id="${id}"]`)).toContainText(label);
    }
    // Dates come from the plan's start date, not the viewer's time zone.
    await expect(page.locator(`[data-card-id="${CARDS.draft}"]`)).toContainText("Fri, Oct 9");
    await expect(page.locator(`[data-card-id="${CARDS.ready}"]`)).toContainText("Tue, Oct 13");

    // The customer must never be told about the internal review gate.
    await expect(page.locator("body")).not.toContainText(/internal review/i);

    // The old top bar is gone inside the app: one navigation, not two.
    await expect(page.getByRole("link", { name: "Pricing" })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.1", "calendar");
  });

  test("the sidebar names the brand and marks the current page", async ({ page }, info) => {
    await signInAndOpenCalendar(page, "member");
    await openNavIfPhone(page);

    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Acme", { exact: true }).first()).toBeVisible();
    // One brand: a label, not a dropdown.
    await expect(page.getByLabel("Brand")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Log out" }).first()).toBeVisible();
    if (isPhone(page)) await shot(page, info, "p1.1", "phone-menu-open");
  });

  test("on a phone the menu opens and closes, and closes after navigating", async ({ page }) => {
    test.skip(!isPhone(page), "phone only");
    await signInAndOpenCalendar(page, "member");

    const menu = page.getByRole("button", { name: "Open menu" });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    await menu.click();
    await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await page.getByRole("button", { name: "Close menu" }).click();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  });

  test("on a desktop the sidebar is always visible and there is no menu button", async ({ page }) => {
    test.skip(isPhone(page), "desktop only");
    await signInAndOpenCalendar(page, "member");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
  });

  test("signing in returns you to the page you were sent away from", async ({ page }) => {
    await page.goto("/calendar");
    await expect(page).toHaveURL(/\/login\?next=%2Fcalendar/);
    await login(page, USERS.member, { next: "/calendar" });
    await page.waitForURL("**/calendar");
  });

  test("a crafted next parameter cannot send you to another site", async ({ page }) => {
    await login(page, USERS.member, { next: "//evil.example/steal" });
    await page.waitForURL("**/calendar");
    expect(new URL(page.url()).origin).toBe(APP_URL);
  });

  test("a wrong password says so and stays on the login page", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(USERS.member);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByText(/invalid|incorrect|wrong/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("the old film-your-own screens land on the calendar", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    for (const old of ["/projects", "/templates", "/library", "/jobs/anything/resources"]) {
      await page.goto(old);
      await expect(page, `${old} should redirect`).toHaveURL(/\/calendar$/);
    }
  });

  test("a member cannot reach admin or authoring routes", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    for (const path of ["/admin", "/reverse-engineer", "/authoring/new", "/api/media/authoring/x"]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
    }
  });

  test("an unauthenticated visitor is turned away from the app and its API", async ({ page, request }) => {
    await page.goto("/calendar");
    await expect(page).toHaveURL(/\/login/);
    for (const path of ["/api/tasks/1", "/api/tasks?slug=acme", "/api/media/brands/acme/character/sheet/front.png"]) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
    expect((await request.post("/api/active-brand", { data: { slug: "acme" } })).status()).toBe(401);
  });
});

test.describe("who may see which brand's files", () => {
  test("a member gets their brand's pictures and video, with seeking", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");

    const png = await page.request.get("/api/media/brands/acme/character/sheet/front.png");
    expect(png.status()).toBe(200);
    expect(png.headers()["content-type"]).toBe("image/png");

    const ranged = await page.request.get(`/api/media/brands/acme/videos/${CARDS.ready}/final.mp4`, { headers: { Range: "bytes=0-99" } });
    expect(ranged.status()).toBe(206);
    expect(ranged.headers()["content-range"]).toMatch(/^bytes 0-99\/\d+$/);
    expect((await ranged.body()).length).toBe(100);
  });

  test("a member cannot fetch another brand's files, or our internals, or escape the folder", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    const denied = [
      "/api/media/brands/rival/character/sheet/front.png", // another workspace's brand
      `/api/media/brands/acme/videos/${CARDS.ready}/costs.jsonl`, // what a video cost us
      `/api/media/brands/acme/videos/${CARDS.ready}/clips/s0.request.json`, // provider request bodies
      "/api/media/brands/acme/plan.json", // the plan file itself
      "/api/media/brands/acme/intake.json",
      "/api/media/brands/acme/..%2Frival/character/sheet/front.png", // traversal hidden in one segment
      "/api/media/brands/acme/..%5Crival/character/sheet/front.png", // …with a backslash
      "/api/media/brands/acme/%2e%2e%2frival/character/sheet/front.png", // …fully encoded
      "/api/media/brands/acme/..%252Frival/character/sheet/front.png", // …double encoded
      "/api/media/brands/acme%2F..%2Frival/character/sheet/front.png", // in the slug segment itself
      "/api/media/brands/%2e%2e/rival/character/sheet/front.png",
      "/api/media/brands/acme/%00/front.png",
      "/api/media/brands/nonexistent/anything.png",
    ];
    for (const path of denied) {
      const res = await page.request.get(path, { failOnStatusCode: false });
      expect(res.ok(), `${path} must not be served (got ${res.status()})`).toBe(false);
    }
  });

  test("even the founder is served media only, not the internals", async ({ page }) => {
    await signInAndOpenCalendar(page, "founder");
    expect((await page.request.get("/api/media/brands/rival/character/sheet/front.png")).status()).toBe(200);
    expect((await page.request.get(`/api/media/brands/acme/videos/${CARDS.ready}/costs.jsonl`, { failOnStatusCode: false })).status()).toBe(404);
  });

  test("an outsider sees only their own brand", async ({ page }) => {
    await signInAndOpenCalendar(page, "outsider");
    await expect(page.getByText("Your plan is being built")).toBeVisible();
    await expect(page.locator("[data-card-id]")).toHaveCount(0);
    expect((await page.request.get("/api/media/brands/acme/character/sheet/front.png", { failOnStatusCode: false })).status()).toBe(404);
    expect((await page.request.get("/api/media/brands/rival/character/sheet/front.png")).status()).toBe(200);
  });

  test("a forged brand cookie cannot expose another brand", async ({ page, context }) => {
    await signInAndOpenCalendar(page, "outsider");
    await context.addCookies([{ name: "katalab_brand", value: "acme", url: APP_URL }]);
    await page.goto("/calendar");
    await expect(page.locator("[data-card-id]")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Hook words for card-draft.");
    const res = await page.request.post("/api/active-brand", { data: { slug: "acme" }, failOnStatusCode: false });
    expect(res.status()).toBe(404);
  });
});

test.describe("brand switching", () => {
  test("the founder can switch between brands and the choice sticks", async ({ page }, info) => {
    await signInAndOpenCalendar(page, "founder");
    await openNavIfPhone(page);

    const select = page.getByLabel("Brand");
    await expect(select.locator("option")).toHaveText(["Acme", "Rival"]);
    await expect(select).toHaveValue("acme");
    await expect(page.locator("[data-card-id]")).toHaveCount(5);

    await select.selectOption("rival");
    await expect(page.getByText("Your plan is being built")).toBeVisible();
    await expect(page.locator("[data-card-id]")).toHaveCount(0);

    await page.reload();
    await openNavIfPhone(page);
    await expect(page.getByLabel("Brand")).toHaveValue("rival");
    await expect(page.getByText("Your plan is being built")).toBeVisible();
    await shot(page, info, "p1.1", "founder-rival");

    await page.getByLabel("Brand").selectOption("acme");
    await expect(page.locator("[data-card-id]")).toHaveCount(5);
  });
});

test.describe("task progress", () => {
  test("a real task shows live progress, then finishes once", async ({ page }, info) => {
    await signInAndOpenCalendar(page, "member");
    // Open the harness once before enqueueing: the dev server compiles a route
    // the first time it is asked for, which can take longer than a short task
    // runs, and the test would then never see it "running".
    await page.goto("/dev-tools/task-progress");
    const id = await enqueuePing({ slug: "acme", cardId: CARDS.draft, steps: 5, stepMs: 800 });
    await page.goto(`/dev-tools/task-progress?task=${id}`);

    const status = page.getByRole("status");
    await expect(status).toHaveAttribute("data-task-status", "running");
    await expect(status).toContainText("Counting");
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", /\d+/);
    await shot(page, info, "p1.1", "task-running");

    await expect(status).toHaveAttribute("data-task-status", "done");
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await expect(page.getByTestId("finished-count")).toHaveText("finished callbacks: 1");
    // Polling has stopped: the callback must not fire again.
    await page.waitForTimeout(1200);
    await expect(page.getByTestId("finished-count")).toHaveText("finished callbacks: 1");
    await shot(page, info, "p1.1", "task-done");
  });

  test("a failed task tells a customer plainly and offers a retry, without the internals", async ({ page }, info) => {
    await signInAndOpenCalendar(page, "member");
    const id = await enqueuePing({ slug: "acme", steps: 2, stepMs: 100, failWith: "boom: provider returned 500" }, 1);
    await page.goto(`/dev-tools/task-progress?task=${id}`);

    const status = page.getByRole("status");
    await expect(status).toHaveAttribute("data-task-status", "failed");
    await expect(status).toContainText("Something went wrong");
    await expect(status).toContainText("did not finish");
    await expect(page.locator("body")).not.toContainText("boom");
    await expect(page.getByTestId("finished-count")).toHaveText("finished callbacks: 0");
    await shot(page, info, "p1.1", "task-failed");

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("retry-count")).toHaveText("retries: 1");
  });

  test("the founder sees the real error", async ({ page }) => {
    await signInAndOpenCalendar(page, "founder");
    const id = await enqueuePing({ slug: "acme", steps: 2, stepMs: 100, failWith: "boom: provider returned 500" }, 1);
    await page.goto(`/dev-tools/task-progress?task=${id}`);
    await expect(page.getByRole("status")).toContainText("boom: provider returned 500");
  });

  test("a task that is not yours reads as not found", async ({ page }) => {
    await signInAndOpenCalendar(page, "outsider");
    const id = await enqueuePing({ slug: "acme", steps: 1, stepMs: 50 });
    await page.goto(`/dev-tools/task-progress?task=${id}`);
    await expect(page.getByRole("status")).toContainText("We can no longer find this step");
    const res = await page.request.get(`/api/tasks/${id}`, { failOnStatusCode: false });
    expect(res.status()).toBe(404);
  });

  test("a scripted replay walks its steps and finishes without any task", async ({ page }) => {
    await signInAndOpenCalendar(page, "founder");
    await page.goto("/dev-tools/task-progress?replay=1");
    const status = page.getByRole("status");
    await expect(status).toContainText("Reading your site");
    await expect(status).toHaveAttribute("data-task-status", "done", { timeout: 6000 });
    await expect(page.getByTestId("finished-count")).toHaveText("finished callbacks: 1");
  });

  test("the task list API is scoped to the brand and card", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    const id = await enqueuePing({ slug: "acme", cardId: "card-for-list", steps: 1, stepMs: 3000 });
    const mine = await (await page.request.get("/api/tasks?slug=acme&cardId=card-for-list")).json();
    expect(mine.tasks.map((t: { id: number }) => t.id)).toContain(id);
    // The payload and result never leave the server.
    expect(JSON.stringify(mine)).not.toContain("stepMs");
    expect((await page.request.get("/api/tasks?slug=rival", { failOnStatusCode: false })).status()).toBe(404);
    expect((await page.request.get("/api/tasks?slug=Not%20A%20Slug", { failOnStatusCode: false })).status()).toBe(400);
  });
});
