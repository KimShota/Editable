import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { STORAGE_ROOT } from "./env";
import { CARDS, expectNoHorizontalScroll, resetFixture, shot, signInAndOpenCalendar, startSessions } from "./helpers";

/**
 * P1.4 Calendar (plan/ui-ux-full-flow.md §6): the cycle on a Monday-to-Sunday
 * grid, what each day shows and where it leads, approve-all, manual posting,
 * and the phone's day list. "Today" is fixed to Monday Oct 12 (day 4) by
 * KATALAB_NOW; the plan starts on Friday Oct 9.
 */

test.beforeEach(async () => {
  await resetFixture();
  await startSessions();
});

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) < 768;
const cell = (page: Page, id: string) => page.locator(`[data-card-id="${id}"]`);

/** Edits a card in plan.json directly (the app reads the file on every request). */
const patchCard = (id: string, patch: Record<string, unknown>) => {
  const file = path.join(STORAGE_ROOT, "brands/acme/plan.json");
  const plan = JSON.parse(fs.readFileSync(file, "utf8")) as { cards: { id: string }[] };
  plan.cards = plan.cards.map((c) => (c.id === id ? { ...c, ...patch } : c));
  fs.writeFileSync(file, JSON.stringify(plan));
};

const open = async (page: Page, user: "member" | "founder" | "outsider" = "member") => signInAndOpenCalendar(page, user);

test.describe("the cycle on a calendar", () => {
  test("lays the 14 days on a Monday to Sunday grid that starts on the right weekday", async ({ page }, info) => {
    test.skip(isPhone(page), "the grid is the desktop layout");
    await open(page);
    await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
    await expect(page.getByText("Cycle c1, Oct 9 to Oct 22")).toBeVisible();
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) await expect(page.getByText(d, { exact: true }).first()).toBeAttached();

    const items = page.locator('ol[aria-label="Your videos by day"] > li');
    await expect(items).toHaveCount(21); // three week-rows of seven
    for (let i = 0; i < 4; i++) await expect(items.nth(i)).toHaveAttribute("aria-hidden", "true"); // Mon to Thu before the start
    await expect(items.nth(4)).toHaveAttribute("data-day", "1"); // Friday
    await expect(items.nth(16)).toHaveAttribute("data-day", "13");
    await expect(items.nth(17)).toHaveAttribute("data-day", "14"); // a Thursday
    for (let i = 18; i < 21; i++) await expect(items.nth(i)).toHaveAttribute("aria-hidden", "true");
    expect(await page.locator("[data-day]").count()).toBe(14);

    // The four columns line up: Friday's day 1 sits above day 8.
    const x1 = (await items.nth(4).boundingBox())!.x;
    const x8 = (await items.nth(11).boundingBox())!.x;
    expect(Math.abs(x1 - x8)).toBeLessThan(2);
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.4", "calendar-grid");
  });

  test("days with no video yet say so, and the plan's five cards are where they belong", async ({ page }) => {
    await open(page);
    await expect(page.getByText("Nothing planned yet")).toHaveCount(9); // days 6 to 14
    const day = (n: number) => page.locator(`[data-day="${n}"]`);
    await expect(day(1)).toContainText("Fri, Oct 9");
    await expect(day(5)).toContainText("Tue, Oct 13");
    await expect(day(5)).toHaveAttribute("data-card-id", CARDS.ready);
  });

  test("shows how far along the cycle is and when the next plan comes", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("cycle-progress-label")).toHaveText("1 of 14 ready");
    await expect(page.getByRole("progressbar", { name: "Videos ready this cycle" })).toHaveAttribute("aria-valuenow", "1");
    await expect(page.getByTestId("cycle-countdown")).toHaveText("Next plan in 7 days");
  });

  test("marks today, once", async ({ page }) => {
    await open(page);
    await expect(page.getByText("Today", { exact: true })).toHaveCount(1);
    await expect(cell(page, CARDS.review)).toContainText("Today");
  });

  test("each day shows something to look at, and never a video the customer may not see", async ({ page }) => {
    await open(page);
    await expect(cell(page, CARDS.draft).locator("img")).toHaveCount(1); // a frame of the original
    await expect(cell(page, CARDS.review).locator("video")).toHaveCount(1);
    await expect(cell(page, CARDS.ready).locator("video")).toHaveCount(1);
    await expect(cell(page, CARDS.inReview).locator("video")).toHaveCount(0); // behind the review gate
    await expect(cell(page, CARDS.review).locator("video")).toHaveAttribute("src", /\/api\/media\/brands\/acme\/videos\/card-review\/final\.mp4#t=0\.5/);
    await expect(page.locator(`[data-card-id="${CARDS.inReview}"] video`)).toHaveCount(0);
  });

  test("a day leads to the plan before there is a video, and to the editor after", async ({ page }) => {
    await open(page);
    const link = (id: string) => cell(page, id).getByRole("link").first();
    await expect(link(CARDS.draft)).toHaveAttribute("href", `/plan/${CARDS.draft}`);
    await expect(link(CARDS.approved)).toHaveAttribute("href", `/plan/${CARDS.approved}`);
    await expect(link(CARDS.inReview)).toHaveAttribute("href", `/plan/${CARDS.inReview}`); // not theirs to open yet
    await expect(link(CARDS.review)).toHaveAttribute("href", `/videos/${CARDS.review}/edit`);
    await expect(link(CARDS.ready)).toHaveAttribute("href", `/videos/${CARDS.ready}/edit`);
    await link(CARDS.draft).click();
    await expect(page).toHaveURL(new RegExp(`/plan/${CARDS.draft}$`));
  });

  test("the founder's calendar leads to the video behind the gate", async ({ page }) => {
    await open(page, "founder");
    await expect(cell(page, CARDS.inReview).getByRole("link").first()).toHaveAttribute("href", `/videos/${CARDS.inReview}/edit`);
    await expect(cell(page, CARDS.inReview).locator("video")).toHaveCount(1);
  });

  test("a brand with no plan says so", async ({ page }) => {
    await open(page, "outsider");
    await expect(page.getByText("Your plan is being built")).toBeVisible();
    await expect(page.locator("[data-day]")).toHaveCount(0);
  });
});

