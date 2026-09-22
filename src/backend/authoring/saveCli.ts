import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { authoringDir, formatsDir } from "../pipeline/paths";
import { DraftSchema } from "./schemas";
import { saveFormat } from "./save";

/**
 * npm run author:save -- --draft <draftId>
 *
 * Promotes authoring/<draftId>/draft.json straight into formats/<id>.json
 * — the CLI counterpart to the web app's save button (POST
 * /api/authoring/[draftId]/save), for a draft reviewed and edited
 * entirely on disk (e.g. by an agent following the reel-to-template
 * skill) rather than through the review UI. Re-validates with the exact
 * same FormatSchema loadFormat() uses (via save.ts's saveFormat).
 *
 * Also registers the reel in formats/meta/reels.json when draft.json's
 * own sourceUrl is a real link (not a local `--file` ingest) and no
 * entry for this format id exists yet — `npm run reels:sync` can then
 * keep its like/comment counts fresh the same way it does for every
 * hand-authored format.
 */

const REELS_META_PATH = path.join(formatsDir, "meta", "reels.json");

const registerReel = (formatId: string, sourceUrl: string) => {
  if (!/^https?:\/\//.test(sourceUrl)) return; // file:// ingest — nothing to record
  let meta: Record<string, unknown> = {};
  if (fs.existsSync(REELS_META_PATH)) {
    meta = JSON.parse(fs.readFileSync(REELS_META_PATH, "utf8"));
  }
  if (meta[formatId]) return; // don't clobber an existing (possibly hand-edited) entry
  meta[formatId] = { url: sourceUrl, uploader: "", likes: 0, comments: 0, fetchedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(REELS_META_PATH), { recursive: true });
  fs.writeFileSync(REELS_META_PATH, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`  ✔ registered  → formats/meta/reels.json`);
};

const main = () => {
  const draftIdArg = process.argv.indexOf("--draft");
  const draftId = draftIdArg !== -1 ? process.argv[draftIdArg + 1] : undefined;
  if (!draftId) {
    throw new Error("usage: npm run author:save -- --draft <draftId>");
  }

  const draftPath = path.join(authoringDir(draftId), "draft.json");
  if (!fs.existsSync(draftPath)) {
    throw new Error(
      `no draft.json found at ${draftPath} — run \`npm run author -- --draft ${draftId} --only synthesize\` ` +
        `(or write one by hand, then \`--only validate\`) first`,
    );
  }

  const raw = JSON.parse(fs.readFileSync(draftPath, "utf8"));
  const parsed = DraftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`draft.json failed validation:\n${z.prettifyError(parsed.error)}`);
  }

  const { formatId } = saveFormat(parsed.data.format);
  console.log(`  ✔ saved       → formats/${formatId}.json`);
  registerReel(formatId, parsed.data.sourceUrl);
};

try {
  main();
} catch (err) {
  console.error(`\n✖ ${(err as Error).message}`);
  process.exit(1);
}
