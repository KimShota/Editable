import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { STORAGE_ROOT } from "./env";
import { expectNoHorizontalScroll, resetFixture, shot, sql } from "./helpers";

/**
 * The marketing page at "/" (plan/landing-page-founder-proof.md): the founder's
 * story, the pinned five-sames breakdown, and the two-step lead form that
 * stores a lead and emails the founder. No login anywhere on this page.
 */

test.beforeEach(async ({ page }) => {
  await resetFixture();
  // The lead endpoint limits by IP, and every test shares localhost.
  const octet = () => randomInt(1, 251);
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `10.${octet()}.${octet()}.${octet()}` });
});

const outbox = (): { to: string; subject: string; html: string }[] => {
  const file = path.join(STORAGE_ROOT, "outbox.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const leads = () => sql("select website, email, referrer, utm, completed_at from leads order by created_at");
const hero = (page: Page) => page.locator("#get-started");

test.describe("the page", () => {
  test("tells the story: headline, both numbers, five reels, no login needed", async ({ page }, info) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("I posted the same video again and again.");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("200K followers");
    await expect(page.getByText("200K+", { exact: true })).toBeVisible();
    await expect(page.getByText("4,200+", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".wall__item")).toHaveCount(5);
    await expect(page.getByRole("link", { name: "Get your character" })).toBeVisible();
    await expect(page.getByRole("link", { name: "or talk to Shota" }).first()).toHaveAttribute("href", /calendar\.app\.google/);
    await expectNoHorizontalScroll(page);
    await shot(page, info, "landing", "page");
  });

  test("the reels and clips are public files, served without a session", async ({ request }) => {
    for (const file of ["reel-1.mp4", "reel-5.jpg", "nova-peek.mp4", "peek-original-blur.jpg", "brainlot-avatar.png"]) {
      const res = await request.get(`/landing/${file}`);
      expect(res.status(), file).toBe(200);
    }
  });

  test("one light palette from the hero to the footer, nav included", async ({ page }) => {
    await page.goto("/");
    const ink = "rgb(10, 10, 12)";
    const color = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).color);
    const background = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    // The same dark ink on every heading, the pinned stage on white, and a light nav, top and bottom.
    for (const sel of [".hero__title", ".sames__title", ".bridge__title", ".pivot__title", ".cta__title"]) expect(await color(sel), sel).toBe(ink);
    expect(await background(".sames__stage")).toBe("rgb(255, 255, 255)");
    for (const y of [0, "bottom"] as const) {
      await page.evaluate((to) => window.scrollTo(0, to === "bottom" ? document.documentElement.scrollHeight : 0), y);
      expect(await background(".nav")).toMatch(/^rgba\(255, 255, 255/);
      expect(await color(".nav__logo")).toBe(ink);
    }
    await expect(page.locator(".mk-dark, .fade")).toHaveCount(0);
  });

  test("walking the five sames highlights each one in turn", async ({ page }, info) => {
    await page.goto("/");
    await page.waitForTimeout(1500);
    const stage = await page.locator(".sames__stage").evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const vh = page.viewportSize()!.height;
    const names = ["Same filming", "Same editing", "Same character", "Same topic", "Same flow"];
    for (const [i, name] of names.entries()) {
      await page.evaluate((y) => window.scrollTo(0, y), stage + ((i + 0.5) / 5) * 5 * 0.55 * vh);
      await expect(page.locator('.sames__list li[data-active="true"] h3')).toHaveText(name);
      await expect(page.locator(".ov[data-on='true']")).toHaveCount(1);
      if (i === 4) await shot(page, info, "landing", "flow-step");
    }
  });

  test("with reduced motion nothing autoplays and the five sames become five still cards", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator(".sames__card")).toHaveCount(5);
    await expect(page.locator(".sames__stage")).toHaveCount(0);
    const playing = await page.evaluate(() => [...document.querySelectorAll("video")].filter((v) => !v.paused).length);
    expect(playing).toBe(0);
    await expect(page.locator(".wall video").first()).toHaveAttribute("controls", "");
    await expect(page.locator(".hero__title .line").first()).toBeVisible();
  });
});

