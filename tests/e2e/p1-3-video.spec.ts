import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { STORAGE_ROOT } from "./env";
import { CARDS, expectNoHorizontalScroll, resetFixture, shot, signInAndOpenCalendar, sql, startSessions } from "./helpers";

/**
 * P1.3 Video (plan/ui-ux-full-flow.md §5, §8): the founder's production queue
 * and review gate, the editor for a brand's video, and what a customer can do
 * with it. Production runs against the stub producer (real, tiny videos).
 */

test.beforeEach(async () => {
  await resetFixture();
  await startSessions();
});

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) < 768;
const outbox = (): { to: string; subject: string; html: string }[] => {
  const file = path.join(STORAGE_ROOT, "outbox.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const asMember = (page: Page) => signInAndOpenCalendar(page, "member");
const asFounder = (page: Page) => signInAndOpenCalendar(page, "founder");
const editor = (id: string) => `/videos/${id}/edit`;

test.describe("the review gate", () => {
  test("a customer cannot reach a video that is still with the founder, by page or by URL", async ({ page }) => {
    await asMember(page);
    const hidden = CARDS.inReview;
    expect((await page.goto(editor(hidden)))?.status()).toBe(404);
    // Card ids are visible in the plan, so the files must be refused too.
    for (const url of [
      `/api/media/brands/acme/videos/${hidden}/final.mp4`,
      `/api/jobs/acme-${hidden}/edl`,
      `/jobs/acme-${hidden}/generated/clips/s0.mp4`,
      `/api/media/brands/acme/videos/${hidden}/clips/s0.mp4`,
    ]) {
      const res = await page.request.get(url, { failOnStatusCode: false });
      expect(res.status(), url).toBe(404);
    }
    // The same files for a video they have been sent are theirs.
    expect((await page.request.get(`/api/media/brands/acme/videos/${CARDS.review}/final.mp4`)).status()).toBe(200);
    expect((await page.request.get(`/api/jobs/acme-${CARDS.review}/edl`)).status()).toBe(200);
  });

  test("the card page shows the video being made, with the staged bar, then the finished state", async ({ page }, info) => {
    test.setTimeout(90_000);
    await asFounder(page);
    // Warm the route first: the dev server compiles a page the first time it is asked for.
    await page.goto(`/plan/${CARDS.approved}`);
    const priced = await page.request.post(`/api/admin/brands/acme/cards/${CARDS.approved}/estimate`, { data: {} });
    expect(priced.ok()).toBe(true);
    await expect.poll(async () => (await (await page.request.get("/api/tasks?slug=acme&cardId=" + CARDS.approved)).json()).tasks.length, { timeout: 20_000 }).toBe(0);
    expect((await page.request.post(`/api/admin/brands/acme/cards/${CARDS.approved}/release`, { data: {} })).ok()).toBe(true);

    await page.goto(`/plan/${CARDS.approved}`);
    const bar = page.getByRole("status").filter({ hasText: "Making your video" });
    await expect(bar).toBeVisible();
    const steps = bar.getByRole("list", { name: "Steps" }).getByRole("listitem");
    await expect(steps).toHaveText([/Voice/, /Clips/, /Finishing/]);
    await expect(bar.getByRole("progressbar")).toHaveAttribute("aria-valuenow", /^\d+$/);
    await expect(bar.locator("[data-step=current]")).toHaveCount(1);
    await expect(page.getByText("Being made", { exact: true })).toBeVisible();
    await expect(page.getByText("Writing in progress")).toHaveCount(0);
    await shot(page, info, "p1.3", "card-making");

    if (isPhone(page)) {
      // The editor is built for a wide screen, so a phone stays where it is: the bar is replaced by the finished state.
      await expect(page.getByRole("status").filter({ hasText: "Making your video" })).toHaveCount(0, { timeout: 40_000 });
      await expect(page.getByText("Internal review", { exact: true }).first()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/plan/${CARDS.approved}$`));
      await expect(page.getByRole("link", { name: "Open the video" })).toBeVisible();
    } else {
      // A video the founder watched being made opens in the editor as soon as it is done.
      await expect(page).toHaveURL(new RegExp(`/videos/${CARDS.approved}/edit$`), { timeout: 40_000 });
    }
  });

  test("the card page links to the video once there is one this person may open", async ({ page }) => {
    // Founder: from internal review. Customer: only once it has been sent to them.
    await asFounder(page);
    await page.goto(`/plan/${CARDS.inReview}`);
    await expect(page.getByRole("link", { name: "Open the video" })).toHaveAttribute("href", `/videos/${CARDS.inReview}/edit`);
    await page.goto(`/plan/${CARDS.draft}`);
    await expect(page.getByRole("link", { name: "Open the video" })).toHaveCount(0);
    await page.context().clearCookies();

    await asMember(page);
    await page.goto(`/plan/${CARDS.review}`);
    await expect(page.getByRole("link", { name: "Open the video" })).toHaveAttribute("href", `/videos/${CARDS.review}/edit`);
    await page.goto(`/plan/${CARDS.inReview}`);
    await expect(page.getByRole("link", { name: "Open the video" })).toHaveCount(0); // behind the gate: not theirs yet
  });

  test("a customer cannot act on a video behind the gate, or release anything", async ({ page }) => {
    await asMember(page);
    const video = (id: string, data: unknown) => page.request.post(`/api/brands/acme/cards/${id}/video`, { data, failOnStatusCode: false });
    expect((await video(CARDS.inReview, { action: "approve" })).status()).toBe(404);
    expect((await video(CARDS.draft, { action: "approve" })).status()).toBe(404); // no video yet
    expect((await video(CARDS.review, { action: "mark_posted", urls: ["https://www.tiktok.com/@x/video/1"] })).status()).toBe(409); // not approved yet
    for (const path of [`/api/admin/brands/acme/cards/${CARDS.approved}/release`, `/api/admin/brands/acme/cards/${CARDS.approved}/estimate`, "/api/admin/brands/acme/send"]) {
      expect((await page.request.post(path, { data: {}, failOnStatusCode: false })).status(), path).toBe(404);
    }
    expect((await page.goto("/admin/production"))?.status()).toBe(404);
    expect((await page.goto("/admin/review"))?.status()).toBe(404);
  });

  test("the founder can open any video", async ({ page }) => {
    await asFounder(page);
    await page.goto(editor(CARDS.inReview));
    await expect(page.getByText("AI video").first()).toBeVisible();
    expect((await page.request.get(`/api/media/brands/acme/videos/${CARDS.inReview}/final.mp4`)).status()).toBe(200);
  });
});

test.describe("from approval to the customer's calendar", () => {
  test("the founder prices, releases, reviews and sends a video, and the customer is emailed once", async ({ page }, info) => {
    test.skip(isPhone(page), "the editor is desktop-only; the admin screens are covered at phone width below");
    test.setTimeout(90_000);
    await asFounder(page);
    await page.goto("/admin/production");
    await expect(page.getByRole("heading", { name: "Production", level: 1 })).toBeVisible();

    const row = page.locator(`[data-card-id="${CARDS.approved}"]`);
    await expect(row).toContainText("Approved");
    await expect(row.getByTestId("estimate")).toHaveText("not priced");
    await expect(row.getByRole("button", { name: "Release" })).toHaveCount(0); // price it first
    await shot(page, info, "p1.3", "production-queue");

    await row.getByRole("button", { name: "Get estimate" }).click();
    await expect(row.getByTestId("estimate")).toHaveText("$12.50", { timeout: 20_000 });
    await expect(row).toContainText("up to $18.00 with retries");

    // Releasing spends money, so it asks first and names the most it can cost.
    await row.getByRole("button", { name: "Release" }).click();
    await expect(row.getByRole("button", { name: "Spend up to $18.00" })).toBeVisible();
    await row.getByRole("button", { name: "Cancel" }).click();
    await expect(row.getByRole("button", { name: "Release" })).toBeVisible();
    await row.getByRole("button", { name: "Release" }).click();
    await row.getByRole("button", { name: "Spend up to $18.00" }).click();

    await expect(row.getByRole("status").first()).toBeVisible();
    await shot(page, info, "p1.3", "production-running");
    // A video the founder watched being made opens in the editor, and it waits at the gate, not at the customer.
    await expect(page).toHaveURL(new RegExp(`/videos/${CARDS.approved}/edit$`), { timeout: 40_000 });

    await page.goto("/admin/review");
    await expect(page.locator("[data-card-id]")).toHaveCount(2);
    const review = page.locator(`[data-card-id="${CARDS.approved}"]`);
    await expect(review.locator("video")).toBeVisible();
    await expect(review).toContainText("Internal review");
    await shot(page, info, "p1.3", "review-gate");

    await page.getByRole("button", { name: /Send all 2 to customer/ }).click();
    await expect(page.getByText("2 sent. 1 email sent.")).toBeVisible();
    await expect(page.locator("[data-card-id]")).toHaveCount(0);

    // One email for the batch, to the brand's member.
    const mail = outbox();
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe("member@katalab.test");
    expect(mail[0].subject).toContain("2 videos for Acme are ready to review");
    expect(mail[0].html).toContain("/calendar");
  });

  test("once sent, the customer opens the video; before that it did not exist for them", async ({ page }) => {
    test.skip(isPhone(page), "desktop only");
    await asFounder(page);
    const send = await page.request.post("/api/admin/brands/acme/send", { data: { cardIds: [CARDS.inReview] } });
    expect(send.ok()).toBe(true);
    expect((await send.json()).sent).toEqual([CARDS.inReview]);
    // A second send of the same video does nothing.
    expect((await (await page.request.post("/api/admin/brands/acme/send", { data: { cardIds: [CARDS.inReview] } })).json()).sent).toEqual([]);
    expect(outbox()).toHaveLength(1);
    await page.context().clearCookies();
    await asMember(page);
    await page.goto(editor(CARDS.inReview));
    await expect(page.getByText("Needs your review").first()).toBeVisible();
  });
});

test.describe("reviewing a video in the editor", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(isPhone(page), "the editor is desktop-only");
  });

  test("shows where it is in the plan, its status, and the choices", async ({ page }, info) => {
    await asMember(page);
    await page.goto(editor(CARDS.review));
    await expect(page.getByText("Day 4").first()).toBeVisible();
    await expect(page.getByText("Needs your review").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Not right" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Post", exact: true })).toBeVisible();
    // The editor itself is the existing one, minus the old product's quota.
    await expect(page.getByText("AI video").first()).toBeVisible();
    await expect(page.getByText(/videos? left today/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Calendar" }).first()).toHaveAttribute("href", "/calendar");
    await expect(page.getByRole("button", { name: "Send to customer" })).toHaveCount(0);
    await shot(page, info, "p1.3", "editor-review");
  });

  test("the generated voice sits on its own Voice layer, can be moved, and goes back to where it was generated", async ({ page }, info) => {
    await asFounder(page);
    await page.goto(editor(CARDS.inReview));
    await expect(page.getByText("Voice", { exact: true })).toBeVisible();

    // One clip per voice line, each labelled with the words it says (not the caption row's clips, which say "caption").
    const voice = page.locator('[role="button"]', { hasText: "voice" });
    await expect(voice).toHaveCount(3);
    await expect(voice.first()).toContainText(`Hook words for ${CARDS.inReview}.`);
    await expect(voice.first().locator("canvas")).toBeVisible(); // its own waveform

    // Selecting one shows the voice panel; it is where it was generated, so there is nothing to go back to yet.
    const line = voice.nth(1);
    await line.click();
    await expect(page.getByText("Voice line", { exact: true })).toBeVisible();
    const back = page.getByRole("button", { name: "Back to original position" });
    await expect(back).toBeDisabled();
    await expect(page.getByTestId("voice-status")).toContainText("lip-synced");
    await shot(page, info, "p1.3", "editor-voice-layer");

    // Dragging it later moves it, says so, and offers the way back.
    const start = (await line.boundingBox())!;
    await page.mouse.move(start.x + 20, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + 160, start.y + start.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await voice.nth(1).boundingBox())!.x).toBeGreaterThan(start.x + 100);
    await expect(voice.nth(1)).toContainText("moved");
    await expect(voice.nth(1)).toContainText(`Middle words for ${CARDS.inReview}.`); // still called what it says, wherever it sits
    await expect(page.getByText("Voice line", { exact: true }).locator("xpath=following-sibling::p")).toContainText("Middle words");
    await expect(page.getByTestId("voice-status")).toContainText("later than generated");
    await expect(back).toBeEnabled();
    await shot(page, info, "p1.3", "editor-voice-moved");

    // A stray key never deletes a voice line.
    await page.keyboard.press("Delete");
    await expect(voice).toHaveCount(3);

    // Back to original position puts it exactly where the lip-synced clips expect it.
    await back.click();
    await expect.poll(async () => Math.abs((await voice.nth(1).boundingBox())!.x - start.x)).toBeLessThan(1.5);
    await expect(voice.nth(1)).not.toContainText("moved");
    await expect(back).toBeDisabled();
  });

  test("approving makes it ready, and approval can be undone", async ({ page }) => {
    await asMember(page);
    await page.goto(editor(CARDS.review));
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Ready to post").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo approval" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Not right" })).toHaveCount(0);
    await page.getByRole("button", { name: "Undo approval" }).click();
    await expect(page.getByText("Needs your review").first()).toBeVisible();
  });

  test("'not right' needs a reason, goes back to the founder, and the customer is told", async ({ page }, info) => {
    await asMember(page);
    await page.goto(editor(CARDS.review));
    await page.getByRole("button", { name: "Not right" }).click();
    const send = page.getByRole("button", { name: "Send back" });
    await expect(send).toBeDisabled();
    await page.getByLabel("The product is wrong").check();
    await page.getByLabel("Tell us more (optional)").fill("The logo is the wrong colour");
    await shot(page, info, "p1.3", "not-right");
    await send.click();
    await expect(page).toHaveURL(/\/calendar\?sent-back=1/);
    await expect(page.getByText("We will look at that video")).toBeVisible();
    await expect(page.locator(`[data-card-id="${CARDS.review}"]`)).toContainText("Generating");
    expect((await page.goto(editor(CARDS.review)))?.status()).toBe(404);

    // The founder sees why.
    await page.context().clearCookies();
    await asFounder(page);
    await page.goto("/admin/review");
    await expect(page.locator(`[data-card-id="${CARDS.review}"]`).getByTestId("not-right")).toContainText("The product is wrong");
    await expect(page.locator(`[data-card-id="${CARDS.review}"]`).getByTestId("not-right")).toContainText("The logo is the wrong colour");
  });

  test("Escape closes the 'not right' form", async ({ page }) => {
    await asMember(page);
    await page.goto(editor(CARDS.review));
    await page.getByRole("button", { name: "Not right" }).click();
    await expect(page.getByRole("dialog", { name: "What is not right" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "What is not right" })).toHaveCount(0);
  });

  test("the founder sees the real status and can send a video from the editor", async ({ page }) => {
    await asFounder(page);
    await page.goto(editor(CARDS.inReview));
    await expect(page.getByText("Internal review").first()).toBeVisible();
    await page.getByRole("button", { name: "Send to customer" }).click();
    await expect(page.getByText("Sent to customer").first()).toBeVisible();
  });

  test("the old editor address sends a brand video to the new one", async ({ page }) => {
    await asFounder(page);
    await page.goto(`/jobs/acme-${CARDS.review}/edit`);
    await expect(page).toHaveURL(new RegExp(`${editor(CARDS.review)}$`));
  });
});

test.describe("the post panel", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(isPhone(page), "the editor is desktop-only");
  });

  test("opens with the adapted caption and hashtags, and saves edits", async ({ page }, info) => {
    await asMember(page);
    await page.goto(editor(CARDS.ready));
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Post details" });
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel("Caption")).toHaveValue("A caption for the post.");
    await expect(panel.getByLabel("Hashtags", { exact: true })).toHaveValue("ai tips");
    await expect(panel.getByText("Planned for Tue, Oct 13 at 18:00")).toBeVisible();
    for (const name of ["TikTok", "Instagram Reels", "YouTube Shorts"]) await expect(panel.getByLabel(name)).toBeDisabled();
    await expect(panel.getByText(/coming soon/)).toBeVisible();
    await shot(page, info, "p1.3", "post-panel");

    await panel.getByLabel("Caption").fill("My own caption.");
    await panel.getByLabel("Hashtags", { exact: true }).fill("#launch   #mac, ai");
    await expect(panel.getByRole("list", { name: "Chosen hashtags" }).getByRole("listitem")).toHaveText(["#launch", "#mac", "#ai"]);
    await panel.getByRole("button", { name: "Save details" }).click();
    await expect(panel.getByText("Saved.")).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByLabel("Caption")).toHaveValue("My own caption.");
    await expect(page.getByLabel("Hashtags", { exact: true })).toHaveValue("launch mac ai");
  });

  test("closes with Escape and returns focus to the button", async ({ page }) => {
    await asMember(page);
    await page.goto(editor(CARDS.ready));
    const post = page.getByRole("button", { name: "Post", exact: true });
    await post.click();
    await expect(page.getByRole("dialog", { name: "Post details" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Post details" })).toHaveCount(0);
    await expect(post).toBeFocused();
  });

  test("downloads the video and copies the caption", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await asMember(page);
    await page.goto(editor(CARDS.ready));
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const link = page.getByRole("link", { name: "Download MP4" });
    await expect(link).toHaveAttribute("href", /\/api\/media\/brands\/acme\/videos\/card-ready\/final\.mp4/);
    await expect(link).toHaveAttribute("download", "");
    const file = await page.request.get((await link.getAttribute("href"))!);
    expect(file.status()).toBe(200);
    expect(file.headers()["content-type"]).toBe("video/mp4");

    await page.getByRole("button", { name: "Copy caption and hashtags" }).click();
    await expect(page.getByText("Copied. Paste it into your post.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("A caption for the post.\n\n#ai #tips");
  });

  test("marking as posted needs real links, then locks the video as posted", async ({ page }) => {
    await asMember(page);
    await page.goto(editor(CARDS.ready));
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const mark = page.getByRole("button", { name: "Mark as posted" });
    await expect(mark).toBeDisabled();
    await page.getByLabel("Where did you post it?").fill("not a link");
    await mark.click();
    await expect(page.getByRole("alert").filter({ hasText: /Paste the full link/ })).toBeVisible();

    await page.getByLabel("Where did you post it?").fill("https://www.tiktok.com/@acme/video/123\nhttps://www.instagram.com/reel/abc/");
    await mark.click();
    await expect(page.getByText("Posted", { exact: true }).first()).toBeVisible();
    const posted = page.getByRole("dialog", { name: "Post details" });
    await expect(posted.getByRole("link", { name: "https://www.tiktok.com/@acme/video/123" })).toBeVisible();
    await expect(posted.getByLabel("Caption")).toBeDisabled();
    await expect(posted.getByRole("button", { name: "Mark as posted" })).toHaveCount(0);
    // Posted is final for a customer: no way back.
    const again = await page.request.post(`/api/brands/acme/cards/${CARDS.ready}/video`, { data: { action: "unapprove" }, failOnStatusCode: false });
    expect(again.status()).toBe(409);
  });

  test("a video not yet approved says to approve it first", async ({ page }) => {
    await asMember(page);
    await page.goto(editor(CARDS.review));
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByText("Approve the video to mark it as posted.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark as posted" })).toHaveCount(0);
  });

  test("a bad caption or too many hashtags is refused with the reason", async ({ page }) => {
    await asMember(page);
    const put = (data: unknown) => page.request.put(`/api/brands/acme/cards/${CARDS.ready}/post`, { data, failOnStatusCode: false });
    expect((await put({ caption: "x".repeat(2201), hashtags: [], platforms: [] })).status()).toBe(400);
    expect((await put({ caption: "ok", hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`), platforms: [] })).status()).toBe(400);
    expect((await put({ caption: "ok", hashtags: ["has space"], platforms: [] })).status()).toBe(400);
    expect((await put({ caption: "ok", hashtags: ["fine"], platforms: ["myspace"] })).status()).toBe(400);
    expect((await page.request.put(`/api/brands/acme/cards/${CARDS.inReview}/post`, { data: { caption: "x", hashtags: [], platforms: [] }, failOnStatusCode: false })).status()).toBe(404);
  });
});

