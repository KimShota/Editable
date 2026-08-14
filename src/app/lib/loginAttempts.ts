import { sql } from "./db";
import { hashIp } from "./waitlist";

/**
 * Throttle for /api/auth/login — without this, an attacker with a valid
 * email could guess passwords with no limit, and each guess costs a real
 * scrypt hash (see auth.ts's verifyPassword), which is itself a cheap way
 * to load a 4-vCPU box shared with pipeline renders. Two independent
 * counters, both checked: per-email (catches guessing one account from
 * many IPs) and per-IP (catches guessing many accounts from one source).
 *
 * Reuses waitlist.ts's hashIp/WAITLIST_IP_SALT rather than introducing a
 * second salt env var for the same kind of value — the salt's purpose
 * ("hash IPs stored against abuse") isn't specific to the waitlist table.
 *
 * No `server-only` guard, matching session.ts/waitlist.ts: nothing here is
 * imported by a client component, and `server-only` throws unconditionally
 * outside Next's bundler.
 */

const WINDOW_MINUTES = 15;
const MAX_ATTEMPTS_PER_EMAIL = 10;
const MAX_ATTEMPTS_PER_IP = 20;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const emailAttemptCount = async (emailNorm: string): Promise<number> => {
  const rows = await sql`
    select count(*)::int as count from login_attempts
    where email_norm = ${emailNorm} and created_at > now() - ${WINDOW_MINUTES} * interval '1 minute'
  `;
  return (rows[0] as { count: number }).count;
};

const ipAttemptCount = async (ipHash: string): Promise<number> => {
  const rows = await sql`
    select count(*)::int as count from login_attempts
    where ip_hash = ${ipHash} and created_at > now() - ${WINDOW_MINUTES} * interval '1 minute'
  `;
  return (rows[0] as { count: number }).count;
};

/** Call BEFORE verifyLogin — checking first is what saves the scrypt cost
 *  once a caller is already over either limit. `ip` is the raw
 *  (unhashed) address; hashing happens in here so callers never need
 *  their own copy of hashIp for this. */
export const isLoginRateLimited = async (email: string, ip: string | null): Promise<boolean> => {
  const emailNorm = normalizeEmail(email);
  const ipHash = ip ? hashIp(ip) : null;
  const [byEmail, byIp] = await Promise.all([
    emailAttemptCount(emailNorm),
    ipHash ? ipAttemptCount(ipHash) : Promise.resolve(0),
  ]);
  return byEmail >= MAX_ATTEMPTS_PER_EMAIL || byIp >= MAX_ATTEMPTS_PER_IP;
};

/** Records one attempt — call for every POST that reaches password
 *  verification (whether it succeeds or fails), after the rate-limit
 *  check above. Old rows just age out of the WINDOW_MINUTES window on
 *  their own; nothing here needs to know about it. */
export const recordLoginAttempt = async (email: string, ip: string | null): Promise<void> => {
  const ipHash = ip ? hashIp(ip) : null;
  await sql`insert into login_attempts (email_norm, ip_hash) values (${normalizeEmail(email)}, ${ipHash})`;
};