test.describe("the lead form", () => {
  test("a website, then an email, stores the lead and emails the founder", async ({ page }, info) => {
    await page.goto("/?utm_source=tiktok&utm_campaign=bio");
    await hero(page).getByLabel("Your website").fill("https://www.Example-Brand.com/shop");
    await hero(page).getByRole("button", { name: /Get your character/ }).click();

    await expect(hero(page).getByText("Nice, example-brand.com. Where should Shota send your character?")).toBeVisible();
    // Asking for the email has already stored the website, so a visitor who stops here still counts.
    expect(await leads()).toMatchObject([{ website: "https://www.example-brand.com/shop", email: null, completed_at: null }]);
    expect(outbox()).toHaveLength(0);

    await hero(page).getByLabel("Your email").fill("Owner@Example-Brand.com");
    await hero(page).getByRole("button", { name: /Send/ }).click();
    await expect(hero(page).getByRole("status")).toContainText("I'll look at example-brand.com myself");
    await expect(hero(page).getByRole("status")).toContainText("Owner@Example-Brand.com within 3 days");
    await shot(page, info, "landing", "lead-done");

    const rows = await leads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "owner@example-brand.com", utm: { utm_source: "tiktok", utm_campaign: "bio" } });
    expect(rows[0].completed_at).not.toBeNull();

    const mail = outbox();
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe("founder@katalab.test");
    expect(mail[0].subject).toContain("https://www.example-brand.com/shop");
    expect(mail[0].html).toContain("owner@example-brand.com");
    expect(mail[0].html).toContain("utm_source=tiktok");
  });

  test("a website that isn't one, or an email that isn't one, is refused with a message", async ({ page }) => {
    await page.goto("/");
    await hero(page).getByLabel("Your website").fill("not a website");
    await hero(page).getByRole("button", { name: /Get your character/ }).click();
    await expect(hero(page).getByRole("alert")).toContainText("doesn't look like a website");
    expect(await leads()).toHaveLength(0);

    await hero(page).getByLabel("Your website").fill("brand.io");
    await hero(page).getByRole("button", { name: /Get your character/ }).click();
    await expect(hero(page).getByLabel("Your email")).toBeVisible();
    await hero(page).getByLabel("Your email").fill("nope");
    await hero(page).getByRole("button", { name: /Send/ }).click();
    await expect(hero(page).getByRole("alert")).toContainText("email doesn't look right");
    expect(outbox()).toHaveLength(0);
    expect((await leads())[0]).toMatchObject({ website: "https://brand.io", email: null });
  });

  test("the bottom form works the same way", async ({ page }) => {
    await page.goto("/");
    const bottom = page.locator("#signup .lead");
    await bottom.getByLabel("Your website").fill("bottom-brand.com");
    await bottom.getByRole("button", { name: /Get your character/ }).click();
    await bottom.getByLabel("Your email").fill("hi@bottom-brand.com");
    await bottom.getByRole("button", { name: /Send/ }).click();
    await expect(bottom.getByRole("status")).toContainText("hi@bottom-brand.com");
    expect(outbox()).toHaveLength(1);
  });
});

test.describe("the lead endpoint", () => {
  test("a bot that fills the hidden field gets a fake success and nothing is stored", async ({ request }) => {
    const res = await request.post("/api/leads", { data: { step: "website", website: "spam.com", company: "Acme" } });
    expect(res.ok()).toBe(true);
    expect(await leads()).toHaveLength(0);
  });

  test("a lead can only be completed once, and unknown ids are refused", async ({ request }) => {
    const first = await request.post("/api/leads", { data: { step: "website", website: "once.com" } });
    const { id } = await first.json();
    expect((await request.post("/api/leads", { data: { step: "email", id, email: "a@once.com" } })).ok()).toBe(true);
    expect((await request.post("/api/leads", { data: { step: "email", id, email: "b@once.com" } })).status()).toBe(409);
    expect((await request.post("/api/leads", { data: { step: "email", id: "00000000-0000-4000-8000-000000000000", email: "c@once.com" } })).status()).toBe(409);
    expect((await request.post("/api/leads", { data: { step: "email", id: "not-an-id", email: "c@once.com" } })).status()).toBe(400);
    expect((await leads())[0]).toMatchObject({ email: "a@once.com" });
  });

  test("one address can only try so many times an hour", async ({ request }) => {
    // A fresh address per run: the limit lives in the server process, which every project shares.
    const headers = { "x-forwarded-for": `203.0.113.${randomInt(1, 251)}` };
    let limited = 0;
    for (let i = 0; i < 22; i++) {
      const res = await request.post("/api/leads", { headers, data: { step: "website", website: "bad" } });
      if (res.status() === 429) limited++;
    }
    expect(limited).toBe(2);
  });
});
