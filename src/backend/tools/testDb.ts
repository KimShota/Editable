import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { QueryFn } from "../../app/lib/db";
import { repoRoot } from "../pipeline/paths";
import { splitStatements } from "./sqlMigrations";

/**
 * An in-process Postgres (PGlite) with every migration applied through the
 * same splitter migrate.ts uses — shared by the DB-backed check scripts.
 *
 * pgvector is shimmed: PGlite ships without it, so `create extension vector`
 * and hnsw indexes are skipped and `vector(N)` columns become a text-backed
 * domain. Similarity search is therefore never exercised here.
 */

export const shimVectorStatements = (statements: string[]): string[] =>
  statements
    .filter((s) => !/^create extension\b.*\bvector\b/i.test(s) && !/\busing hnsw\b/i.test(s))
    .map((s) => s.replace(/vector\(\d+\)/g, "vector"));

/** Applies db/migrations/*.sql in order (optionally only files matching
 *  `only`) and returns how many statements ran. */
export const applyMigrations = async (db: PGlite, only?: (file: string) => boolean): Promise<number> => {
  const dir = path.join(repoRoot, "db/migrations");
  let statements = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && (!only || only(f))).sort()) {
    for (const stmt of shimVectorStatements(splitStatements(fs.readFileSync(path.join(dir, file), "utf8")))) {
      try {
        await db.exec(stmt);
        statements++;
      } catch (err) {
        throw new Error(`migration ${file} failed on:\n${stmt}\n→ ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return statements;
};

export const pgliteQuery =
  (db: PGlite): QueryFn =>
  async (text, params = []) =>
    (await db.query(text, params)).rows as Record<string, unknown>[];

/** A fresh database with every migration applied. */
export const makeTestDb = async (): Promise<{ db: PGlite; query: QueryFn; statements: number }> => {
  const db = new PGlite();
  await db.exec("create domain vector as text");
  const statements = await applyMigrations(db);
  return { db, query: pgliteQuery(db), statements };
};
