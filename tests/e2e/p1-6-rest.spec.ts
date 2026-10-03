import fs from "node:fs";
import path from "node:path";
import { expect, type Page, request, test } from "@playwright/test";
import { APP_URL, STORAGE_ROOT } from "./env";
import { CARDS, expectNoHorizontalScroll, resetFixture, shot, signInAndOpenCalendar, startSessions } from "./helpers";

/**
 * P1.6 The rest (plan/ui-ux-full-flow.md §7, §8): Brand settings, Workspace,
 * the Analytics and Cycle Review shells (sample numbers only in the founder's
 * demo mode), and the founder's Brands, Cost and moved Reverse-engineer
 * screens, with the invitation flow end to end.
 */

test.beforeEach(async () => {
  await resetFixture();
  await startSessions();
});

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) < 768;
const as = (page: Page, user: "member" | "founder" | "outsider") => signInAndOpenCalendar(page, user);
const outbox = (): { to: string; subject: string; html: string }[] => {
  const file = path.join(STORAGE_ROOT, "outbox.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(STORAGE_ROOT, rel), "utf8"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const demoOn = async (page: Page) => expect((await page.request.post("/api/admin/demo", { data: { on: true } })).ok()).toBe(true);

test.describe("the sidebar", () => {
  test("a customer sees their sections and the workspace, a founder also sees Admin", async ({ page }) => {
    test.skip(isPhone(page), "desktop sidebar");
    await as(page, "member");
    const nav = page.getByRole("navigation", { name: "Main" });
    for (const name of ["Calendar", "Plan", "Analytics", "Brand"]) await expect(nav.getByRole("link", { name })).toBeVisible();
    await expect(page.getByRole("link", { name: "Workspace" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
    await page.context().clearCookies();
    await as(page, "founder");
    await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
  });
});

test.describe("brand settings", () => {
  test("shows what the brand has now, and what is locked", async ({ page }, info) => {
    await as(page, "member");
    await page.goto("/brand");
    await expect(page.getByRole("heading", { name: "Brand", level: 1 })).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Acme");
    await expect(page.getByLabel("What it does, one per line")).toHaveValue("fast");
    await expect(page.getByRole("radio", { name: "An app or software" })).toBeChecked();
    await expect(page.getByLabel("Main color")).toHaveValue("#2563eb");
    await expect(page.getByLabel("Language of your videos")).toHaveValue("en");
    await expect(page.getByLabel("Daily posting time")).toHaveValue("18:00");
    await expect(page.getByLabel("Time zone")).toHaveValue("UTC");
    // Locked things are shown, not editable.
    await expect(page.getByRole("heading", { name: "Character and voice" })).toBeVisible();
    await expect(page.getByText("Aria", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Voice: Aria (Test)")).toBeVisible();
    await expect(page.getByLabel("Aria speaking")).toHaveAttribute("src", /sample\.mp3/);
    await expect(page.getByText("Locked for this brand")).toBeVisible();
    await expect(page.getByText("No angle chosen yet.")).toBeVisible();
    for (const n of ["TikTok", "Instagram", "YouTube"]) await expect(page.getByRole("button", { name: `Connect ${n}` })).toBeDisabled();
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.6", "brand");
  });

  test("saves are explicit: nothing to save until something changes", async ({ page }) => {
    await as(page, "member");
    await page.goto("/brand");
    for (const section of ["product", "kit", "schedule"]) await expect(page.locator(`#${section}`).getByRole("button", { name: "Save" })).toBeDisabled();
    await page.getByLabel("In one sentence").fill("Acme makes everything faster.");
    await expect(page.locator("#product").getByRole("button", { name: "Save" })).toBeEnabled();
    await expect(page.locator("#kit").getByRole("button", { name: "Save" })).toBeDisabled(); // other sections are independent
  });

  test("editing the product saves it, keeps it, and reaches intake.json", async ({ page }) => {
    await as(page, "member");
    await page.goto("/brand");
    await page.getByLabel("In one sentence").fill("Acme makes everything faster.");
    await page.getByLabel("What it does, one per line").fill("fast\nprivate\n\nsimple");
    await page.getByRole("radio", { name: "A service" }).check();
    await page.locator("#product").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#product").getByRole("status")).toHaveText("Saved.");
    await page.reload();
    await expect(page.getByLabel("In one sentence")).toHaveValue("Acme makes everything faster.");
    await expect(page.getByLabel("What it does, one per line")).toHaveValue("fast\nprivate\nsimple"); // blank lines dropped
    await expect(page.getByRole("radio", { name: "A service" })).toBeChecked();
    // The file the script writer reads agrees.
    const product = readJson("brands/acme/intake.json").intake.products[0];
    expect(product.oneLiner).toBe("Acme makes everything faster.");
    expect(product.features).toEqual(["fast", "private", "simple"]);
    expect(product.type).toBe("service");
  });

  test("renaming the product renames the brand in the sidebar", async ({ page }) => {
    test.skip(isPhone(page), "desktop sidebar");
    await as(page, "member");
    await page.goto("/brand");
    await page.getByLabel("Name", { exact: true }).fill("Acme Pro");
    await page.locator("#product").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#product").getByRole("status")).toHaveText("Saved.");
    await expect(page.locator("aside").getByText("Acme Pro", { exact: true })).toBeVisible();
  });

  test("a bad value is refused with the reason, and nothing is changed", async ({ page }) => {
    await as(page, "member");
    await page.goto("/brand");
    await page.getByLabel("Name", { exact: true }).fill("   ");
    await page.locator("#product").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#product").getByRole("alert")).toHaveText("The product needs a name");

    await page.getByLabel("Main color").fill("orange");
    await page.locator("#kit").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#kit").getByRole("alert")).toHaveText("Use a color like #2563eb");

    await page.getByLabel("Time zone").fill("Mars/Base");
    await page.locator("#schedule").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#schedule").getByRole("alert")).toHaveText("That is not a known time zone");
    await page.reload();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Acme");
    await expect(page.getByLabel("Main color")).toHaveValue("#2563eb");
    await expect(page.getByLabel("Time zone")).toHaveValue("UTC");
  });

  test("the brand kit saves colors and fonts, and a color can be cleared", async ({ page }) => {
    await as(page, "member");
    await page.goto("/brand");
    await page.getByLabel("Second color").fill("#112233");
    await page.getByLabel("Headline font").fill("Space Grotesk");
    await page.locator("#kit").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#kit").getByRole("status")).toHaveText("Saved.");
    await page.reload();
    await expect(page.getByLabel("Second color")).toHaveValue("#112233");
    await expect(page.getByLabel("Headline font")).toHaveValue("Space Grotesk");
    await page.getByLabel("Main color").fill("");
    await page.locator("#kit").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#kit").getByRole("status")).toHaveText("Saved.");
    await page.reload();
    await expect(page.getByLabel("Main color")).toHaveValue("");
    await expect(page.getByLabel("Second color")).toHaveValue("#112233");
  });

  test("language, posting time and time zone are saved, and the post panel uses them", async ({ page }) => {
    test.skip(isPhone(page), "the editor is desktop-only");
    await as(page, "member");
    await page.goto("/brand");
    await page.getByLabel("Language of your videos").selectOption("ja");
    await page.getByLabel("Daily posting time").fill("07:30");
    await page.getByLabel("Time zone").fill("Asia/Tokyo");
    await page.locator("#schedule").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#schedule").getByRole("status")).toHaveText("Saved.");
    await page.reload();
    await expect(page.getByLabel("Daily posting time")).toHaveValue("07:30");
    await expect(page.getByLabel("Time zone")).toHaveValue("Asia/Tokyo");
    await page.goto(`/videos/${CARDS.ready}/edit`);
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByText("Planned for Tue, Oct 13 at 07:30")).toBeVisible();
  });

  test("pictures: upload, list, and remove", async ({ page }) => {
    await as(page, "member");
    await page.goto("/brand");
    await expect(page.getByText("Nothing here yet.")).toBeVisible();
    await page.getByLabel("File").setInputFiles({ name: "product.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText("Added.")).toBeVisible();
    const list = page.getByRole("list", { name: "Product pictures and recordings" });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    const src = await list.getByRole("img", { name: "Photo" }).getAttribute("src");
    expect(src).toMatch(/^\/api\/media\/brands\/acme\/product\/uploads\/[0-9a-f-]+\.png$/);
    expect((await page.request.get(src!)).status()).toBe(200);

    await list.getByRole("button", { name: "Remove this photo" }).click();
    await expect(page.getByText("Nothing here yet.")).toBeVisible();
    expect((await page.request.get(src!, { failOnStatusCode: false })).status()).toBe(404);
  });

  test("a logo becomes the brand's logo", async ({ page }) => {
    await as(page, "member");
    await page.goto("/brand");
    await page.getByLabel("What is it?").selectOption("logo");
    await page.getByLabel("File").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("img", { name: "Your current logo" })).toBeVisible();
  });

  test("the file's real type decides, not its name or the browser's claim", async ({ page }) => {
    await as(page, "member");
    await page.goto("/brand");
    const upload = async (name: string, mimeType: string, buffer: Buffer) => {
      await page.getByLabel("File").setInputFiles({ name, mimeType, buffer });
      await page.getByRole("button", { name: "Upload" }).click();
    };
    await upload("fake.png", "image/png", Buffer.from("this is text, not a picture"));
    await expect(page.getByRole("alert").filter({ hasText: "not supported" })).toBeVisible();
    await upload("page.png", "image/png", Buffer.from("<!doctype html><script>alert(1)</script>"));
    await expect(page.getByRole("alert").filter({ hasText: "not supported" })).toBeVisible();
    // A video offered as a photo.
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(40)]);
    await upload("clip.mp4", "video/mp4", mp4);
    await expect(page.getByRole("alert").filter({ hasText: "picture, not a video" })).toBeVisible();
    await expect(page.getByText("Nothing here yet.")).toBeVisible();
    expect(fs.existsSync(path.join(STORAGE_ROOT, "brands/acme/product/uploads")) ? fs.readdirSync(path.join(STORAGE_ROOT, "brands/acme/product/uploads")).length : 0).toBe(0);
  });

  test("the API enforces the same rules, size and brand ownership included", async ({ page }) => {
    await as(page, "member");
    const post = (kind: string, buffer: Buffer, name = "a.png") => page.request.post("/api/brands/acme/assets", { multipart: { kind, file: { name, mimeType: "image/png", buffer } }, failOnStatusCode: false });
    expect((await post("photo", PNG)).status()).toBe(200);
    expect((await post("avatar", PNG)).status()).toBe(400);
    expect((await post("photo", Buffer.alloc(0))).status()).toBe(400);
    const big = await post("photo", Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]));
    expect(big.status()).toBe(413);
    expect((await big.json()).error).toMatch(/too large/);
    expect((await page.request.post("/api/brands/acme/assets", { data: {}, failOnStatusCode: false })).status()).toBe(400);
    // Another brand's member can neither add to nor remove from this brand.
    const id = (await (await post("photo", PNG)).json()).asset.id as string;
    await page.context().clearCookies();
    await as(page, "outsider");
    expect((await page.request.post("/api/brands/acme/assets", { multipart: { kind: "photo", file: { name: "a.png", mimeType: "image/png", buffer: PNG } }, failOnStatusCode: false })).status()).toBe(404);
    expect((await page.request.delete(`/api/brands/acme/assets/${id}`, { failOnStatusCode: false })).status()).toBe(404);
    expect((await page.request.delete("/api/brands/rival/assets/not-an-id", { failOnStatusCode: false })).status()).toBe(404);
  });

  test("the settings API changes only what it owns, and only for your own brand", async ({ page }) => {
    await as(page, "member");
    const patch = (data: unknown, slug = "acme") => page.request.patch(`/api/brands/${slug}/settings`, { data, failOnStatusCode: false });
    // Locked things are not accepted, even if sent: they are ignored, not applied.
    expect((await patch({ niche: { chosenAngleId: "x" }, character: { kind: "mascot" }, voice: { name: "x" } })).status()).toBe(200);
    expect(fs.existsSync(path.join(STORAGE_ROOT, "brands/acme/niche.json"))).toBe(false);
    expect(readJson("brands/acme/character/character.json").kind).toBe("realistic");
    expect((await patch({ brand: { language: "fr" } })).status()).toBe(400);
    expect((await patch({}, "rival")).status()).toBe(404);
    await page.context().clearCookies();
    expect((await page.request.patch("/api/brands/acme/settings", { data: {}, failOnStatusCode: false })).status()).toBe(401);
  });

  test("on a phone it fits and stays usable", async ({ page }, info) => {
    test.skip(!isPhone(page), "phone only");
    await as(page, "member");
    await page.goto("/brand");
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.6", "phone-brand");
  });
});

test.describe("workspace", () => {
  test("shows the account, the members and the placeholder for extra versions", async ({ page }, info) => {
    await as(page, "member");
    await page.goto("/workspace");
    await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();
    await expect(page.getByTestId("account-email")).toHaveText("member@katalab.test");
    await expect(page.getByText("Free", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "See plans" })).toHaveAttribute("href", "/pricing");
    await expect(page.getByRole("list", { name: "Members" }).getByRole("listitem")).toHaveText([/member@katalab\.test\s*You/]);
    await expect(page.getByText(/Packs of extra versions come later/)).toBeVisible();
    await expect(page.getByText("Verify your email")).toHaveCount(0); // the fixture user is verified
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.6", "workspace");
  });

  test("the old account address and an email-verification link both land here, with their message", async ({ page }) => {
    await as(page, "member");
    await page.goto("/account?verified=1");
    await expect(page).toHaveURL(/\/workspace\?verified=1$/);
    await expect(page.getByRole("status").filter({ hasText: "Email verified" })).toBeVisible();
    await page.goto("/account?verify_error=this%20link%20has%20expired");
    await expect(page.getByRole("alert").filter({ hasText: "this link has expired" })).toBeVisible();
    // A bad verification link redirects into the workspace with the reason.
    await page.goto("/api/auth/verify?token=not-a-real-token");
    await expect(page).toHaveURL(/\/workspace\?verify_error=/);
    await expect(page.getByRole("alert").filter({ hasText: "invalid or has already been used" })).toBeVisible();
  });

  test("the founder sees who has been invited but has not joined", async ({ page }) => {
    await as(page, "founder");
    await page.request.post("/api/admin/brands/acme/members", { data: { email: "waiting@katalab.test" } });
    await page.goto("/workspace");
    await expect(page.getByRole("list", { name: "Members" })).toContainText("waiting@katalab.test");
    await expect(page.getByRole("list", { name: "Members" })).toContainText("Invited");
    await page.context().clearCookies();
    await as(page, "member");
    await page.goto("/workspace");
    await expect(page.getByRole("list", { name: "Members" })).not.toContainText("waiting@katalab.test"); // a customer does not see invitations
  });
});

test.describe("posted links", () => {
  test("only web addresses are accepted, and a refused link leaves the video unposted", async ({ page }) => {
    await as(page, "member");
    const mark = (urls: string[]) => page.request.post(`/api/brands/acme/cards/${CARDS.ready}/video`, { data: { action: "mark_posted", urls }, failOnStatusCode: false });
    for (const bad of ["javascript:alert(document.cookie)", "data:text/html,<script>1</script>", "ftp://x.test/a"]) {
      const res = await mark([bad]);
      expect(res.status(), bad).toBe(400);
      expect((await res.json()).error).toContain("starting with https://");
    }
    await page.goto("/calendar");
    await expect(page.locator(`[data-card-id="${CARDS.ready}"]`).getByText("Ready to post", { exact: true })).toBeVisible(); // still ready, not posted
    expect((await mark(["https://www.tiktok.com/@a/video/1"])).ok()).toBe(true);
  });
});

test.describe("analytics", () => {
  test("a customer sees the real layout with honest empty states, and no sample numbers", async ({ page }, info) => {
    await as(page, "member");
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
    await expect(page.getByTestId("sample-banner")).toHaveCount(0);
    await expect(page.getByText("Your first numbers appear 48 hours after your first post.")).toBeVisible();
    await expect(page.getByText("Nothing posted yet")).toBeVisible();
    await expect(page.getByRole("img", { name: "No views yet" })).toBeVisible();
    await expect(page.getByText("Videos posted this cycle").locator("xpath=..")).toContainText("0"); // the one real number
    await expect(page.getByRole("table")).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.6", "analytics-empty");
  });

  test("the real number is the count of videos marked as posted", async ({ page }) => {
    await as(page, "member");
    expect((await page.request.post(`/api/brands/acme/cards/${CARDS.ready}/video`, { data: { action: "mark_posted", urls: ["https://www.tiktok.com/@a/video/1"] } })).ok()).toBe(true);
    await page.goto("/analytics");
    await expect(page.getByText("Videos posted this cycle").locator("xpath=..")).toContainText("1");
    await expect(page.getByRole("list", { name: "Posted videos" })).toContainText("Numbers appear 48 hours after posting");
    await expect(page.getByTestId("sample-banner")).toHaveCount(0);
  });

  test("the founder in demo mode sees sample numbers, always labelled", async ({ page }, info) => {
    await as(page, "founder");
    await page.goto("/analytics");
    await expect(page.getByTestId("sample-banner")).toHaveCount(0); // demo mode is off: real empty state
    await demoOn(page);
    await page.goto("/analytics");
    await expect(page.getByTestId("sample-banner")).toContainText("Sample data");
    await expect(page.getByTestId("sample-banner")).toContainText("not real");
    const table = page.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(6); // a header and the five videos
    await expect(page.getByRole("img", { name: /Views in the first 7 days for each sample video/ })).toBeVisible();
    const first = await table.getByRole("row").nth(1).innerText();
    await page.reload();
    expect(await page.getByRole("table").getByRole("row").nth(1).innerText()).toBe(first); // the same every time
    await shot(page, info, "p1.6", "analytics-sample");
  });

  test("a customer never sees sample numbers, even with a forged demo cookie", async ({ page }) => {
    await as(page, "member");
    await page.context().addCookies([{ name: "katalab_demo", value: "1", url: APP_URL }]);
    await page.goto("/analytics");
    await expect(page.getByTestId("sample-banner")).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);
    await page.goto("/analytics/cycle-review");
    await expect(page.getByTestId("sample-banner")).toHaveCount(0);
  });

  test("the cycle review is an empty state for a customer, and a labelled sample in demo mode", async ({ page }, info) => {
    await as(page, "member");
    await page.goto("/analytics/cycle-review");
    await expect(page.getByText("Your first review comes after your first cycle")).toBeVisible();
    await expect(page.getByRole("button", { name: "Draft the next plan" })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Cycle review" })).toHaveAttribute("aria-current", "page");
    await page.context().clearCookies();
    await as(page, "founder");
    await demoOn(page);
    await page.goto("/analytics/cycle-review");
    await expect(page.getByTestId("sample-banner")).toBeVisible();
    const formats = page.getByRole("list", { name: "Formats, best first" }).getByRole("listitem");
    await expect(formats).toHaveCount(5);
    await expect(formats.first()).toContainText("Topic of src-card-");
    await expect(formats.first()).toContainText("vs your usual");
    await expect(page.getByText("70% more of what worked, 30% new ideas.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Draft the next plan" })).toBeDisabled(); // a shell: it does nothing yet
    await shot(page, info, "p1.6", "cycle-review-sample");
  });

  test("the two sections link to each other", async ({ page }) => {
    await as(page, "member");
    await page.goto("/analytics");
    await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "Cycle review" }).click();
    await expect(page).toHaveURL(/\/analytics\/cycle-review$/);
  });
});

