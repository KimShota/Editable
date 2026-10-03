import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { STORAGE_ROOT } from "./env";
import { expectNoHorizontalScroll, resetFixture, shot, signInAndOpenCalendar, startSessions } from "./helpers";

/**
 * P1.5 Onboarding (plan/ui-ux-full-flow.md §3): the five-step setup, replayed
 * from a brand's real files. Only an admin in demo mode can reach it, and it
 * generates and saves nothing except the one real action, picking the angle.
 */

test.beforeEach(async () => {
  await resetFixture();
  await startSessions();
});

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1440) < 768;
const wizard = (step: string, slug = "acme") => `/onboarding/${step}?replay=${slug}`;

/** Signs in as the founder and turns demo mode on. */
const demo = async (page: Page) => {
  await signInAndOpenCalendar(page, "founder");
  expect((await page.request.post("/api/admin/demo", { data: { on: true } })).ok()).toBe(true);
};
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(STORAGE_ROOT, rel), "utf8"));

test.describe("who can reach the wizard", () => {
  test("a customer is sent to their calendar", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    await page.goto(wizard("website"));
    await expect(page).toHaveURL(/\/calendar$/);
  });

  test("the founder needs demo mode, and is sent to turn it on", async ({ page }) => {
    await signInAndOpenCalendar(page, "founder");
    await page.goto(wizard("website"));
    await expect(page).toHaveURL(/\/admin\/demo$/);
  });

  test("without a replay brand there is nothing to replay", async ({ page }) => {
    await demo(page);
    await page.goto("/onboarding/website");
    await expect(page).toHaveURL(/\/calendar$/);
  });

  test("unknown steps and brands are not found", async ({ page }) => {
    await demo(page);
    expect((await page.goto(wizard("billing")))?.status()).toBe(404);
    expect((await page.goto(wizard("website", "no-such-brand")))?.status()).toBe(404);
    expect((await page.goto(wizard("website", "Not A Slug")))?.status()).toBe(404);
  });

  test("an anonymous visitor is sent to log in", async ({ page }) => {
    await page.goto(wizard("website"));
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("the demo switch", () => {
  test("the founder turns it on and off, and the replay links follow", async ({ page }, info) => {
    await signInAndOpenCalendar(page, "founder");
    await page.goto("/admin/demo");
    await expect(page.getByRole("heading", { name: "Demo mode is off" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Replay setup for/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Turn demo mode on" }).click();
    await expect(page.getByRole("heading", { name: "Demo mode is on" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Replay setup for Acme" })).toHaveAttribute("href", "/onboarding/website?replay=acme");
    await expect(page.getByRole("link", { name: "Replay setup for Rival" })).toBeVisible();
    await shot(page, info, "p1.5", "demo-launcher");

    await page.getByRole("button", { name: "Turn demo mode off" }).click();
    await expect(page.getByRole("heading", { name: "Demo mode is off" })).toBeVisible();
    await page.goto(wizard("website"));
    await expect(page).toHaveURL(/\/admin\/demo$/);
  });

  test("a customer cannot reach it or switch it on", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    expect((await page.goto("/admin/demo"))?.status()).toBe(404);
    expect((await page.request.post("/api/admin/demo", { data: { on: true }, failOnStatusCode: false })).status()).toBe(404);
    // …and a forged cookie means nothing without being the founder.
    await page.context().addCookies([{ name: "katalab_demo", value: "1", url: page.url() }]);
    await page.goto(wizard("website"));
    await expect(page).toHaveURL(/\/calendar$/);
  });

  test("a bad request is refused", async ({ page }) => {
    await signInAndOpenCalendar(page, "founder");
    expect((await page.request.post("/api/admin/demo", { data: { on: "yes" }, failOnStatusCode: false })).status()).toBe(400);
  });
});

test.describe("walking through the setup", () => {
  test("step 1 shows what was read from the website, in a form that can be corrected", async ({ page }, info) => {
    await demo(page);
    await page.goto(wizard("website"));
    await expect(page.getByRole("note")).toContainText("This is a replay of how Acme was set up. Nothing is generated and nothing is saved.");
    await expect(page.getByRole("heading", { name: "Here is what we found on your website", level: 1 })).toBeVisible();

    await expect(page.getByLabel("Company name")).toHaveValue("Acme");
    await expect(page.getByLabel("Product name")).toHaveValue("Acme");
    await expect(page.getByLabel("Application or software".replace("Application or software", "An app or software"))).toBeChecked();
    await expect(page.getByLabel("What it does, one per line")).toHaveValue("fast");
    await expect(page.getByRole("list", { name: "Tone" }).getByRole("listitem")).toHaveText(["friendly"]);
    await expect(page.getByLabel("Main color")).toHaveValue("#2563eb");
    await expect(page.getByLabel("Second color")).toHaveAttribute("placeholder", "Not found");
    await expect(page.getByText("We did not find pictures on your site.")).toBeVisible();

    // The form is real but the replay keeps nothing.
    await page.getByLabel("Company name").fill("Acme Ltd");
    await page.reload();
    await expect(page.getByLabel("Company name")).toHaveValue("Acme");
    await shot(page, info, "p1.5", "step-website");
  });

  test("the steps are marked as you go, and Back and Continue keep the replay", async ({ page }) => {
    await demo(page);
    await page.goto(wizard("website"));
    const rail = page.getByRole("navigation", { name: "Setup steps" });
    await expect(rail.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Back" })).toHaveCount(0); // first step
    await page.getByRole("link", { name: "Continue" }).click();
    await expect(page).toHaveURL(new RegExp("/onboarding/character\\?replay=acme"));
    await expect(rail.locator('[aria-current="step"]')).toHaveAttribute("href", wizard("character"));
    await page.getByRole("link", { name: "Back" }).click();
    await expect(page).toHaveURL(new RegExp("/onboarding/website\\?replay=acme"));
    // A step already seen is shown straight away, not replayed.
    await expect(page.getByLabel("Company name")).toBeVisible();
    await expect(page.locator("[data-task-status]")).toHaveCount(0);
  });

  test("step 2 goes from concepts to a locked character sheet", async ({ page }, info) => {
    await demo(page);
    await page.goto(wizard("character"));
    const stages = page.getByRole("list", { name: "Character stages" });
    await expect(stages.locator('[aria-current="step"]')).toHaveText("Concepts");

    await expect(page.getByRole("radio", { name: "Aria" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Bolt" })).not.toBeChecked();
    await expect(page.getByText("Aria shows Acme to people who are short on time.")).toBeVisible();
    await page.getByRole("button", { name: "See Aria drawn" }).click();

    await expect(stages.locator('[aria-current="step"]')).toHaveText("Drawings");
    await expect(page.getByRole("radio", { name: /Version/ })).toHaveCount(3); // only the chosen concept's drawings
    await expect(page.getByAltText("Drawing c0-v0")).toBeVisible();
    await page.getByRole("radio", { name: "Version 2" }).check();
    await page.getByRole("button", { name: "Refine this one" }).click();

    await expect(stages.locator('[aria-current="step"]')).toHaveText("Refine");
    await expect(page.getByLabel("Describe a change, or add a reference photo")).toBeDisabled();
    await expect(page.getByAltText("The drawing you picked")).toBeVisible();
    await expect(page.getByAltText(/Refinement/)).toHaveCount(2);
    await expect(page.getByRole("radio", { name: "Chosen" })).toBeChecked();
    await page.getByRole("button", { name: "Lock this character" }).click();

    await expect(page.getByRole("heading", { name: "Aria", level: 2 })).toBeVisible();
    await expect(page.getByTestId("locked")).toHaveText("Locked for this brand");
    await expect(page.getByRole("list", { name: "Character sheet" }).getByRole("listitem")).toHaveCount(9);
    await expect(page.getByAltText("Aria, Front")).toBeVisible();
    await expect(page.getByAltText("Aria, With its prop")).toBeVisible();
    await expect(page.getByText("A realistic creator.")).toBeVisible();
    await shot(page, info, "p1.5", "step-character-locked");
    await page.getByRole("button", { name: "Back to refining" }).click();
    await expect(stages.locator('[aria-current="step"]')).toHaveText("Refine");
  });

  test("step 3 auditions voices, hears the chosen one, and locks it", async ({ page }, info) => {
    await demo(page);
    await page.goto(wizard("voice"));
    await expect(page.getByLabel("Voice A saying the line")).toHaveAttribute("src", /\/api\/media\/brands\/acme\/character\/voice\/d0-0\.mp3/);
    await expect(page.locator("audio")).toHaveCount(4); // three auditions and the sample
    await expect(page.getByRole("radio", { name: "Voice B" })).toBeChecked(); // the one that was chosen
    await expect(page.getByLabel("Aria speaking in Aria (Test)")).toHaveAttribute("src", /sample\.mp3/);
    await expect(page.getByRole("img", { name: "Aria" })).toBeVisible(); // the portrait

    // Only the chosen voice has a recording of the character: the screen says so instead of playing the wrong one.
    await page.getByRole("radio", { name: "Voice A" }).check();
    await expect(page.getByText("only the voice that was chosen has a recording")).toBeVisible();
    await expect(page.getByLabel("Aria speaking in Aria (Test)")).toHaveCount(0);
    await page.getByRole("radio", { name: "Voice B" }).check();
    await expect(page.getByLabel("Aria speaking in Aria (Test)")).toBeVisible();

    await page.getByRole("button", { name: "Lock this voice" }).click();
    await expect(page.getByTestId("voice-locked")).toHaveText("Locked for this brand");
    await expect(page.getByRole("radio", { name: "Voice A" })).toBeDisabled();
    await shot(page, info, "p1.5", "step-voice");
  });

  test("step 4 proposes angles, locks the pick, and the pick reaches the plan", async ({ page }, info) => {
    test.setTimeout(60_000);
    await demo(page);
    await page.goto(wizard("niche"));
    await expect(page.getByText("No angles proposed yet")).toBeVisible();
    await expect(page.getByText("This asks the AI and costs a few cents.")).toBeVisible();
    await page.getByRole("button", { name: "Propose angles" }).click();
    await expect(page.locator("[data-angle]")).toHaveCount(4, { timeout: 30_000 });
    await shot(page, info, "p1.5", "step-niche");

    const use = page.getByRole("button", { name: "Use this angle" });
    await expect(use).toBeDisabled();
    await expect(page.getByText(/Proof of what is working in each angle comes with live research/)).toBeVisible();
    await page.getByRole("radio", { name: "Mistakes your team keeps making" }).check();
    await expect(use).toBeEnabled();
    await use.click();
    await expect(page).toHaveURL(new RegExp("/onboarding/plan\\?replay=acme"));

    // The pick is real: saved, and locked into the plan.
    expect(readJson("brands/acme/niche.json").chosenAngleId).toBe("mistakes-your-team-keeps-making");
    expect(readJson("brands/acme/plan.json").niche).toEqual({ angleId: "mistakes-your-team-keeps-making", title: "Mistakes your team keeps making" });

    await page.goto(wizard("niche"));
    await expect(page.getByRole("status").filter({ hasText: "Your angle for this cycle is" })).toContainText("Mistakes your team keeps making");
    await expect(page.getByRole("radio", { name: "Mistakes your team keeps making" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Behind the feature" })).toBeDisabled();
  });

  test("step 5 shows the real plan and leads to it", async ({ page }, info) => {
    await demo(page);
    await page.goto(wizard("plan"));
    await expect(page.getByTestId("plan-summary")).toHaveText("5 videos planned for your first 14 days.");
    await expect(page.getByRole("link", { name: "Review your plan" })).toHaveCount(1); // one call to action, not two
    await expect(page.getByRole("link", { name: "Continue" })).toHaveCount(0);
    await shot(page, info, "p1.5", "step-plan");
    await page.getByRole("link", { name: "Review your plan" }).click();
    await expect(page).toHaveURL(/\/plan$/);
  });

  test("every step has exactly one way back and one way on", async ({ page }) => {
    await demo(page);
    for (const step of ["character", "voice", "niche", "plan"]) {
      await page.goto(wizard(step));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("link", { name: "Back", exact: true }), `${step}: Back`).toHaveCount(1);
    }
    for (const step of ["website", "character", "voice"]) {
      await page.goto(wizard(step));
      await expect(page.getByRole("link", { name: "Continue", exact: true }), `${step}: Continue`).toHaveCount(1);
    }
  });

  test("a brand with no character, voices or angles says so instead of breaking", async ({ page }) => {
    await demo(page);
    await page.goto(wizard("website", "rival"));
    await expect(page.getByLabel("Company name")).toHaveValue("Rival");
    await page.goto(wizard("character", "rival"));
    await expect(page.getByText("This brand has no locked character yet.")).toBeVisible();
    await page.goto(wizard("voice", "rival"));
    await expect(page.getByText("No voices were auditioned for this brand.")).toBeVisible();
    await page.goto(wizard("plan", "rival"));
    await expect(page.getByText("Your plan is ready to be built.")).toBeVisible();
  });
});

test.describe("choosing the angle", () => {
  const api = "/api/brands/acme/niche";

  test("is refused until angles exist, and for another brand's member", async ({ page }) => {
    await signInAndOpenCalendar(page, "member");
    const res = await page.request.post(api, { data: { angleId: "x" }, failOnStatusCode: false });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/no angles to choose/);
    expect((await page.request.post(api, { data: {}, failOnStatusCode: false })).status()).toBe(400);
    await page.context().clearCookies();
    await signInAndOpenCalendar(page, "outsider");
    expect((await page.request.post(api, { data: { angleId: "x" }, failOnStatusCode: false })).status()).toBe(404);
  });

  test("proposing is the founder's, and once the plan carries an angle it is locked", async ({ page }) => {
    test.setTimeout(60_000);
    await signInAndOpenCalendar(page, "member");
    expect((await page.request.post("/api/admin/brands/acme/niche", { data: {}, failOnStatusCode: false })).status()).toBe(404);
    await page.context().clearCookies();
    await signInAndOpenCalendar(page, "founder");

    const { taskId } = await (await page.request.post("/api/admin/brands/acme/niche", { data: {} })).json();
    await expect.poll(async () => (await (await page.request.get(`/api/tasks/${taskId}`)).json()).status, { timeout: 20_000 }).toBe("done");
    const angles = readJson("brands/acme/niche.json").angles as { id: string }[];
    expect(angles).toHaveLength(4);

    expect((await page.request.post(api, { data: { angleId: "made-up" }, failOnStatusCode: false })).status()).toBe(409);
    expect((await page.request.post(api, { data: { angleId: angles[0].id } })).ok()).toBe(true);
    expect((await page.request.post(api, { data: { angleId: angles[0].id } })).ok()).toBe(true); // the same again is harmless
    const other = await page.request.post(api, { data: { angleId: angles[1].id }, failOnStatusCode: false });
    expect(other.status()).toBe(409);
    expect((await other.json()).error).toMatch(/locked for this cycle/);

    // Proposing again would replace what the plan is built on: the job refuses.
    const again = await (await page.request.post("/api/admin/brands/acme/niche", { data: {} })).json();
    await expect.poll(async () => (await (await page.request.get(`/api/tasks/${again.taskId}`)).json()).status, { timeout: 20_000 }).toBe("failed");
    expect((await (await page.request.get(`/api/tasks/${again.taskId}`)).json()).error).toMatch(/locked for this cycle/);
    expect(readJson("brands/acme/niche.json").chosenAngleId).toBe(angles[0].id);
  });
});

test.describe("on a phone", () => {
  test("every step fits the screen", async ({ page }, info) => {
    test.skip(!isPhone(page), "phone only");
    await demo(page);
    for (const step of ["website", "character", "voice", "plan"]) {
      await page.goto(wizard(step));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText(/^Step \d of 5/)).toBeVisible();
      await expectNoHorizontalScroll(page);
      await shot(page, info, "p1.5", `phone-${step}`);
    }
  });
});
