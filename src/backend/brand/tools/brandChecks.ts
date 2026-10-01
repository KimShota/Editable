import { buildConceptPrompt } from "../../character/concepts";
import { candidatePrompt, refinePrompt, sheetViewPrompt } from "../../character/images";
import type { MascotConcept } from "../../character/schemas";
import { anthropicCostUsd, dbSink, googleImageCostEntry } from "../../cost/ledger";
import { makeChecker, near } from "../../tools/checks";
import { makeTestDb } from "../../tools/testDb";
import { buildIntakePrompt } from "../intake/extract";
import { assertFetchableUrl, fetchSite, pickExtraPages } from "../intake/fetchSite";
import { type BrandIntake, normalizeIntake } from "../intake/schemas";
import { countColors, decodeEntities, fontsFromCss, fontsFromHtml, parsePage, visibleText } from "../intake/signals";
import { createBrandFromIntake, createWorkspace } from "../store";

/**
 * The website intake and brand store, with no network and no API key:
 * signals are parsed from fixture HTML, fetchSite runs against a fake fetch,
 * and the store runs on PGlite with every migration applied.
 *
 *   npm run test:brand
 */

const FIXTURE_HTML = `<!doctype html>
<html lang="ja" class="noto_sans_jp_5f3f25df-module__tCv54W__variable">
<head>
  <title>Acme &amp; Co — Snacks</title>
  <meta name="description" content="Crunchy snacks for students">
  <meta property="og:image" content="/og.png">
  <meta name="theme-color" content="#FF6600">
  <link rel="stylesheet" href="/main.css">
  <link rel="alternate" hreflang="en" href="https://acme.test/en/">
  <link rel="icon" href="/favicon.ico">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&amp;family=Inter&amp;display=swap" rel="stylesheet">
  <style>.hero{color:#123;background:#ffffff}</style>
  <script>var x = "<p>not text</p>"; #abcdef</script>
</head>
<body>
  <!-- hidden comment -->
  <h1>Snack <b>better</b></h1>
  <p>Made for&nbsp;exams.</p><p>Second&#8212;line</p>
  <a href="/products/crunch">Our products</a>
  <a href="/privacy">Privacy</a>
  <a href="#top">Top</a>
  <a href="mailto:x@acme.test">Mail</a>
  <a href="https://other.test/app">App</a>
  <img src="/img/bag.jpg" alt="Snack bag">
  <img src="data:image/png;base64,AAA" alt="inline">
  <div style="color: #FF6600"></div>
</body></html>`;

const intakeFixture = (): BrandIntake => ({
  companyName: "Acme",
  summary: "Snacks.",
  isMultiProduct: false,
  products: [
    { name: "Crunch", oneLiner: "A snack.", type: "physical", url: null, features: ["crunchy", "cheap"], priceNote: "$2", audience: "students", evidence: "hero" },
    { name: "Other", oneLiner: "Another.", type: "digital", url: "https://other.test", features: [], priceNote: null, audience: "", evidence: "links" },
  ],
  recommendedProductIndex: 7,
  recommendationReason: "only one",
  audience: "students",
  tone: ["playful", "bold", "warm", "fun", "extra"],
  language: "ja",
  otherLanguages: ["en"],
  brandKit: {
    primaryColor: "#FF6600",
    secondaryColor: "orange",
    accentColor: "#12",
    textColor: "#111111",
    backgroundColor: null,
    headingFont: "Playfair Display",
    bodyFont: "Inter",
    logoUrl: "https://invented.test/logo.png",
  },
  assets: [
    { url: "https://acme.test/img/bag.jpg", kind: "photo", productName: "Crunch" },
    { url: "https://acme.test/og.png", kind: "other", productName: "Other" },
    { url: "https://invented.test/x.png", kind: "photo", productName: null },
  ],
  gaps: ["product photos on white"],
});