test.describe("brands and invitations", () => {
  test("lists every brand with its members and where its cycle stands", async ({ page }, info) => {
    await as(page, "founder");
    await page.goto("/admin/brands");
    const acme = page.locator('[data-brand="acme"]');
    await expect(acme).toContainText("workspace Acme");
    await expect(acme).toContainText("no angle yet");
    await expect(acme.getByRole("list", { name: "Acme videos by status" })).toContainText("Draft: 1");
    await expect(acme.getByRole("list", { name: "Acme videos by status" })).toContainText("Ready: 1");
    await expect(acme.getByRole("list", { name: "Acme members" })).toContainText("member@katalab.test");
    await expect(page.locator('[data-brand="rival"]')).toContainText("No plan yet.");
    await expect(page.locator('[data-brand="rival"]').getByRole("button", { name: "Email: your plan is ready" })).toBeDisabled();
    await shot(page, info, "p1.6", "admin-brands");
  });

  test("an existing verified account joins at once; saying so again says they are already in", async ({ page }) => {
    await as(page, "founder");
    await page.goto("/admin/brands");
    const acme = page.locator('[data-brand="acme"]');
    await acme.getByLabel("Add someone to Acme").fill("outsider@katalab.test");
    await acme.getByRole("button", { name: "Add", exact: true }).click();
    await expect(acme.getByRole("status")).toHaveText("Added. They can already see the brand.");
    await acme.getByLabel("Add someone to Acme").fill("OUTSIDER@katalab.test");
    await acme.getByRole("button", { name: "Add", exact: true }).click();
    await expect(acme.getByRole("status")).toHaveText("They are already a member.");
    expect(outbox()).toHaveLength(0); // no email for someone who just joined
    await page.context().clearCookies();
    await as(page, "outsider");
    expect((await page.request.get("/api/media/brands/acme/character/sheet/front.png")).status()).toBe(200);
  });

  test("a new address is invited by email, and the invitation can be cancelled", async ({ page }) => {
    await as(page, "founder");
    await page.goto("/admin/brands");
    const acme = page.locator('[data-brand="acme"]');
    await acme.getByLabel("Add someone to Acme").fill("newcomer@katalab.test");
    await acme.getByRole("button", { name: "Add", exact: true }).click();
    await expect(acme.getByRole("status")).toHaveText("Invited. We emailed them a link to sign up.");
    const mail = outbox();
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe("newcomer@katalab.test");
    expect(mail[0].subject).toBe("You are invited to Acme on Katalab");
    expect(mail[0].html).toContain(`${APP_URL}/signup`);
    await expect(acme.getByRole("list", { name: "Pending invitations" })).toContainText("newcomer@katalab.test");
    await acme.getByRole("button", { name: "Cancel the invitation to newcomer@katalab.test" }).click();
    await expect(acme.getByRole("list", { name: "Pending invitations" })).toHaveCount(0);
  });

  test("a bad address is refused with the reason", async ({ page }) => {
    await as(page, "founder");
    const res = await page.request.post("/api/admin/brands/acme/members", { data: { email: "not an email" }, failOnStatusCode: false });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toContain("is not an email address");
  });

  test("an invited person joins only after verifying the address, never at signup", async ({ page }) => {
    test.setTimeout(60_000);
    await as(page, "founder");
    expect((await page.request.post("/api/admin/brands/acme/members", { data: { email: "newcomer@katalab.test" } })).ok()).toBe(true);

    // They sign up with the invited address. Signup starts a session, but the address is not proven.
    const guest = await request.newContext({ baseURL: APP_URL });
    expect((await guest.post("/api/auth/signup", { data: { email: "newcomer@katalab.test", password: "a-long-password" } })).status()).toBe(201);
    expect((await guest.get("/api/media/brands/acme/character/sheet/front.png", { failOnStatusCode: false })).status()).toBe(404);
    expect((await guest.get("/api/tasks?slug=acme", { failOnStatusCode: false })).status()).toBe(404);

    // Verifying proves it, and the invitation is claimed.
    await expect.poll(() => outbox().some((m) => m.to === "newcomer@katalab.test" && m.subject.includes("Confirm")), { timeout: 15_000 }).toBe(true);
    const link = /href="([^"]+\/api\/auth\/verify\?token=[^"]+)"/.exec(outbox().find((m) => m.subject.includes("Confirm"))!.html)![1].replace(/&amp;/g, "&");
    await guest.get(link, { maxRedirects: 0, failOnStatusCode: false });
    expect((await guest.get("/api/tasks?slug=acme")).status()).toBe(200);
    // The request proxy remembers a refusal for up to 5 seconds (so a member added a moment ago is
    // not locked out for longer than that), so the files follow shortly.
    await expect.poll(async () => (await guest.get("/api/media/brands/acme/character/sheet/front.png", { failOnStatusCode: false })).status(), { timeout: 12_000 }).toBe(200);
    await guest.dispose();
    await page.goto("/admin/brands");
    await expect(page.locator('[data-brand="acme"]').getByRole("list", { name: "Acme members" })).toContainText("newcomer@katalab.test");
    await expect(page.locator('[data-brand="acme"]').getByRole("list", { name: "Pending invitations" })).toHaveCount(0);
  });

  test("someone signing up with an address that was not invited gets nothing", async ({ page }) => {
    await as(page, "founder");
    await page.request.post("/api/admin/brands/acme/members", { data: { email: "invited@katalab.test" } });
    const stranger = await request.newContext({ baseURL: APP_URL });
    await stranger.post("/api/auth/signup", { data: { email: "stranger@katalab.test", password: "a-long-password" } });
    await expect.poll(() => outbox().some((m) => m.to === "stranger@katalab.test"), { timeout: 15_000 }).toBe(true);
    const link = /href="([^"]+\/api\/auth\/verify\?token=[^"]+)"/.exec(outbox().find((m) => m.to === "stranger@katalab.test")!.html)![1].replace(/&amp;/g, "&");
    await stranger.get(link, { maxRedirects: 0, failOnStatusCode: false });
    expect((await stranger.get("/api/media/brands/acme/character/sheet/front.png", { failOnStatusCode: false })).status()).toBe(404);
    await stranger.dispose();
  });

  test("the plan-ready email goes to the brand's members, once the plan exists", async ({ page }) => {
    await as(page, "founder");
    await page.goto("/admin/brands");
    const acme = page.locator('[data-brand="acme"]');
    await acme.getByRole("button", { name: "Email: your plan is ready" }).click();
    await expect(acme.getByRole("status")).toHaveText("1 email sent.");
    const mail = outbox();
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe("member@katalab.test");
    expect(mail[0].subject).toBe("Your plan for Acme is ready to review");
    expect(mail[0].html).toContain(`${APP_URL}/plan`);
    expect((await page.request.post("/api/admin/brands/rival/plan-ready", { data: {}, failOnStatusCode: false })).status()).toBe(409); // no plan to announce
  });

  test("a customer can reach none of it", async ({ page }) => {
    await as(page, "member");
    for (const url of ["/admin/brands", "/admin/cost", "/admin/reverse-engineer"]) expect((await page.goto(url))?.status(), url).toBe(404);
    const post = (p: string, data: unknown = {}) => page.request.post(p, { data, failOnStatusCode: false });
    expect((await post("/api/admin/brands/acme/members", { email: "x@y.test" })).status()).toBe(404);
    expect((await post("/api/admin/brands/acme/plan-ready")).status()).toBe(404);
    expect((await page.request.get("/api/admin/brands/acme/cost", { failOnStatusCode: false })).status()).toBe(404);
    expect((await page.request.delete("/api/admin/brands/acme/members", { data: { email: "x@y.test" }, failOnStatusCode: false })).status()).toBe(404);
  });
});

