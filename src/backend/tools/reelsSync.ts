import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot } from "../pipeline/paths";

/**
 * Refreshes formats/meta/reels.json's like/comment counts from the live reel —
 * `npm run reels:sync`. Instagram's public reel pages never expose
 * view_count/share_count (yt-dlp reports both as null for every reel this
 * repo has checked, across multiple accounts), so this only ever touches
 * `likes`/`comments`; any other field an entry carries (or a future field
 * this script doesn't know about) passes through untouched.
 */

const reelsPath = path.join(repoRoot, "formats", "meta", "reels.json");

type ReelEntry = {
  url: string;
  uploader: string;
  likes: number;
  comments: number;
  fetchedAt: string;
  [key: string]: unknown;
};

const fetchCounts = (url: string): { likes: number | null; comments: number | null } => {
  const raw = execFileSync("yt-dlp", ["--socket-timeout", "30", "--simulate", "--dump-json", "--no-warnings", url], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  const json = JSON.parse(raw);
  return { likes: json.like_count ?? null, comments: json.comment_count ?? null };
};

async function main() {
  const reels: Record<string, ReelEntry> = JSON.parse(fs.readFileSync(reelsPath, "utf8"));
  const now = new Date().toISOString();

  for (const [formatId, entry] of Object.entries(reels)) {
    process.stderr.write(`${formatId}: fetching...`);
    try {
      const { likes, comments } = fetchCounts(entry.url);
      if (likes === null && comments === null) {
        process.stderr.write(` no data returned, keeping existing counts\n`);
        continue;
      }
      if (likes !== null) entry.likes = likes;
      if (comments !== null) entry.comments = comments;
      entry.fetchedAt = now;
      process.stderr.write(` likes=${entry.likes} comments=${entry.comments}\n`);
    } catch (err) {
      process.stderr.write(` FAILED (${(err as Error).message}) — keeping existing counts\n`);
    }
  }

  fs.writeFileSync(reelsPath, JSON.stringify(reels, null, 2) + "\n");
  process.stderr.write(`\nwrote ${reelsPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
