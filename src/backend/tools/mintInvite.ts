import "dotenv/config";
import { randomBytes } from "node:crypto";
import { sql } from "../../app/lib/db";

/**
 * Prints one invite code. Signup is invite-gated (see app/lib/auth.ts's
 * signup()) so this is the only way in.
 *
 * By default mints a single-use code for a specific friend: `npm run
 * invites:mint -- --note "alice"`. Pass `--reusable` for a code that never
 * gets consumed — meant to be shared with a whole group at once (e.g. a
 * batch of testers) instead of minting one per person — and `--code` to
 * pick the string yourself rather than getting a random one, since a
 * shared code is typed/copy-pasted around and worth being memorable.
 */

const noteArgIdx = process.argv.indexOf("--note");
const note = noteArgIdx !== -1 ? process.argv[noteArgIdx + 1] : undefined;
const reusable = process.argv.includes("--reusable");
const codeArgIdx = process.argv.indexOf("--code");
const explicitCode = codeArgIdx !== -1 ? process.argv[codeArgIdx + 1] : undefined;

async function main() {
  const code = explicitCode ?? randomBytes(6).toString("base64url");
  await sql`insert into invites (code, note, reusable) values (${code}, ${note ?? null}, ${reusable})`;
  console.log(code);
}

main().catch((err) => {
  console.error("mint failed:", err);
  process.exit(1);
});
