/**
 * The SQL-file handling shared by the migration runner (migrate.ts) and
 * the DB tests, so the tests apply migrations through exactly the same
 * splitter production does — a statement that splits wrongly fails in the
 * test, not first on the live database.
 */

// Strips "-- ..." line comments before splitting on ";" — a naive split on
// the raw file breaks when a comment itself contains a semicolon (as
// 001_waitlist.sql's does, mid-sentence). Safe for these migrations: none
// have "--" inside a string literal.
export const stripLineComments = (content: string): string =>
  content
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** One statement per element — the neon driver's `.query()` takes a single
 *  statement. Fine for plain DDL with no semicolons inside string literals
 *  or function bodies, which every migration here is. */
export const splitStatements = (content: string): string[] =>
  stripLineComments(content)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
