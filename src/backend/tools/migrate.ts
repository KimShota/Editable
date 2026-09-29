import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { sql, rawQuery } from "../../app/lib/db";
import { repoRoot } from "../pipeline/paths";
import { splitStatements } from "./sqlMigrations";

/**
 * Minimal migration runner for db/migrations/*.sql — applies each file
 * once, tracked in schema_migrations. No down-migrations, no framework:
 * this project has two tiny, append-only migration files, not a churn-heavy
 * schema, so a full migration tool would be more machinery than the
 * problem needs.
 *
 * Splits each file on ";" and runs statements one at a time, since the
 * neon serverless driver's `.query()` takes a single statement — fine
 * here because these migrations are plain CREATE TABLE/INDEX with no
 * semicolons inside string literals or function bodies.
 */

const migrationsDir = path.join(repoRoot, "db/migrations");

const ensureMigrationsTable = async (): Promise<void> => {
  await rawQuery(`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);
};

const alreadyApplied = async (): Promise<Set<string>> => {
  const rows = await sql`select filename from schema_migrations`;
  return new Set((rows as { filename: string }[]).map((r) => r.filename));
};

const runFile = async (filePath: string): Promise<void> => {
  for (const statement of splitStatements(fs.readFileSync(filePath, "utf8"))) {
    await rawQuery(statement);
  }
};

const main = async () => {
  if (!fs.existsSync(migrationsDir)) {
    console.log("no db/migrations directory found — nothing to do");
    return;
  }
  await ensureMigrationsTable();
  const applied = await alreadyApplied();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  ✓ ${file} (already applied)`);
      continue;
    }
    console.log(`  → applying ${file}...`);
    await runFile(path.join(migrationsDir, file));
    await sql`insert into schema_migrations (filename) values (${file})`;
    console.log(`  ✔ ${file}`);
  }
  console.log("migrations up to date");
};

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