test.describe("regenerating a clip runs on the queue", () => {
  const jobId = `acme-${CARDS.review}`;
  const api = `/api/jobs/${jobId}/regenerate-clip`;

  test("is priced first, then runs as a job and adds a take", async ({ page }) => {
    await asFounder(page);
    const clips = ((await (await page.request.get(`/api/jobs/${jobId}/edl`)).json()) as { edl: { video: { id: string }[] } }).edl;
    const clipId = clips.video[0].id;

    const quote = await page.request.post(api, { data: { clipId } });
    expect(quote.status()).toBe(200);
    expect((await quote.json()).estimateUsd).toBe(1.25);
    expect(await sql(`select 1 from work_queue where kind = 'clip.regenerate'`)).toHaveLength(0); // pricing spends and queues nothing

    const start = await page.request.post(api, { data: { clipId, confirm: true } });
    expect(start.status()).toBe(202);
    expect((await (await page.request.get(api)).json()).clips[clipId].status).toMatch(/running|done/);
    await expect.poll(async () => (await (await page.request.get(api)).json()).clips[clipId]?.status, { timeout: 20_000 }).toBe("done");

    const takes = await (await page.request.get(`/api/jobs/${jobId}/clip-takes?clipId=${encodeURIComponent(clipId)}`)).json();
    expect(takes.takes).toHaveLength(2);
    expect(takes.takes.map((t: { origin: string }) => t.origin).sort()).toEqual(["original", "regenerated"]);
    // One attempt only: a paid run is never retried by the queue.
    const row = await sql(`select max_attempts from work_queue where kind = 'clip.regenerate'`);
    expect(Number(row[0].max_attempts)).toBe(1);
  });

  test("a second request while one runs does not start another", async ({ page }) => {
    await asFounder(page);
    const clipId = ((await (await page.request.get(`/api/jobs/${jobId}/edl`)).json()) as { edl: { video: { id: string }[] } }).edl.video[1].id;
    await page.request.post(api, { data: { clipId, confirm: true } });
    await page.request.post(api, { data: { clipId, confirm: true } });
    expect(await sql(`select 1 from work_queue where kind = 'clip.regenerate' and payload->>'clipId' = $1`, [clipId])).toHaveLength(1);
  });

  test("is for the founder only, and refuses a hostile clip id", async ({ page }) => {
    await asMember(page);
    expect((await page.request.post(api, { data: { clipId: "v-s0" }, failOnStatusCode: false })).status()).toBe(403);
    await page.context().clearCookies();
    await asFounder(page);
    expect((await page.request.post(api, { data: { clipId: "../../etc/passwd", confirm: true }, failOnStatusCode: false })).status()).toBe(400);
    expect((await page.request.post(api, { data: {}, failOnStatusCode: false })).status()).toBe(400);
  });

  test("the editor's Takes panel puts the original shot next to the take in use", async ({ page }, info) => {
    test.skip(isPhone(page), "the editor is desktop-only");
    await asFounder(page);
    await page.goto(editor(CARDS.review));
    await page.locator('div[role="button"][tabindex="0"]').first().click();
    await expect(page.getByText(/^Takes/)).toBeVisible({ timeout: 15_000 });
    const pair = page.getByTestId("side-by-side");
    await expect(pair).toBeVisible();
    await expect(pair.getByLabel("The original shot")).toHaveAttribute("src", /\/api\/media\/brands\/acme\/sources\/src-card-review\.mp4/);
    await expect(pair.getByLabel("The take in use")).toHaveAttribute("src", /\/jobs\/acme-card-review\/generated\/clips\/s0\.mp4/);
    await shot(page, info, "p1.3", "takes-side-by-side");
  });
});

test.describe("on a phone", () => {
  test("the production and review screens fit the screen", async ({ page }, info) => {
    test.skip(!isPhone(page), "phone only");
    await asFounder(page);
    for (const [path, name] of [["/admin/production", "phone-production"], ["/admin/review", "phone-review"]] as const) {
      await page.goto(path);
      await expect(page.getByRole("navigation", { name: "Admin sections" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await shot(page, info, "p1.3", name);
    }
  });
});
