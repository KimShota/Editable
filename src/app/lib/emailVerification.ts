import "server-only";
import { randomBytes, createHash } from "node:crypto";
import { sql } from "./db";
import { sendVerificationEmail } from "./email";

/**
 * Confirms a signup's email actually belongs to whoever's typing it — see
 * quota.ts's free-trial gate, which this exists to protect: without it,
 * anyone can mint unlimited free-trial accounts with made-up addresses.
 * Same token shape as session.ts's sessions table (a random token, only its
 * SHA-256 stored) — a dump of email_verifications can't be replayed to
 * verify an account that isn't the attacker's own.
 */

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Mints a fresh verification token for `userId` and emails it to `email`.
 * Replaces any outstanding token first — a user who lost the first email
 * and hits "resend" should end up with exactly one live link, not two.
 */
export const issueVerificationEmail = async (userId: string, email: string, origin: string): Promise<void> => {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await sql`delete from email_verifications where user_id = ${userId}`;
  await sql`
    insert into email_verifications (token_hash, user_id, expires_at)
    values (${sha256Hex(token)}, ${userId}, ${expiresAt.toISOString()})
  `;
  await sendVerificationEmail(email, `${origin}/api/auth/verify?token=${token}`);
};

export type VerifyResult = { ok: true } | { ok: false; error: string };

/** Consumes a verification token — one-shot: the row is deleted whether or
 *  not it turns out to still be valid, so a leaked or already-used link
 *  can never be replayed. */
export const consumeVerificationToken = async (token: string): Promise<VerifyResult> => {
  const rows = await sql`
    delete from email_verifications where token_hash = ${sha256Hex(token)}
    returning user_id, expires_at
  `;
  const row = rows[0] as { user_id: string; expires_at: string } | undefined;
  if (!row) {
    return { ok: false, error: "this verification link is invalid or has already been used" };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "this verification link has expired — request a new one from your account page" };
  }
  await sql`update users set email_verified_at = now() where id = ${row.user_id}`;
  return { ok: true };
};