test.describe("cost", () => {
  test("shows the measured cost of each video against the $3 target", async ({ page }, info) => {
    await as(page, "founder");
    await page.goto("/admin/cost");
    await expect(page.getByRole("heading", { name: "Cost", level: 1 })).toBeVisible();
    // Three produced videos: $2.40, $2.40 and a $12.34 one.
    await expect(page.getByTestId("average-cost")).toHaveText("$5.71");
    await expect(page.getByTestId("target-verdict")).toHaveText("$2.71 over the target");
    const rows = page.getByRole("list", { name: "Cost per video" }).getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(page.locator(`[data-card-id="${CARDS.ready}"]`).getByTestId("video-total")).toHaveText("$12.34");
    await expect(page.locator(`[data-card-id="${CARDS.review}"]`).getByTestId("video-total")).toHaveText("$2.40");
    await page.locator(`[data-card-id="${CARDS.review}"] summary`).click();
    const detail = page.locator(`[data-card-id="${CARDS.review}"]`).getByRole("table");
    await expect(detail).toContainText("stub");
    await expect(detail).toContainText("voice");
    await expect(detail).toContainText("clips");
    await expectNoHorizontalScroll(page);
    await shot(page, info, "p1.6", "admin-cost");
  });

  test("downloads the same numbers as CSV, safe to open in a spreadsheet", async ({ page }) => {
    await as(page, "founder");
    const res = await page.request.get("/api/admin/brands/acme/cost");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain('filename="acme-cost-per-video.csv"');
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toBe("video,day,provider,operation,calls,usd");
    expect(lines.some((l) => l.startsWith("card-ready,5,higgsfield,unknown,1,12.3400"))).toBe(true);
    expect(lines[lines.length - 1]).toMatch(/^total,,,,\d+,17\.1400$/);
    expect((await page.request.get("/api/admin/brands/nope-nope/cost", { failOnStatusCode: false })).status()).toBe(404);
  });

  test("a brand with no produced video says so instead of showing a zero average", async ({ page }) => {
    await as(page, "founder");
    expect((await page.request.post("/api/active-brand", { data: { slug: "rival" } })).ok()).toBe(true);
    await page.goto("/admin/cost");
    await expect(page.getByTestId("average-cost")).toHaveText("No videos yet");
    await expect(page.getByText("No videos have been produced yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "Download CSV" })).toHaveCount(0);
  });
});

test.describe("reverse-engineer, moved under Admin", () => {
  test("lives at its new address, and the old one forwards", async ({ page }) => {
    await as(page, "founder");
    await page.goto("/admin/reverse-engineer");
    await expect(page.getByRole("heading", { name: /Paste a link to a viral reel/ })).toBeVisible();
    await page.goto("/reverse-engineer");
    await expect(page).toHaveURL(/\/admin\/reverse-engineer$/);
    await page.goto("/authoring/new");
    await expect(page).toHaveURL(/\/admin\/reverse-engineer$/);
  });

  test("a customer gets nothing from either address", async ({ page }) => {
    await as(page, "member");
    expect((await page.goto("/reverse-engineer"))?.status()).toBe(404);
    expect((await page.goto("/authoring/new"))?.status()).toBe(404);
  });
});

test.describe("admin sections", () => {
  test("every section is reachable from the tabs", async ({ page }) => {
    await as(page, "founder");
    await page.goto("/admin/production");
    const tabs = page.getByRole("navigation", { name: "Admin sections" });
    for (const name of ["Production", "Review", "Viral videos", "Brands", "Cost", "Demo", "Reverse-engineer"]) await expect(tabs.getByRole("link", { name })).toBeVisible();
    await tabs.getByRole("link", { name: "Cost" }).click();
    await expect(page).toHaveURL(/\/admin\/cost$/);
    await expect(tabs.getByRole("link", { name: "Cost" })).toHaveAttribute("aria-current", "page");
  });

  test("on a phone the tabs scroll sideways inside themselves, not the page", async ({ page }, info) => {
    test.skip(!isPhone(page), "phone only");
    await as(page, "founder");
    for (const [url, name] of [["/admin/brands", "phone-brands"], ["/admin/cost", "phone-cost"]] as const) {
      await page.goto(url);
      await expectNoHorizontalScroll(page);
      await shot(page, info, "p1.6", name);
    }
  });
});