const main = async () => {
  const t = makeChecker();

  // -------------------------------------------------------------------
  console.log("signals (pure)");
  t.check("decodes named and numeric entities", decodeEntities("a&amp;b&nbsp;c&#8212;d&#x41;&bogus;") === "a&b c—dA&bogus;");
  const text = visibleText(FIXTURE_HTML);
  t.check("visible text keeps body copy", text.includes("Snack better") && text.includes("Made for exams."), text);
  t.check("visible text drops scripts, comments and the head", !text.includes("not text") && !text.includes("hidden comment") && !text.includes("Acme &"), text);
  t.check("block elements become line breaks", text.split("\n").includes("Second—line"), text);

  const page = parsePage(FIXTURE_HTML, "https://acme.test/");
  t.check("reads <html lang>", page.lang === "ja");
  t.check("reads the title with entities decoded", page.title === "Acme & Co — Snacks", String(page.title));
  t.check("reads meta description", page.meta.description === "Crunchy snacks for students");
  t.check("hreflang alternates are absolute", page.alternates.en === "https://acme.test/en/");
  t.check("stylesheets resolve to absolute URLs", page.stylesheets.includes("https://acme.test/main.css"), page.stylesheets.join());
  t.check("icons are collected", page.icons.includes("https://acme.test/favicon.ico"));
  t.check("headings are text only", page.headings[0] === "Snack better", page.headings.join("|"));
  const hrefs = page.links.map((l) => l.href);
  t.check("links skip anchors and mailto", !hrefs.some((h) => h.includes("#top") || h.startsWith("mailto")), hrefs.join());
  t.check("same-site links are internal, others external", page.links.find((l) => l.href === "https://acme.test/products/crunch")?.external === false && page.links.find((l) => l.href === "https://other.test/app")?.external === true);
  t.check("og:image leads the image list", page.images[0]?.src === "https://acme.test/og.png", JSON.stringify(page.images));
  t.check("data: images are dropped", !page.images.some((i) => i.src.startsWith("data:")));
  t.check("img alt is kept", page.images.some((i) => i.src === "https://acme.test/img/bag.jpg" && i.alt === "Snack bag"));
  t.check("theme-color and inline colours are counted, normalized", page.colors[0]?.hex === "#ff6600" && page.colors[0].count === 6, JSON.stringify(page.colors));
  t.check("3-digit hex expands", page.colors.some((c) => c.hex === "#112233"));
  t.check("colours inside <script> are not counted", !page.colors.some((c) => c.hex === "#abcdef"));
  t.check("next/font class names become font hints", fontsFromHtml(FIXTURE_HTML).includes("Noto Sans JP"), fontsFromHtml(FIXTURE_HTML).join());
  t.check("Google Fonts families are read", page.fonts.includes("Playfair Display") && page.fonts.includes("Inter"), page.fonts.join());

  const cssFonts = fontsFromCss(`body{font-family:"Brand Sans", var(--x), -apple-system, "Segoe UI", Roboto, sans-serif} code{font-family:ui-monospace,"Noto Color Emoji")}`);
  t.check("CSS fonts drop generics, variables and OS fallbacks", cssFonts.join() === "Brand Sans", cssFonts.join());
  t.check("countColors merges case and shorthand", countColors("#FFF #ffffff #fff").find((c) => c.hex === "#ffffff")?.count === 3);

  // -------------------------------------------------------------------
  console.log("fetchSite (fake network)");
  t.throws("refuses localhost", () => assertFetchableUrl("http://localhost:3000"), /internal host/);
  t.throws("refuses private ranges", () => assertFetchableUrl("http://192.168.1.4/"), /internal host/);
  t.throws("refuses non-http schemes", () => assertFetchableUrl("file:///etc/passwd"), /http/);
  t.check("adds https:// to a bare domain", assertFetchableUrl("acme.test").toString() === "https://acme.test/");

  const langPage = parsePage(
    `<a href="/en/pricing">Pricing</a><a href="/en/careers">Careers</a><a href="/ja/pricing">料金</a><a href="/en/blog/post">Blog</a><a href="/en/features">Features</a>`,
    "https://acme.test/en/",
  );
  const extra = pickExtraPages(langPage, 5);
  t.check("extra pages prefer product-ish paths", extra[0] === "https://acme.test/en/pricing" || extra[0] === "https://acme.test/en/features", extra.join());
  t.check("extra pages skip careers", !extra.some((u) => u.includes("careers")));
  t.check("extra pages stay in the entry's language prefix", !extra.some((u) => u.includes("/ja/")), extra.join());

  const served: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const u = String(input);
    served.push(u);
    const body =
      u === "https://acme.test/" ? FIXTURE_HTML : u === "https://acme.test/main.css" ? `h1{font-family:"Brand Sans";color:#00AA00} p{color:#00aa00}` : u === "https://acme.test/products/crunch" ? `<h1>Crunch</h1><p>Only $2.</p>` : null;
    return body === null ? new Response("nope", { status: 404 }) : new Response(body, { status: 200 });
  }) as typeof fetch;
  const site = await fetchSite("https://acme.test/", { fetchImpl: fakeFetch });
  t.check("fetches the entry page and one product page", site.pages.map((p) => p.url).join() === "https://acme.test/,https://acme.test/products/crunch", site.pages.map((p) => p.url).join());
  t.check("never fetches the privacy page", !served.some((u) => u.includes("privacy")));
  t.check("stylesheet fonts are merged in", site.fonts.includes("Brand Sans"), site.fonts.join());
  t.check("stylesheet colours are merged in", site.colors.some((c) => c.hex === "#00aa00" && c.count === 2), JSON.stringify(site.colors));
  await t.rejects("an unreachable entry page is a clear error", () => fetchSite("https://down.test/", { fetchImpl: fakeFetch }), /could not fetch/);

  const prompt = buildIntakePrompt(site);
  t.check("the prompt carries measured colours, fonts and images", prompt.includes("#ff6600") && prompt.includes("Brand Sans") && prompt.includes("https://acme.test/img/bag.jpg"));
  t.check("the prompt marks external links", prompt.includes("https://other.test/app [ext]"));

  // -------------------------------------------------------------------
  console.log("normalizeIntake (pure)");
  const norm = normalizeIntake(intakeFixture(), { imageUrls: new Set(["https://acme.test/img/bag.jpg", "https://acme.test/og.png"]) });
  t.check("an out-of-range product index is clamped", norm.recommendedProductIndex === 1);
  t.check("valid hex is kept, lower-cased", norm.brandKit.primaryColor === "#ff6600");
  t.check("invalid colours become null", norm.brandKit.secondaryColor === null && norm.brandKit.accentColor === null);
  t.check("an invented logo URL is dropped", norm.brandKit.logoUrl === null);
  t.check("invented asset URLs are dropped", norm.assets.length === 2 && !norm.assets.some((a) => a.url.includes("invented")));
  t.check("tone is capped at 4", norm.tone.length === 4);

  // -------------------------------------------------------------------
  console.log("cost ledger (pure)");
  t.check("opus 5.5 pricing", near(anthropicCostUsd("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 100_000 }), 6, 1e-9));
  t.check("cache reads and writes are priced", near(anthropicCostUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }), 5 + 0.4, 1e-9));
  t.throws("an unknown model is an error, not $0", () => anthropicCostUsd("claude-made-up", { input_tokens: 1, output_tokens: 1 }), /no price/);

  // -------------------------------------------------------------------
  console.log("brand store (PGlite)");
  const { query } = await makeTestDb();
  const [user] = await query(`insert into users (email, email_norm, password_hash) values ('a@b.c', 'a@b.c', 'x') returning id`);
  const workspaceId = await createWorkspace(query, { name: "Acme", ownerUserId: String(user.id) });
  const members = await query(`select user_id from workspace_members where workspace_id = $1`, [workspaceId]);
  t.check("the owner becomes a member", members.length === 1 && String(members[0].user_id) === String(user.id));

  const created = await createBrandFromIntake(query, { workspaceId, websiteUrl: "https://acme.test/", intake: norm, productIndex: 0 });
  const [brand] = await query(`select * from brands where id = $1`, [created.brandId]);
  t.check("the brand is named after the promoted product", brand.name === "Crunch");
  t.check("the brand keeps language and tone", brand.language === "ja" && Array.isArray(brand.tone) && (brand.tone as string[]).length === 4, JSON.stringify(brand.tone));
  t.check("the raw intake is stored", (brand.intake as BrandIntake).companyName === "Acme");
  t.check("post time defaults to 18:00", String(brand.post_time).startsWith("18:00"), String(brand.post_time));
  const [product] = await query(`select * from products where id = $1`, [created.productId]);
  t.check("the product row has type and features", product.type === "physical" && (product.features as string[]).join() === "crunchy,cheap");
  const assets = await query(`select kind, source_url from product_assets where product_id = $1`, [created.productId]);
  t.check("only this product's assets are attached", assets.length === 1 && assets[0].source_url === "https://acme.test/img/bag.jpg", JSON.stringify(assets));
  const [kit] = await query(`select * from brand_kits where brand_id = $1`, [created.brandId]);
  t.check("the brand kit is drafted", kit.primary_color === "#ff6600" && kit.heading_font === "Playfair Display" && kit.secondary_color === null);
  await t.rejects("a missing product index is refused", () => createBrandFromIntake(query, { workspaceId, websiteUrl: "x", intake: norm, productIndex: 9 }), /no product at index 9/);
  await t.rejects("a product type outside the enum is refused by the table", () =>
    query(`insert into products (brand_id, name, type) values ($1, 'x', 'hologram')`, [created.brandId]),
  );

  await dbSink(query)({ brandId: created.brandId, provider: "anthropic", model: "claude-opus-5-5", operation: "brand_intake", units: { input_tokens: 10 }, usd: 0.0585, ref: "https://acme.test/" });
  const [cost] = await query(`select sum(usd)::float as usd, count(*)::int as n from cost_ledger where brand_id = $1`, [created.brandId]);
  t.check("dbSink records a cost row", cost.n === 1 && near(Number(cost.usd), 0.0585, 1e-9), JSON.stringify(cost));
  const quietSink = dbSink(async () => {
    throw new Error("db down");
  });
  let swallowed = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    await quietSink({ provider: "p", model: "m", operation: "o", units: {}, usd: 1 });
  } catch {
    swallowed = false;
  } finally {
    console.warn = warn;
  }
  t.check("a failing ledger write never throws", swallowed);

  await query(`delete from workspaces where id = $1`, [workspaceId]);
  const left = await query(`select (select count(*) from brands)::int as b, (select count(*) from products)::int as p, (select count(*) from brand_kits)::int as k`);
  t.check("deleting a workspace cascades to its brands", left[0].b === 0 && left[0].p === 0 && left[0].k === 0, JSON.stringify(left[0]));
  const [kept] = await query(`select count(*)::int as n from cost_ledger`);
  t.check("…while its cost history is kept", kept.n === 1);

  // Mascot prompts.
  const concept: MascotConcept = {
    name: "Maru",
    form: "a round owl",
    style: "3d_render",
    oneLine: "An owl.",
    personality: ["calm", "certain"],
    appearance: "Lavender egg-shaped body.",
    signatureProp: "a glowing decision card",
    catchphrase: "Sorted.",
    voiceDescription: "Calm, low.",
    whyItFits: "Owls are wise.",
    contentAngle: "Sorting inboxes.",
  };
  const conceptPrompt = buildConceptPrompt(intakeFixture(), 0, 3, "make it cute");
  t.check("concept prompt names the product, count and direction", conceptPrompt.includes(intakeFixture().products[0].name) && conceptPrompt.includes("exactly 3") && conceptPrompt.includes("make it cute"));
  const cand = candidatePrompt(concept, "bolder");
  t.check("candidate prompt carries appearance, style and the no-text rule", cand.includes("Lavender egg-shaped") && cand.includes("3D animated-film") && cand.includes("No text") && cand.includes("Variation: bolder"));
  t.check("refine prompt without a feature reference mentions no second image", !refinePrompt(concept, "add lips").includes("second reference"));
  t.check("refine prompt with a feature reference borrows shape only", /second reference image.*Do not copy its realism/.test(refinePrompt(concept, "add lips", true)));
  t.check("only the with_prop view describes the prop", sheetViewPrompt(concept, "with_prop").includes("glowing decision card") && !sheetViewPrompt(concept, "front").includes("glowing decision card"));

  // Image cost.
  t.check("gemini-3-pro-image is $0.134 an image", near(googleImageCostEntry("gemini-3-pro-image", 3, "x").usd, 0.402, 1e-9));
  t.throws("an unpriced image model throws instead of recording $0", () => googleImageCostEntry("unknown-image-model", 1, "x"), /no price/);

  t.finish("brand");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
