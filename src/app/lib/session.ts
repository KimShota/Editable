import { createHash, randomBytes } from "node:crypto";
import { sql } from "./db";

/**
 * Session token verification, deliberately WITHOUT `server-only`: unlike
 * auth.ts (which guards password hashing/signup — real secrets, never
 * needed outside a Server Component/Route Handler), this module is also
 * imported by src/middleware.ts. Middleware isn't compiled as part of the
 * app router's react-server graph, so `server-only`'s guard (which throws
 * unless the "react-server" export condition is active) can't be trusted
 * to resolve to its no-op branch there — safer to just not depend on it
 * for this file. auth.ts re-exports everything here for its existing
 * callers (Nav.tsx, the login/signup/logout routes).
 */

export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

export type SessionUser = { id: string; email: string; isAdmin: boolean };

/**
 * In-process cache for getSessionUser, keyed by the same token hash the DB
 * row is keyed by (never the raw token — same reasoning as the DB schema:
 * no reason to hold a bare bearer credential in memory any longer than a
 * hash of it would do). middleware.ts runs this on effectively every
 * request (see its matcher), and a Neon round trip measured ~90ms — with
 * this uncached, that's ~90ms of pure latency added to every image, video
 * chunk, and page load in the app, on top of whatever the request was
 * actually doing.
 *
 * Positive entries get a real (short) TTL because a session can be
 * invalidated from elsewhere at any moment — another tab's logout, or
 * natural expiry — and this process has no way to hear about that. 30s
 * caps how stale "logged in" can be, which for a session with a 30-DAY
 * lifetime is a rounding error. Negative entries get a shorter TTL for the
 * opposite reason: caching "not logged in" too long after a login would
 * lock a user out of their own just-authenticated request.
 *
 * Single-process only (see editable.service — Type=simple, no cluster) so
 * there's no cross-instance invalidation to worry about, and destroySession
 * below evicts synchronously on logout, so the common case (a user logs
 * out and immediately expects to be logged out) never waits on the TTL at
 * all.
 */
type SessionCacheEntry = { user: SessionUser | null; expiresAt: number };
const SESSION_CACHE_POSITIVE_TTL_MS = 30_000;
const SESSION_CACHE_NEGATIVE_TTL_MS = 5_000;
const sessionCache = new Map<string, SessionCacheEntry>();

/** Returns the raw cookie token — callers set it on the response cookie
 *  (SESSION_COOKIE), never store or log it themselves. */
export const createSessionToken = async (userId: string, userAgent?: string): Promise<string> => {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await sql`
    insert into sessions (token_hash, user_id, expires_at, user_agent)
    values (${sha256Hex(token)}, ${userId}, ${expiresAt.toISOString()}, ${userAgent ?? null})
  `;
  return token;
};

export const destroySessionToken = async (token: string): Promise<void> => {
  const tokenHash = sha256Hex(token);
  sessionCache.delete(tokenHash);
  await sql`delete from sessions where token_hash = ${tokenHash}`;
};

export const getSessionUser = async (token: string | undefined): Promise<SessionUser | null> => {
  if (!token) return null;
  const tokenHash = sha256Hex(token);

  const cached = sessionCache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const rows = await sql`
    select u.id, u.email, u.is_admin
    from sessions s
    join users u on u.id = s.user_id
    where s.token_hash = ${tokenHash} and s.expires_at > now()
  `;
  const row = rows[0] as { id: string; email: string; is_admin: boolean } | undefined;
  const user = row ? { id: row.id, email: row.email, isAdmin: row.is_admin } : null;

  sessionCache.set(tokenHash, {
    user,
    expiresAt: Date.now() + (user ? SESSION_CACHE_POSITIVE_TTL_MS : SESSION_CACHE_NEGATIVE_TTL_MS),
  });
  return user;
};
