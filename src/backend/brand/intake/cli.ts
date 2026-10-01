import "dotenv/config";
import { consoleSink } from "../../cost/ledger";
import { getStorage } from "../../storage";
import { extractBrandIntake } from "./extract";
import { fetchSite } from "./fetchSite";
import type { BrandIntake } from "./schemas";

/**
 * Run the "paste your website" intake on one URL.
 *
 *   npm run intake -- <url>                     fetch, extract (one Claude call), print a summary
 *   npm run intake -- <url> --signals           only the measured signals, no Claude call
 *   npm run intake -- <url> --json              print the full BrandIntake as JSON
 *   npm run intake -- <url> --save --workspace <uuid> [--product <index>]
 *                                               also create the brand rows (needs DATABASE_URL)
 *
 * Every extraction is also kept at storage key intake/<host>/<timestamp>.json.
 */

const USAGE = "usage: npm run intake -- <url> [--signals] [--json] [--save --workspace <uuid> [--product <index>]]";

const option = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const printSummary = (intake: BrandIntake): void => {
  console.log(`\n${intake.companyName} — ${intake.summary}`);
  console.log(`language ${intake.language}${intake.otherLanguages.length ? ` (also ${intake.otherLanguages.join(", ")})` : ""} · tone ${intake.tone.join(", ")}`);
  console.log(`audience: ${intake.audience}`);
  console.log(`\nproducts${intake.isMultiProduct ? " (multi-product site)" : ""}:`);
  intake.products.forEach((p, i) => {
    const mark = i === intake.recommendedProductIndex ? "★" : " ";
    console.log(` ${mark} [${i}] ${p.name} (${p.type})${p.url ? ` ${p.url}` : ""}\n       ${p.oneLiner}`);
  });
  console.log(`\n  ★ recommended: ${intake.recommendationReason}`);
  const k = intake.brandKit;
  console.log(`\nbrand kit: primary ${k.primaryColor ?? "?"} · secondary ${k.secondaryColor ?? "?"} · accent ${k.accentColor ?? "?"} · text ${k.textColor ?? "?"} · bg ${k.backgroundColor ?? "?"}`);
  console.log(`           fonts ${k.headingFont ?? "?"} / ${k.bodyFont ?? "?"} · logo ${k.logoUrl ?? "none"}`);
  console.log(`\nassets (${intake.assets.length}):`);
  for (const a of intake.assets) console.log(`  ${a.kind.padEnd(10)} ${a.url}${a.productName ? `  (${a.productName})` : ""}`);
  console.log(`\nask the customer for:`);
  for (const g of intake.gaps) console.log(`  - ${g}`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const url = args.find((a, i) => !a.startsWith("--") && !["--workspace", "--product"].includes(args[i - 1]));
  if (!url) {
    console.error(USAGE);
    process.exit(1);
  }

  console.log(`fetching ${url}…`);
  const site = await fetchSite(url);
  console.log(`  ${site.pages.length} page(s): ${site.pages.map((p) => p.url).join(", ")}`);
  console.log(`  ${site.colors.length} colours, ${site.fonts.length} fonts, ${site.pages.reduce((n, p) => n + p.images.length, 0)} images`);

  if (args.includes("--signals")) {
    console.log(JSON.stringify(site, null, 2));
    return;
  }

  console.log("extracting…");
  const intake = await extractBrandIntake(site, { costSink: consoleSink });

  const host = new URL(site.pages[0].url).host;
  const key = `intake/${host}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await getStorage().putBuffer(key, Buffer.from(JSON.stringify({ url: site.pages[0].url, intake }, null, 2)));

  if (args.includes("--json")) console.log(JSON.stringify(intake, null, 2));
  else printSummary(intake);
  console.log(`\nsaved ${key}`);

  if (args.includes("--save")) {
    const workspaceId = option(args, "--workspace");
    if (!workspaceId) throw new Error("--save needs --workspace <uuid>");
    const productIndex = option(args, "--product") !== undefined ? Number(option(args, "--product")) : undefined;
    const { query } = await import("../../../app/lib/db");
    const { createBrandFromIntake } = await import("../store");
    const created = await createBrandFromIntake(query, { workspaceId, websiteUrl: site.pages[0].url, intake, productIndex });
    console.log(`created brand ${created.brandId} (product ${created.productId})`);
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
