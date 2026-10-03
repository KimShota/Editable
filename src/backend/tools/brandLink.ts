import "dotenv/config";
import { query } from "../../app/lib/db";
import { linkBrand } from "../brand/link";
import { getStorage } from "../storage";

/**
 * Links a brand's files to a workspace so the app can decide who sees them.
 *
 *   npm run brand:link -- --slug shogunai [--website https://…] [--workspace-name "Select"] [--member a@b.com]…
 *
 * Reads storage/brands/<slug>/intake.json the first time, and writes rows to
 * the database DATABASE_URL points at. Safe to rerun: an already-linked slug
 * only gains the members that are missing.
 */

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const options = (name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));

const main = async () => {
  const slug = option("--slug");
  if (!slug) throw new Error("usage: npm run brand:link -- --slug <slug> [--website <url>] [--workspace-name <name>] [--member <email>]…");
  const result = await linkBrand(query, getStorage(), {
    slug,
    websiteUrl: option("--website"),
    workspaceName: option("--workspace-name"),
    memberEmails: options("--member"),
  });
  console.log(`${result.created ? "linked" : "already linked"} ${slug}: brand ${result.brandId}, workspace ${result.workspaceId}`);
  if (result.membersAdded.length) console.log(`added members: ${result.membersAdded.join(", ")}`);
  if (result.missingEmails.length) console.log(`no account yet for: ${result.missingEmails.join(", ")} (they join when they sign up with an invite for this workspace)`);
};

main().catch((err) => {
  console.error("brand:link failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
