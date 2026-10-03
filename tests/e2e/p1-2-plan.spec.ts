import { expect, type Page, test } from "@playwright/test";
import { CARDS, expectNoHorizontalScroll, resetFixture, shot, signInAndOpenCalendar, sql, startSessions } from "./helpers";

/**
 * P1.2 Plan (plan/ui-ux-full-flow.md §4, §8): the plan list, the card review
 * screen, the jobs behind them (against the stub providers), the paste-a-link
 * flow and the founder's Sources screen.
 */

const post = (page: Page, path: string, data: unknown) => page.request.post(path, { data, failOnStatusCode: false });
const card = (action: string, extra: Record<string, unknown> = {}) => ({ action, ...extra });
const cardApi = (id: string) => `/api/brands/acme/cards/${id}`;

test.beforeEach(async () => {
  // Every test here changes data, and a reset gives users new ids.
  await resetFixture();
  await startSessions();
});

const openPlan = async (page: Page, user: "member" | "founder" | "outsider" = "member") => {
  await signInAndOpenCalendar(page, user);
  await page.goto("/plan");
};
const openCard = async (page: Page, id: string, user: "member" | "founder" | "outsider" = "member") => {
  await signInAndOpenCalendar(page, user);
  await page.goto(`/plan/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
};

test.describe("the plan list", () => {
  test("shows every day with its angle, hook and status", async ({ page }, info) => {
    await openPlan(page);
    await expect(page.getByRole("heading", { name: "Plan", level: 1 })).toBeVisible();
    await expect(page.locator("[data-card-id]")).toHaveCount(5);
    const draft = page.locator(`[data-card-id="${CARDS.draft}"]`);
    await expect(draft).toContainText("Day 1");
    await expect(draft).toContainText("Fri, Oct 9");
    await expect(draft).toContainText(`angle for ${CARDS.draft}`);
    await expect(draft).toContainText(`Hook words for ${CARDS.draft}.`);
    await expect(draft).toContainText("Draft");
    await expect(page.locator(`[data-card-id="${CARDS.approved}"]`)).toContainText("Queued for production");
    // The internal review gate stays hidden from a customer.
    await expect(page.locator(`[data-card-id="${CARDS.inReview}"]`)).toContainText("Generating");
    await expect(page.locator("body")).not.toContainText(/internal review/i);
    await expect(page.getByText(/4 of 5 approved/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve 1 draft" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.2", "plan-list");
  });

  test("a row opens that day's review", async ({ page }) => {
    await openPlan(page);
    await page.locator(`[data-card-id="${CARDS.draft}"] a`).click();
    await expect(page).toHaveURL(new RegExp(`/plan/${CARDS.draft}$`));
    await expect(page.getByRole("heading", { name: "Day 1", level: 1 })).toBeVisible();
  });

  test("approve-all approves the drafts and says what it did", async ({ page }) => {
    await openPlan(page);
    await page.getByRole("button", { name: "Approve 1 draft" }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 approved" })).toBeVisible();
    await expect(page.locator(`[data-card-id="${CARDS.draft}"]`)).toContainText("Queued for production");
    await expect(page.getByRole("button", { name: "Nothing to approve" })).toBeDisabled();
  });

  test("a brand with no plan says so, and offers the founder a way to build one", async ({ page }) => {
    await openPlan(page, "outsider");
    await expect(page.getByText("Your plan is being built")).toBeVisible();
    await expect(page.getByRole("button", { name: /Build the 14-day plan/ })).toHaveCount(0);
  });
});

test.describe("reviewing a video", () => {
  test("shows the original, the original lines, your lines and the shots", async ({ page }, info) => {
    await openCard(page, CARDS.draft);
    await expect(page.getByText("Why the original works")).toBeVisible();
    await expect(page.locator("video")).toHaveAttribute("src", /\/api\/media\/brands\/acme\/sources\/src-card-draft\.mp4/);
    await expect(page.locator("[data-line]")).toHaveCount(3);
    await expect(page.locator("#line-0")).toHaveValue(`Hook words for ${CARDS.draft}.`);
    await expect(page.locator("[data-line='0']")).toContainText("Here is the thing nobody tells you.");
    await expect(page.getByRole("button", { name: "Play the original from 0:03" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Shots" })).toBeVisible();
    await expect(page.locator("#shots-title ~ ul li, section[aria-labelledby='shots-title'] ul li")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Generate storyboard" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.2", "card-detail");
  });

  test("editing a line and saving keeps it, and blocks approval until saved", async ({ page }) => {
    await openCard(page, CARDS.draft);
    const save = page.getByRole("button", { name: "Save changes" });
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(save).toBeDisabled();
    await expect(approve).toBeEnabled();

    await page.locator("#line-1").fill("A brand new middle line that I wrote myself.");
    await expect(save).toBeEnabled();
    await expect(approve).toBeDisabled();
    await expect(page.getByText("Save your changes before approving.")).toBeVisible();

    await save.click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(approve).toBeEnabled();
    await page.reload();
    await expect(page.locator("#line-1")).toHaveValue("A brand new middle line that I wrote myself.");
  });

  test("discarding puts the saved words back", async ({ page }) => {
    await openCard(page, CARDS.draft);
    await page.locator("#line-0").fill("Something I will not keep.");
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.locator("#line-0")).toHaveValue(`Hook words for ${CARDS.draft}.`);
  });

  test("an empty line cannot be saved and the reason is shown", async ({ page }) => {
    await openCard(page, CARDS.draft);
    await page.locator("#line-2").fill("   ");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "cannot be empty" })).toBeVisible();
    await page.reload();
    await expect(page.locator("#line-2")).toHaveValue(`Closing words for ${CARDS.draft}.`);
  });

  test("a line far from the original's length gets a plain warning", async ({ page }) => {
    await openCard(page, CARDS.draft);
    await page.locator("#line-0").fill("This is a very long replacement for a short opening line that keeps going well past what the original shot could ever hold.");
    await expect(page.locator("#hint-0")).toContainText("Longer than the original");
    await page.locator("#line-0").fill("Short.");
    await expect(page.locator("#hint-0")).toContainText("Shorter than the original");
    await page.locator("#line-0").fill("Here is what you really need to know.");
    await expect(page.locator("#hint-0")).toHaveCount(0);
  });

  test("a rewrite with a note shows progress, then the new script", async ({ page }, info) => {
    await openCard(page, CARDS.draft);
    await page.getByLabel(/What should change/).fill("make it punchier");
    await page.getByRole("button", { name: "Rewrite script" }).click();
    await expect(page.getByRole("status").first()).toBeVisible();
    await shot(page, info, "p1.2", "card-rewriting");
    await expect(page.locator("#line-0")).toHaveValue(/make it punchier/, { timeout: 15_000 });
  });

  test("a rewrite is refused while you have unsaved edits", async ({ page }) => {
    await openCard(page, CARDS.draft);
    await page.locator("#line-0").fill("Unsaved words");
    await expect(page.getByRole("button", { name: "Rewrite script" })).toBeDisabled();
    await expect(page.getByText(/Save or discard your edits first/)).toBeVisible();
  });

  test("generating a storyboard shows progress and then a picture per shot", async ({ page }, info) => {
    await openCard(page, CARDS.draft);
    await page.getByRole("button", { name: "Generate storyboard" }).click();
    await expect(page.getByRole("status").first()).toBeVisible();
    await expect(page.getByAltText(/Storyboard for s0/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByAltText(/Storyboard for/)).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Generate storyboard" })).toHaveCount(0);
    await shot(page, info, "p1.2", "card-storyboard");
  });

  test("switching to another video writes a new script and clears the storyboard", async ({ page }) => {
    await openCard(page, CARDS.draft);
    await page.getByRole("button", { name: "Generate storyboard" }).click();
    await expect(page.getByAltText(/Storyboard for/)).toHaveCount(3, { timeout: 15_000 });

    await page.locator("#swap-source").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Switch video" }).click();
    await expect(page.getByAltText(/Original frame of/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByAltText(/Storyboard for/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Generate storyboard" })).toBeVisible();
  });

  test("approving locks the words, unapproving unlocks them", async ({ page }, info) => {
    await openCard(page, CARDS.draft);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Queued for production").first()).toBeVisible();
    await expect(page.locator("#line-0")).toBeDisabled();
    await expect(page.getByText(/approved and queued for production/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Rewrite script" })).toHaveCount(0);
    await shot(page, info, "p1.2", "card-approved");

    await page.getByRole("button", { name: "Unapprove" }).click();
    await expect(page.locator("#line-0")).toBeEnabled();
    await expect(page.getByText("Draft").first()).toBeVisible();
  });

  test("the arrow keys move between days, but not while typing", async ({ page }) => {
    await openCard(page, CARDS.draft);
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(new RegExp(`/plan/${CARDS.approved}$`));
    await page.keyboard.press("ArrowLeft");
    await expect(page).toHaveURL(new RegExp(`/plan/${CARDS.draft}$`));
    await page.locator("#line-0").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(new RegExp(`/plan/${CARDS.draft}$`));
  });

  test("an approved video is read-only", async ({ page }) => {
    await openCard(page, CARDS.approved);
    await expect(page.locator("#line-0")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unapprove" })).toBeVisible();
  });

  test("a video the customer has not been sent shows no editing at all", async ({ page }) => {
    await openCard(page, CARDS.inReview);
    await expect(page.getByText("Generating").first()).toBeVisible();
    await expect(page.locator("#line-0")).toBeDisabled();
  });
});

test.describe("rules the server enforces", () => {
  test("an approved card cannot be edited, rewritten or swapped", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    const lines = { lines: [{ index: 0, text: "sneaky edit" }] };
    expect((await page.request.put(`${cardApi(CARDS.approved)}/script`, { data: lines, failOnStatusCode: false })).status()).toBe(409);
    expect((await post(page, cardApi(CARDS.approved), card("rewrite"))).status()).toBe(409);
    expect((await post(page, cardApi(CARDS.approved), card("swap", { sourceId: `src-${CARDS.draft}` }))).status()).toBe(409);
  });

  test("the card status rules are applied", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    expect((await post(page, cardApi(CARDS.review), card("approve"))).status()).toBe(409); // not a draft
    expect((await post(page, cardApi(CARDS.draft), card("unapprove"))).status()).toBe(409); // not approved
    expect((await post(page, cardApi(CARDS.draft), card("approve"))).status()).toBe(200);
    expect((await post(page, cardApi(CARDS.draft), card("approve"))).status()).toBe(409); // already
  });

  test("a card cannot be approved while its script is being written", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    expect((await post(page, cardApi(CARDS.draft), card("rewrite"))).status()).toBe(200);
    const res = await post(page, cardApi(CARDS.draft), card("approve"));
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/still being written/);
  });

  test("bad requests are refused with a reason, not a crash", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    expect((await post(page, cardApi(CARDS.draft), { action: "explode" })).status()).toBe(400);
    expect((await post(page, cardApi(CARDS.draft), {})).status()).toBe(400);
    expect((await post(page, cardApi("no-such-card"), card("approve"))).status()).toBe(404);
    expect((await post(page, cardApi(CARDS.draft), card("swap", { sourceId: "not-in-the-pool" }))).status()).toBe(409);
    const tooLong = { lines: [{ index: 0, text: "x".repeat(401) }] };
    expect((await page.request.put(`${cardApi(CARDS.draft)}/script`, { data: tooLong, failOnStatusCode: false })).status()).toBe(400);
    expect((await page.request.put(`${cardApi(CARDS.draft)}/script`, { data: { lines: [{ index: 9, text: "nope" }] }, failOnStatusCode: false })).status()).toBe(409);
  });

  test("one brand cannot touch another's cards, and a customer cannot build a plan", async ({ page }) => {
    await signInAndOpenCalendar(page, "outsider");
    expect((await post(page, cardApi(CARDS.draft), card("approve"))).status()).toBe(404); // Acme's card, Rival's member
    expect((await post(page, "/api/brands/rival/sources", { url: "https://www.instagram.com/reel/XYZ/" })).status()).toBe(200);
    expect((await post(page, "/api/admin/brands/rival/plan", {})).status()).toBe(404);
    expect((await page.goto(`/plan/${CARDS.draft}`))?.status()).toBe(404);
  });
});

test.describe("adding a viral video", () => {
  test("a link that is not allowed is refused with the reason, and nothing is queued", async ({ page }) => {
    await openPlan(page);
    for (const bad of ["not a link", "http://169.254.169.254/latest/meta-data/", "https://evil.example/reel/abc/", "https://www.instagram.com/someprofile/"]) {
      const res = await post(page, "/api/brands/acme/sources", { url: bad });
      expect(res.status(), bad).toBe(400);
      expect((await res.json()).error).toMatch(/link|Paste/i);
    }
    expect(await sql(`select 1 from work_queue where kind = 'source.ingest'`)).toHaveLength(0);
    await page.getByLabel("Link").fill("https://www.instagram.com/someprofile/");
    await page.getByRole("button", { name: "Add video" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Instagram reel, a TikTok video or a YouTube Short/ })).toBeVisible();
  });

  test("a good link is downloaded and analysed, with progress shown", async ({ page }, info) => {
    await openPlan(page);
    await page.getByLabel("Link").fill("https://www.instagram.com/reel/NEW123/?igsh=tracking");
    await page.getByRole("button", { name: "Add video" }).click();
    await expect(page.getByRole("status").first()).toBeVisible();
    await shot(page, info, "p1.2", "adding-video");
    await expect(page.getByRole("status").first()).toHaveAttribute("data-task-status", "done", { timeout: 15_000 });
    expect((await page.request.get("/api/media/brands/acme/sources/NEW123-sheet.jpg")).status()).toBe(200);
  });

  test("the same link twice does not start two downloads", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    const url = "https://www.instagram.com/reel/DUP999/";
    const first = await (await post(page, "/api/brands/acme/sources", { url })).json();
    const second = await (await post(page, "/api/brands/acme/sources", { url })).json();
    expect(first.taskId).not.toBeNull();
    expect(second.taskId).toBeNull();
    expect(await sql(`select 1 from work_queue where kind = 'source.ingest' and payload->>'url' like '%DUP999%'`)).toHaveLength(1);
  });
});

test.describe("the founder's tools", () => {
  test("the sources screen lists the pool, how each is built, and where it is used", async ({ page }, info) => {
    await signInAndOpenCalendar(page, "founder");
    await page.goto("/admin/sources");
    await expect(page.getByRole("heading", { name: "Viral videos", level: 1 })).toBeVisible();
    await expect(page.locator("[data-source-id]")).toHaveCount(5);
    const first = page.locator(`[data-source-id="src-${CARDS.draft}"]`);
    await expect(first).toContainText(`Topic of src-${CARDS.draft}`);
    await expect(first).toContainText("Used on day 1");
    await first.locator("summary").click();
    await expect(first.getByText("Why it works")).toBeVisible();
    await expect(first.getByText("s1")).toBeVisible();
    await shot(page, info, "p1.2", "admin-sources");
  });

  test("a customer is turned away from the sources screen", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    expect((await page.goto("/admin/sources"))?.status()).toBe(404);
  });

  test("the founder builds a whole plan for a brand that has none", async ({ page }, info) => {
    test.setTimeout(90_000);
    await signInAndOpenCalendar(page, "founder");
    expect((await page.request.post("/api/active-brand", { data: { slug: "rival" } })).ok()).toBe(true);

    // No viral videos yet: the plan cannot be built, and says why.
    await page.goto("/plan");
    await expect(page.getByText("Add a few viral videos below")).toBeVisible();
    for (const id of ["AAA111", "BBB222", "CCC333"]) {
      expect((await post(page, "/api/brands/rival/sources", { url: `https://www.instagram.com/reel/${id}/` })).status()).toBe(200);
    }
    await expect.poll(async () => (await sql(`select 1 from work_queue where kind = 'source.ingest' and status = 'done'`)).length, { timeout: 30_000 }).toBe(3);

    await page.goto("/plan");
    await page.getByRole("button", { name: "Build the 14-day plan" }).click();
    await expect(page.locator("[data-card-id]")).toHaveCount(14, { timeout: 30_000 });
    // Every card gets its script, one job each.
    await expect(page.getByText("No script yet.")).toHaveCount(0, { timeout: 45_000 });
    await expect(page.getByText("The script is being written.")).toHaveCount(0, { timeout: 45_000 });
    await expect(page.locator("[data-card-id]").first()).toContainText("Day 1");
    await expect(page.locator("[data-card-id]").nth(13)).toContainText("Day 14");
    await shot(page, info, "p1.2", "plan-built");

    // Each day offers a different format from the one before it.
    const sources = await sql(`select payload->>'cardId' as card from work_queue where kind = 'card.adapt'`);
    const ids = sources.map((r) => String(r.card));
    expect(ids).toHaveLength(14);
    const byDay = [...ids].sort((a, b) => Number(a.split("-d")[1]) - Number(b.split("-d")[1])).map((id) => id.split("-d")[0]);
    for (let i = 1; i < byDay.length; i++) expect(byDay[i], `day ${i + 1} repeats day ${i}`).not.toBe(byDay[i - 1]);
    expect(new Set(byDay).size).toBe(3);

    // And the brand's own member sees the same plan.
    await page.context().clearCookies();
    await signInAndOpenCalendar(page, "outsider");
    await page.goto("/plan");
    await expect(page.locator("[data-card-id]")).toHaveCount(14);
  });
});

test.describe("on a phone", () => {
  test("the list and the review fit the screen and stay usable", async ({ page }, info) => {
    test.skip((page.viewportSize()?.width ?? 1440) >= 768, "phone only");
    await openPlan(page);
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.2", "phone-plan");
    await page.locator(`[data-card-id="${CARDS.draft}"] a`).click();
    await expect(page.locator("#line-0")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.2", "phone-card");
    await page.locator("#line-0").fill("Edited on a phone.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  });
});
