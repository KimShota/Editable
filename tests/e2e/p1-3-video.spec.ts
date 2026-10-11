import { expect, type Page, test } from "@playwright/test";
import { CARDS, expectNoHorizontalScroll, resetFixture, shot, signInAndOpenCalendar, sql, startSessions } from "./helpers";

/**
 * P1.3 Video (plan/ui-ux-full-flow.md §5, §8): making a video from the card
 * page (price, confirm, make), the editor for a brand's video, and what a
 * person can do with it. Production runs against the stub producer (real,
 * tiny videos).
 */

test.beforeEach(async () => {
  await resetFixture();
  await startSessions();
});

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) < 768;
const asMember = (page: Page) => signInAndOpenCalendar(page, "member");
const asFounder = (page: Page) => signInAndOpenCalendar(page, "founder");
const editor = (id: string) => `/videos/${id}/edit`;

test.describe("making a video", () => {
  test("the card page prices the video, asks before spending, shows it being made, then opens it", async ({ page }, info) => {
    test.setTimeout(120_000);
    await asMember(page);
    await page.goto(`/plan/${CARDS.approved}`);
    const panel = page.getByRole("region", { name: "Make this video" });
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("estimate")).toHaveText("Not priced yet.");
    await expect(panel.getByRole("button", { name: "Make this video" })).toHaveCount(0); // price it first
    await shot(page, info, "p1.3", "card-make");

    await panel.getByRole("button", { name: "Get estimate" }).click();
    await expect(panel.getByTestId("estimate")).toContainText("$12.50", { timeout: 30_000 });
    await expect(panel.getByTestId("estimate")).toContainText("up to $18.00 with retries");

    // Making it spends money, so it asks first and names the most it can cost.
    await panel.getByRole("button", { name: "Make this video" }).click();
    await expect(panel.getByRole("button", { name: "Spend up to $18.00" })).toBeVisible();
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel.getByRole("button", { name: "Make this video" })).toBeVisible();
    await panel.getByRole("button", { name: "Make this video" }).click();
    await panel.getByRole("button", { name: "Spend up to $18.00" }).click();

    const bar = page.getByRole("status").filter({ hasText: "Making your video" });
    await expect(bar).toBeVisible();
    const steps = bar.getByRole("list", { name: "Steps" }).getByRole("listitem");
    await expect(steps).toHaveText([/Voice/, /Clips/, /Finishing/]);
    await expect(bar.getByRole("progressbar")).toHaveAttribute("aria-valuenow", /^\d+$/);
    await expect(bar.locator("[data-step=current]")).toHaveCount(1);
    await expect(page.getByText("Being made", { exact: true })).toBeVisible();
    await shot(page, info, "p1.3", "card-making");

    if (isPhone(page)) {
      // The editor is built for a wide screen, so a phone stays where it is: the bar is replaced by the finished state.
      await expect(page.getByRole("status").filter({ hasText: "Making your video" })).toHaveCount(0, { timeout: 40_000 });
      await expect(page.getByText("Ready to post", { exact: true }).first()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/plan/${CARDS.approved}$`));
      await expect(page.getByRole("link", { name: "Open the video" })).toBeVisible();
    } else {
      // A video you watched being made opens in the editor as soon as it is done, waiting for your review.
      await expect(page).toHaveURL(new RegExp(`/videos/${CARDS.approved}/edit$`), { timeout: 40_000 });
      await expect(page.getByText("Ready to post").first()).toBeVisible();
    }
  });

  test("a failed video says so and can be made again", async ({ page }) => {
    await asMember(page);
    await page.goto(`/plan/${CARDS.failed}`);
    const panel = page.getByRole("region", { name: "Make this video" });
    await expect(panel).toContainText("The last run failed. Making it again pays for a new run.");
    await expect(panel.getByRole("button", { name: "Get estimate" })).toBeVisible();
  });

  test("the card page links to the video once there is one", async ({ page }) => {
    await asMember(page);
    await page.goto(`/plan/${CARDS.review}`);
    await expect(page.getByRole("link", { name: "Open the video" })).toHaveAttribute("href", `/videos/${CARDS.review}/edit`);
    await page.goto(`/plan/${CARDS.draft}`);
    await expect(page.getByRole("link", { name: "Open the video" })).toHaveCount(0);
  });

  test("the rules hold: only an approved or failed card can be made, and only in your own brand", async ({ page }) => {
    await asMember(page);
    const post = (path: string) => page.request.post(path, { data: {}, failOnStatusCode: false });
    expect((await post(`/api/brands/acme/cards/${CARDS.draft}/release`)).status()).toBe(409); // not approved yet
    expect((await post(`/api/brands/acme/cards/${CARDS.review}/release`)).status()).toBe(409); // already made
    expect((await post(`/api/brands/acme/cards/nope/release`)).status()).toBe(404);
    const video = (id: string, data: unknown) => page.request.post(`/api/brands/acme/cards/${id}/video`, { data, failOnStatusCode: false });
    expect((await video(CARDS.draft, { action: "mark_posted", urls: ["https://www.tiktok.com/@x/video/1"] })).status()).toBe(409); // no video yet
    expect((await video(CARDS.failed, { action: "mark_posted", urls: ["https://www.tiktok.com/@x/video/1"] })).status()).toBe(409); // not ready
    await page.context().clearCookies();
    await signInAndOpenCalendar(page, "outsider");
    expect((await post(`/api/brands/acme/cards/${CARDS.approved}/release`)).status()).toBe(404); // Acme's card, Rival's member
    expect((await post(`/api/brands/acme/cards/${CARDS.approved}/estimate`)).status()).toBe(404);
  });

  test("there is no admin production or review screen any more", async ({ page }) => {
    await asFounder(page);
    for (const url of ["/admin/production", "/admin/review"]) expect((await page.goto(url))?.status(), url).toBe(404);
    expect((await page.request.post("/api/admin/brands/acme/send", { data: {}, failOnStatusCode: false })).status()).toBe(404);
  });

  test("a member can open any video of their brand, by page or by URL", async ({ page }) => {
    await asMember(page);
    await page.goto(editor(CARDS.failed));
    await expect(page.getByText("AI video").first()).toBeVisible();
    for (const url of [`/api/media/brands/acme/videos/${CARDS.failed}/final.mp4`, `/api/jobs/acme-${CARDS.failed}/edl`]) {
      expect((await page.request.get(url)).status(), url).toBe(200);
    }
  });
});

test.describe("reviewing a video in the editor", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(isPhone(page), "the editor is desktop-only");
  });

  test("shows where it is in the plan, its status, and Post", async ({ page }, info) => {
    await asMember(page);
    await page.goto(editor(CARDS.review));
    await expect(page.getByText("Day 4").first()).toBeVisible();
    await expect(page.getByText("Ready to post").first()).toBeVisible();
    // There is nothing to approve or send back: a made video is ready to post.
    await expect(page.getByRole("button", { name: /^(Approve|Not right|Undo approval)$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Post", exact: true })).toBeVisible();
    // The editor itself is the existing one, minus the old product's quota.
    await expect(page.getByText("AI video").first()).toBeVisible();
    await expect(page.getByText(/videos? left today/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Calendar" }).first()).toHaveAttribute("href", "/calendar");
    await expect(page.getByRole("button", { name: /Send (to customer|for review)/ })).toHaveCount(0); // there is no review gate
    await shot(page, info, "p1.3", "editor-review");
  });

  test("the generated voice sits on its own Voice layer, can be moved, and goes back to where it was generated", async ({ page }, info) => {
    await asMember(page);
    await page.goto(editor(CARDS.failed));
    await expect(page.getByText("Voice", { exact: true })).toBeVisible();

    // One clip per voice line, each labelled with the words it says (not the caption row's clips, which say "caption").
    const voice = page.locator('[role="button"]', { hasText: "voice" });
    await expect(voice).toHaveCount(3);
    await expect(voice.first()).toContainText(`Hook words for ${CARDS.failed}.`);
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
    await expect(voice.nth(1)).toContainText(`Middle words for ${CARDS.failed}.`); // still called what it says, wherever it sits
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

  test("the old editor address sends a brand video to the new one", async ({ page }) => {
    await asMember(page);
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
    // Once posted, it cannot be marked as posted again.
    const again = await page.request.post(`/api/brands/acme/cards/${CARDS.ready}/video`, { data: { action: "mark_posted", urls: ["https://www.tiktok.com/@a/video/2"] }, failOnStatusCode: false });
    expect(again.status()).toBe(409);
  });

  test("a video that is not ready says so instead of offering to mark it posted", async ({ page }) => {
    await asMember(page);
    await page.goto(editor(CARDS.failed));
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByText("This video is not ready to post yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark as posted" })).toHaveCount(0);
  });

  test("a bad caption or too many hashtags is refused with the reason", async ({ page }) => {
    await asMember(page);
    const put = (data: unknown) => page.request.put(`/api/brands/acme/cards/${CARDS.ready}/post`, { data, failOnStatusCode: false });
    expect((await put({ caption: "x".repeat(2201), hashtags: [], platforms: [] })).status()).toBe(400);
    expect((await put({ caption: "ok", hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`), platforms: [] })).status()).toBe(400);
    expect((await put({ caption: "ok", hashtags: ["has space"], platforms: [] })).status()).toBe(400);
    expect((await put({ caption: "ok", hashtags: ["fine"], platforms: ["myspace"] })).status()).toBe(400);
    expect((await page.request.put(`/api/brands/acme/cards/card-nope/post`, { data: { caption: "x", hashtags: [], platforms: [] }, failOnStatusCode: false })).status()).toBe(404);
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

  test("is open to a member, and refuses a hostile clip id", async ({ page }) => {
    await asMember(page);
    expect((await page.request.post(api, { data: { clipId: "v-s0" }, failOnStatusCode: false })).status()).not.toBe(403);
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
  test("the make-this-video panel fits the screen", async ({ page }, info) => {
    test.skip(!isPhone(page), "phone only");
    await asMember(page);
    await page.goto(`/plan/${CARDS.approved}`);
    await expect(page.getByRole("region", { name: "Make this video" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.3", "phone-make");
  });
});
