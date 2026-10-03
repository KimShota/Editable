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

/**
 * Test seam. Neon's driver only speaks HTTP to Neon, so a browser test (or a
 * manual run) cannot point it at a local Postgres. When KATALAB_TEST_DB_URL
 * names a test database server (src/backend/tools/testDbServer.ts, PGlite
 * behind a tiny JSON endpoint), every query goes there instead. That server
 * is shared by the app and the worker, which is why it is a server and not
 * an in-process database.
 *
 * It must never be set in production: that is refused outright rather than
 * trusted to be unset.
 */
const testDbUrl = (): string | undefined => {
  const url = process.env.KATALAB_TEST_DB_URL;
  if (url && process.env.NODE_ENV === "production") {
    throw new Error("KATALAB_TEST_DB_URL must not be set in production");
  }
  return url || undefined;
};

const testDbRequest = async (url: string, route: "query" | "exec", body: unknown): Promise<Record<string, unknown>[]> => {
  const res = await fetch(`${url}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json()) as { rows?: Record<string, unknown>[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? `test db: HTTP ${res.status}`);
  return data.rows ?? [];
};

/** "a ${x} b ${y}" as "a $1 b $2" plus [x, y]. */
const templateToQuery = (strings: TemplateStringsArray, values: unknown[]): { text: string; params: unknown[] } => ({
  text: strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""), ""),
  params: values,
});

// Only ever called in tagged-template form (never .query/.unsafe/
// .transaction), so the cast is safe despite the wrapper not implementing
// NeonQueryFunction's full interface.
export const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  const testUrl = testDbUrl();
  if (testUrl) return testDbRequest(testUrl, "query", templateToQuery(strings, values));
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
  const testUrl = testDbUrl();
  if (testUrl) return testDbRequest(testUrl, "query", { text, params });
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — see .env for the Postgres (Neon) setup.");
  }
  sqlClient ??= neon(process.env.DATABASE_URL);
  return (await sqlClient.query(text, params)) as Record<string, unknown>[];
};

/** Escape hatch for the migration runner, which builds SQL text it can't
 *  express as a tagged template. Never use this with user input. */
export const rawQuery = async (text: string): Promise<void> => {
  const testUrl = testDbUrl();
  if (testUrl) {
    await testDbRequest(testUrl, "exec", { text });
    return;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — see .env for the Postgres (Neon) setup.");
  }
  sqlClient ??= neon(process.env.DATABASE_URL);
  await sqlClient.query(text);
};
