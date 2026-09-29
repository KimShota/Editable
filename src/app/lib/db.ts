import { neon, NeonQueryFunction } from "@neondatabase/serverless";

/**
 * The one Neon client, shared by auth.ts and other server modules.
 *
 * Lazy on purpose: constructing the client eagerly would throw at module
 * import when DATABASE_URL is unset, which would 500 every route that
 * imports this file.
 *
 * No `server-only` guard: this is also reached from standalone CLI tools
 * (mintInvites.ts), and `server-only` throws unconditionally outside Next's
 * bundler. Safe either way — nothing here is imported by a client component.
 */

let sqlClient: NeonQueryFunction<false, false> | undefined;

// Only ever called in tagged-template form (never .query/.unsafe/
// .transaction), so the cast is safe despite the wrapper not implementing
// NeonQueryFunction's full interface.
export const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  if (!sqlClient) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set — see .env for the Postgres (Neon) setup.");
    }
    sqlClient = neon(process.env.DATABASE_URL);
  }
  return sqlClient(strings, ...values);
}) as NeonQueryFunction<false, false>;

/** A parameterized query — `$1, $2` placeholders plus a params array —
 *  returning rows. Used where the tagged template can't express the call
 *  (an array parameter, SQL assembled from a fixed fragment) and, more
 *  importantly, as the ONE seam the queue/analysis stores take as an
 *  argument: production passes this, the tests pass an in-process Postgres
 *  (PGlite) with the same signature. Never interpolate user input into
 *  `text`; put it in `params`. */
export type QueryFn = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export const query: QueryFn = async (text, params = []) => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — see .env for the Postgres (Neon) setup.");
  }
  sqlClient ??= neon(process.env.DATABASE_URL);
  return (await sqlClient.query(text, params)) as Record<string, unknown>[];
};

/** Escape hatch for the migration runner, which builds SQL text it can't
 *  express as a tagged template. Never use this with user input. */
export const rawQuery = async (text: string): Promise<void> => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — see .env for the Postgres (Neon) setup.");
  }
  sqlClient ??= neon(process.env.DATABASE_URL);
  await sqlClient.query(text);
};
