import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "../../../app/lib/password";
import type { QueryFn } from "../../../app/lib/db";
import { linkBrand } from "../../brand/link";
import { LocalStorage, type Storage } from "../../storage";
import { fixtureScript, fixtureSpec } from "./specFixture";

/**
 * A small, fake world for browser tests and manual runs
 * (src/backend/tools/testDbServer.ts): three real users, two brands in
 * different workspaces, and the files those brands would have on disk. None
 * of it is real customer data, and it is never written to a shared database.
 *
 *   founder  (admin)                  sees every brand
 *   member   (Acme's workspace)       sees only Acme
 *   outsider (Rival's workspace)      sees only Rival
 */

export const FIXTURE = {
  password: "test-password-123",
  users: {
    founder: { email: "founder@katalab.test", isAdmin: true },
    member: { email: "member@katalab.test", isAdmin: false },
    outsider: { email: "outsider@katalab.test", isAdmin: false },
  },
  brands: { acme: "acme", rival: "rival" },
  /** Card ids in Acme's plan, one per status the screens must handle. */
  cards: { draft: "card-draft", approved: "card-approved", review: "card-review", inReview: "card-internal", ready: "card-ready" },
} as const;

const intake = (company: string) => ({
  companyName: company,
  summary: `${company} makes things.`,
  isMultiProduct: false,
  products: [{ name: company, oneLiner: `${company} for everyone.`, type: "digital", url: null, features: ["fast"], priceNote: null, audience: "everyone", evidence: "hero" }],
  recommendedProductIndex: 0,
  recommendationReason: "only one",
  audience: "everyone",
  tone: ["friendly"],
  language: "en",
  otherLanguages: [],
  brandKit: { primaryColor: "#2563eb", secondaryColor: null, accentColor: null, textColor: null, backgroundColor: null, headingFont: null, bodyFont: null, logoUrl: null },
  assets: [],
  gaps: [],
});

// 1x1 transparent PNG: a real image the browser can decode.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const card = (id: string, day: number, status: string, hook: string) => ({
  id,
  day,
  sourceId: `src-${id}`,
  angle: `angle for ${id}`,
  hook,
  status,
  lowConfidence: false,
  alternates: [],
  history: [],
});

export const seedUiFixture = async (query: QueryFn, storageRoot: string): Promise<void> => {
  const storage = new LocalStorage(storageRoot);
  const user = async ({ email, isAdmin }: { email: string; isAdmin: boolean }) =>
    query(`insert into users (email, email_norm, password_hash, is_admin, email_verified_at) values ($1, $1, $2, $3, now())`, [email, hashPassword(FIXTURE.password), isAdmin]);
  for (const u of Object.values(FIXTURE.users)) await user(u);

  for (const [slug, company, member] of [
    [FIXTURE.brands.acme, "Acme", FIXTURE.users.member.email],
    [FIXTURE.brands.rival, "Rival", FIXTURE.users.outsider.email],
  ] as const) {
    await storage.putBuffer(`brands/${slug}/intake.json`, Buffer.from(JSON.stringify({ intake: intake(company) })));
    await linkBrand(query, storage, { slug, websiteUrl: `https://${slug}.test`, memberEmails: [member] });
  }

  const c = FIXTURE.cards;
  await storage.putBuffer(
    `brands/acme/plan.json`,
    Buffer.from(
      JSON.stringify({
        cycleId: "c1",
        startsOn: "2026-10-09",
        niche: null,
        rev: 0,
        cards: [
          card(c.draft, 1, "draft", `Hook words for ${c.draft}.`),
          card(c.approved, 2, "approved", `Hook words for ${c.approved}.`),
          card(c.inReview, 3, "internal_review", `Hook words for ${c.inReview}.`),
          card(c.review, 4, "needs_review", `Hook words for ${c.review}.`),
          card(c.ready, 5, "ready", `Hook words for ${c.ready}.`),
        ],
      }),
    ),
  );

  // A viral source, its spec and the card's adapted script, for each card.
  for (const id of Object.values(c)) {
    await seedSource(storage, "acme", `src-${id}`);
    await storage.putBuffer(`brands/acme/scripts/${id}.json`, Buffer.from(JSON.stringify(fixtureScript("acme", `src-${id}`, { angle: `angle for ${id}`, lines: [`Hook words for ${id}.`, `Middle words for ${id}.`, `Closing words for ${id}.`] }))));
  }

  // Media a customer may fetch…
  await storage.putBuffer(`brands/acme/character/sheet/front.png`, PNG);
  await storage.putBuffer(`brands/acme/videos/${c.ready}/final.mp4`, Buffer.alloc(4096, 1));
  // …and files a customer must never fetch, even from their own brand.
  await storage.putBuffer(`brands/acme/videos/${c.ready}/costs.jsonl`, Buffer.from(`${JSON.stringify({ usd: 12.34, provider: "higgsfield" })}\n`));
  await storage.putBuffer(`brands/acme/videos/${c.ready}/clips/s0.request.json`, Buffer.from(JSON.stringify({ prompt: "secret prompt" })));
  // Another brand's media, for the cross-brand check.
  await storage.putBuffer(`brands/rival/character/sheet/front.png`, PNG);
};

/** A downloaded viral video with its spec: what the source pool holds. */
const seedSource = async (storage: Storage, slug: string, sourceId: string): Promise<void> => {
  const spec = fixtureSpec(sourceId, { brand: slug, topic: `Topic of ${sourceId}`, hook: `Opening of ${sourceId}` });
  await storage.putBuffer(`brands/${slug}/sources/${sourceId}.mp4`, Buffer.alloc(4096, 5));
  await storage.putBuffer(`brands/${slug}/sources/${sourceId}.info.json`, Buffer.from(JSON.stringify({ webpage_url: spec.sourceUrl, uploader: "someone", view_count: 54000 })));
  await storage.putBuffer(`brands/${slug}/sources/${sourceId}-sheet.jpg`, PNG);
  for (const shot of spec.shots) for (const kf of shot.keyframes) await storage.putBuffer(kf.key, PNG);
  await storage.putBuffer(`brands/${slug}/sources/specs/${sourceId}.json`, Buffer.from(JSON.stringify(spec)));
};

/** Wipes and recreates the fixture's storage directory. */
export const resetStorage = (storageRoot: string): void => {
  fs.rmSync(storageRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(storageRoot, "brands"), { recursive: true });
};