test.describe("approve all remaining", () => {
  test("lists what it will approve, then approves it and updates the cycle", async ({ page }, info) => {
    await open(page);
    const trigger = page.getByRole("button", { name: "Approve all remaining (1)" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Approve these videos?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("list", { name: "Videos to approve" }).getByRole("listitem")).toHaveCount(1);
    await expect(dialog).toContainText("Day 4, Oct 12");
    await shot(page, info, "p1.4", "approve-all-dialog");

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await dialog.getByRole("button", { name: "Approve 1", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 approved" })).toBeVisible();
    await expect(cell(page, CARDS.review)).toContainText("Ready to post");
    await expect(page.getByTestId("cycle-progress-label")).toHaveText("2 of 14 ready");
    await expect(page.getByRole("button", { name: "Nothing to approve" })).toBeDisabled();
  });

  test("holds back a flagged video unless asked", async ({ page }) => {
    patchCard(CARDS.review, { lowConfidence: true });
    await open(page);
    await expect(cell(page, CARDS.review).getByText("Low confidence")).toBeAttached();
    await page.getByRole("button", { name: "Approve all remaining (1)" }).click();
    const dialog = page.getByRole("dialog", { name: "Approve these videos?" });
    await expect(dialog.getByText("Held back")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Approve 0" })).toBeDisabled();
    await dialog.getByLabel(/Include the 1 flagged video/).check();
    await expect(dialog.getByText("Flagged", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Approve 1", exact: true }).click();
    await expect(cell(page, CARDS.review)).toContainText("Ready to post");
  });

  test("the API holds flagged videos back too, and says why", async ({ page }) => {
    patchCard(CARDS.review, { lowConfidence: true });
    await open(page);
    const res = await (await page.request.post("/api/brands/acme/videos/approve-all", { data: {} })).json();
    expect(res.approved).toEqual([]);
    expect(res.skipped).toEqual([{ cardId: CARDS.review, reason: "flagged" }]);
    const again = await (await page.request.post("/api/brands/acme/videos/approve-all", { data: { includeFlagged: true } })).json();
    expect(again.approved).toEqual([CARDS.review]);
  });

  test("only approves videos waiting for review, never drafts or hidden ones", async ({ page }) => {
    await open(page);
    await page.request.post("/api/brands/acme/videos/approve-all", { data: {} });
    const plan = JSON.parse(fs.readFileSync(path.join(STORAGE_ROOT, "brands/acme/plan.json"), "utf8")) as { cards: { id: string; status: string }[] };
    const status = Object.fromEntries(plan.cards.map((c) => [c.id, c.status]));
    expect(status[CARDS.draft]).toBe("draft");
    expect(status[CARDS.approved]).toBe("approved");
    expect(status[CARDS.inReview]).toBe("internal_review");
    expect(status[CARDS.review]).toBe("ready");
  });

  test("another brand's member cannot approve this brand's videos", async ({ page }) => {
    await open(page, "outsider");
    expect((await page.request.post("/api/brands/acme/videos/approve-all", { data: {}, failOnStatusCode: false })).status()).toBe(404);
  });
});

test.describe("posting by hand", () => {
  test("a ready video offers download, copy and mark as posted; others do not", async ({ page }) => {
    await open(page);
    const ready = cell(page, CARDS.ready);
    await expect(ready.getByRole("link", { name: "Download the day 5 video" })).toHaveAttribute("href", /\/api\/media\/brands\/acme\/videos\/card-ready\/final\.mp4/);
    await expect(ready.getByRole("button", { name: "Copy the day 5 caption" })).toBeVisible();
    for (const id of [CARDS.draft, CARDS.approved, CARDS.inReview, CARDS.review]) await expect(cell(page, id).getByRole("button", { name: /Mark the day .* video as posted/ })).toHaveCount(0);
  });

  test("copies the caption and hashtags", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page);
    await cell(page, CARDS.ready).getByRole("button", { name: "Copy the day 5 caption" }).click();
    await expect(cell(page, CARDS.ready).getByRole("status")).toHaveText("Copied.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("A caption for the post.\n\n#ai #tips");
  });

  test("marking as posted needs real links, and the day then shows as posted", async ({ page }, info) => {
    await open(page);
    const ready = cell(page, CARDS.ready);
    const trigger = ready.getByRole("button", { name: "Mark the day 5 video as posted" });
    await trigger.click();
    const group = ready.getByRole("group", { name: /Where was the day 5 video posted/ });
    await expect(group.getByRole("button", { name: "Save" })).toBeDisabled();
    await shot(page, info, "p1.4", "mark-posted");

    await page.keyboard.press("Escape");
    await expect(group).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await group.getByLabel("Where did you post it?").fill("not a link");
    await group.getByRole("button", { name: "Save" }).click();
    await expect(ready.getByRole("alert").filter({ hasText: /Paste the full link/ })).toBeVisible();

    await group.getByLabel("Where did you post it?").fill("https://www.tiktok.com/@acme/video/99");
    await group.getByRole("button", { name: "Save" }).click();
    await expect(ready).toContainText("Posted");
    await expect(ready.getByRole("link", { name: "View the post" })).toHaveAttribute("href", "https://www.tiktok.com/@acme/video/99");
    await expect(ready.getByRole("button", { name: /Mark the day 5/ })).toHaveCount(0);
    await expect(page.getByTestId("cycle-progress-label")).toHaveText("1 of 14 ready"); // posted still counts
  });
});

test.describe("messages", () => {
  test("says posting for you is not available yet, once, and remembers it was dismissed", async ({ page }) => {
    await open(page);
    const note = page.getByRole("note");
    await expect(note).toContainText("coming soon");
    await note.getByRole("button", { name: "Dismiss this message" }).click();
    await expect(note).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();
    await expect(page.getByRole("note")).toHaveCount(0);
  });

  test("still works when the browser will not store anything", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { get: () => { throw new Error("blocked"); } });
    });
    await open(page);
    const note = page.getByRole("note");
    await expect(note).toBeVisible();
    await note.getByRole("button", { name: "Dismiss this message" }).click();
    await expect(note).toHaveCount(0);
  });

  test("thanks a customer who sent a video back", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    await page.goto("/calendar?sent-back=1");
    await expect(page.getByText("We will look at that video")).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test("is a list of days with today first, and no empty grid cells", async ({ page }, info) => {
    test.skip(!isPhone(page), "phone only");
    await open(page);
    const items = page.locator('ol[aria-label="Your videos by day"] > li:visible');
    await expect(items).toHaveCount(14); // outside cells are not shown
    // Today is pinned first by CSS order, so check where it is drawn, not where it is in the DOM.
    const top = async (day: number) => (await page.locator(`[data-day="${day}"]`).boundingBox())!.y;
    expect(await top(4)).toBeLessThan(await top(1));
    expect(await top(4)).toBeLessThan(await top(2));
    await expect(page.locator('[data-day="4"]')).toContainText("Today");
    // The rest keep their order.
    expect(await top(1)).toBeLessThan(await top(2));
    expect(await top(2)).toBeLessThan(await top(14));
    await expect(page.locator('li[aria-hidden="true"]:visible')).toHaveCount(0);
    await expect(page.getByText("Mon", { exact: true }).first()).toBeHidden(); // no weekday header
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.4", "phone-calendar");
  });

  test("the controls are reachable and fit", async ({ page }) => {
    test.skip(!isPhone(page), "phone only");
    await open(page);
    await expect(page.getByRole("button", { name: "Approve all remaining (1)" })).toBeVisible();
    await page.getByRole("button", { name: "Approve all remaining (1)" }).click();
    await expect(page.getByRole("dialog", { name: "Approve these videos?" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(cell(page, CARDS.ready).getByRole("button", { name: "Mark the day 5 video as posted" })).toBeVisible();
  });
});
