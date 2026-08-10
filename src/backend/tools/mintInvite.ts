import "dotenv/config";
import { randomBytes } from "node:crypto";
import { sql } from "../../app/lib/db";

/**
 * Prints one invite code, minted for a specific friend: `npm run
 * invites:mint -- --note "alice"`. Signup is invite-gated (see
 * app/lib/auth.ts's signup()) so this is the only way in.
 */

const noteArgIdx = process.argv.indexOf("--note");
const note = noteArgIdx !== -1 ? process.argv[noteArgIdx + 1] : undefined;

async function main() {
  const code = randomBytes(6).toString("base64url");
  await sql`insert into invites (code, note) values (${code}, ${note ?? null})`;
  console.log(code);
}

main().catch((err) => {
  console.error("mint failed:", err);
  process.exit(1);
});
