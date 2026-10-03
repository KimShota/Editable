import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing, apart from auth.ts so scripts (test fixtures, admin
 * tools) can create real, loginable users: auth.ts imports `server-only`,
 * which throws outside Next's bundler. auth.ts re-exports both functions.
 */

// scrypt, not bcrypt/argon2: node:crypto ships it natively, so this stays a
// zero-dependency addition. Cost params are scryptSync's Node defaults
// (N=16384, r=8, p=1) — fine for a friends-scale user table.
const SCRYPT_KEYLEN = 64;

export const hashPassword = (password: string): string => {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
};

export const verifyPassword = (password: string, stored: string): boolean => {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  // scryptSync's output length must match `expected`'s to diff safely; a
  // mismatched stored hash (corrupt row) fails the length check before
  // ever reaching timingSafeEqual, rather than throwing.
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
