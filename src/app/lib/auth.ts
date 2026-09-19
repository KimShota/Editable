import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { sql } from "./db";
import {
  createSessionToken,
  destroySessionToken,
  getSessionUser,
  type SessionUser,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "./session";

/**
 * Accounts + password auth for the friends-alpha deploy. Job DATA still
 * lives on disk exactly as before (see jobs.ts) — this is only the
 * identity layer that makes it safe to expose that filesystem store to
 * more than one person: who's allowed in (open signup) and which jobs are
 * theirs (job_owners, see jobs.ts). Session token verification itself
 * lives in session.ts (also used by middleware.ts, which can't import
 * this file — see that module's docstring for why).
 *
 * Signup is open registration: anyone with an email can create an account.
 * Invite codes (see db/migrations/006_reusable_invites.sql) are no longer
 * required, though the invites table/tooling is left in place.
 */

export { SESSION_COOKIE, SESSION_TTL_MS, getSessionUser };
export type { SessionUser };

/**
 * Reads the identity middleware.ts already verified and attached as
 * request headers (x-user-id/x-user-email/x-user-is-admin) — no DB round
 * trip. Safe to trust: middleware always overwrites these headers itself
 * on every non-public request rather than merging a client-supplied value,
 * so a request that reached a route handler/page can't have spoofed them.
 * Returns null only on a route middleware left unauthenticated (a public
 * route calling this by mistake) — every non-public route already has
 * middleware's 401/redirect in front of it, so null shouldn't otherwise
 * occur there.
 */
export const getRequestUser = async (): Promise<SessionUser | null> => {
  const h = await headers();
  const id = h.get("x-user-id");
  const email = h.get("x-user-email");
  if (!id || !email) return null;
  // plan/created_at/email_verified_at aren't in middleware's trusted
  // headers (see middleware.ts's docstring on why) — one extra indexed PK
  // lookup, not worth threading new headers through every request for.
  const rows = await sql`select plan, created_at, email_verified_at from users where id = ${id}`;
  const row = rows[0] as
    | { plan: "free" | "premium"; created_at: string; email_verified_at: string | null }
    | undefined;
  return {
    id,
    email,
    isAdmin: h.get("x-user-is-admin") === "1",
    plan: row?.plan ?? "free",
    createdAt: row?.created_at ?? new Date(0).toISOString(),
    emailVerifiedAt: row?.email_verified_at ?? null,
  };
};
export const createSession = createSessionToken;
export const destroySession = destroySessionToken;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

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

export type SignupResult =
  | { ok: true; user: SessionUser }
  | { ok: false; error: string };

/**
 * Creates an account for anyone with a not-yet-registered email. Open
 * registration — no invite code required.
 */
export const signup = async (email: string, password: string): Promise<SignupResult> => {
  const emailNorm = normalizeEmail(email);
  const passwordHash = hashPassword(password);
  let created: { id: string; email: string; is_admin: boolean; plan: "free" | "premium"; created_at: string };
  try {
    const rows = await sql`
      insert into users (email, email_norm, password_hash)
      values (${email.trim()}, ${emailNorm}, ${passwordHash})
      returning id, email, is_admin, plan, created_at
    `;
    created = rows[0] as typeof created;
  } catch {
    // unique violation on email_norm
    return { ok: false, error: "an account with that email already exists" };
  }

  return {
    ok: true,
    user: {
      id: created.id,
      email: created.email,
      isAdmin: created.is_admin,
      plan: created.plan,
      createdAt: created.created_at,
      // Newly inserted row — email_verified_at is null by default, no need
      // to round-trip it back from the insert.
      emailVerifiedAt: null,
    },
  };
};

export const verifyLogin = async (email: string, password: string): Promise<SessionUser | null> => {
  const rows = await sql`
    select id, email, password_hash, is_admin, plan, created_at, email_verified_at
    from users where email_norm = ${normalizeEmail(email)}
  `;
  const row = rows[0] as
    | {
        id: string;
        email: string;
        password_hash: string;
        is_admin: boolean;
        plan: "free" | "premium";
        created_at: string;
        email_verified_at: string | null;
      }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  await sql`update users set last_login_at = now() where id = ${row.id}`;
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.is_admin,
    plan: row.plan,
    createdAt: row.created_at,
    emailVerifiedAt: row.email_verified_at,
  };
};
