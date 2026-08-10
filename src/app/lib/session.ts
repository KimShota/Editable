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
  await sql`delete from sessions where token_hash = ${sha256Hex(token)}`;
};

export const getSessionUser = async (token: string | undefined): Promise<SessionUser | null> => {
  if (!token) return null;
  const rows = await sql`
    select u.id, u.email, u.is_admin
    from sessions s
    join users u on u.id = s.user_id
    where s.token_hash = ${sha256Hex(token)} and s.expires_at > now()
  `;
  const row = rows[0] as { id: string; email: string; is_admin: boolean } | undefined;
  return row ? { id: row.id, email: row.email, isAdmin: row.is_admin } : null;
};
