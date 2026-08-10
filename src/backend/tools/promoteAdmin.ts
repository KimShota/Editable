import "dotenv/config";
import { sql } from "../../app/lib/db";

/**
 * Grants admin (access to /reverse-engineer + /authoring, see middleware.ts)
 * to an already-signed-up account: `npm run admin:promote -- you@email.com`.
 * No UI for this — with a handful of friends, a one-line CLI is the honest
 * scope, same call as waitlistExport.ts makes for the waitlist.
 */

const email = process.argv[2];

async function main() {
  if (!email) {
    console.error("usage: npm run admin:promote -- <email>");
    process.exit(1);
  }
  const rows = await sql`
    update users set is_admin = true
    where email_norm = ${email.trim().toLowerCase()}
    returning email
  `;
  if (rows.length === 0) {
    console.error(`no account found for ${email} — they need to sign up first`);
    process.exit(1);
  }
  console.log(`${(rows[0] as { email: string }).email} is now an admin`);
}

main().catch((err) => {
  console.error("promote failed:", err);
  process.exit(1);
});
