import "dotenv/config";
import { listWaitlist } from "../../app/lib/waitlist";

/**
 * Writes the waitlist as CSV to stdout: `npm run waitlist:export > waitlist.csv`.
 * No admin UI — this repo has no auth, so a CLI export is the honest scope.
 */

const csvField = (value: string | null): string => {
  const s = value ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const rows = await listWaitlist();
  const header = ["id", "email", "status", "referrer", "utm_source", "utm_medium", "utm_campaign", "created_at"];
  process.stdout.write(header.join(",") + "\n");
  for (const row of rows) {
    process.stdout.write(
      [row.id, row.email, row.status, row.referrer, row.utm_source, row.utm_medium, row.utm_campaign, row.created_at]
        .map((v) => csvField(v === null || v === undefined ? null : String(v)))
        .join(",") + "\n",
    );
  }
  process.stderr.write(`${rows.length} signups exported\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
