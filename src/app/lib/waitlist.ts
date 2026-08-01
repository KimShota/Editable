import { createHash } from "node:crypto";
import { neon, NeonQueryFunction } from "@neondatabase/serverless";
import { z } from "zod";

/**
 * Waitlist signups live in Postgres (Neon), not the filesystem — unlike
 * jobs/formats/artifacts, this is public-facing data that needs to survive
 * a serverless deploy with no persistent disk, and dedupe correctly under
 * concurrent submits (the DB's unique index does that; a check-then-write
 * against a file can't).
 *
 * No `server-only` guard: unlike jobs.ts (only ever imported by API
 * routes), this module is also imported by the standalone
 * waitlistExport.ts CLI tool, and `server-only` throws unconditionally
 * outside Next's bundler. Safe either way — nothing here is imported by a
 * client component.
 */

// Lazy: constructing the client eagerly would throw at module import if
// DATABASE_URL is unset, which would 500 every route that imports this
// file — including code paths (like the honeypot check) that never touch
// the DB at all.
let sqlClient: NeonQueryFunction<false, false> | undefined;
// Only ever called in tagged-template form below (never .query/.unsafe/
// .transaction), so the cast is safe despite the wrapper not implementing
// NeonQueryFunction's full interface.
const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  if (!sqlClient) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set — see .env for the waitlist storage setup.");
    }
    sqlClient = neon(process.env.DATABASE_URL);
  }
  return sqlClient(strings, ...values);
}) as NeonQueryFunction<false, false>;

// Capped well above any real email/UTM value so a hostile client can't
// stuff megabytes into a text column.
const UTM_MAX = 200;

export const WaitlistSignupSchema = z.object({
  email: z.email().max(254),
  referrer: z.string().max(UTM_MAX).optional(),
  utmSource: z.string().max(UTM_MAX).optional(),
  utmMedium: z.string().max(UTM_MAX).optional(),
  utmCampaign: z.string().max(UTM_MAX).optional(),
});

export type WaitlistSignup = z.infer<typeof WaitlistSignupSchema>;

export type AddResult = { status: "added" | "duplicate" };

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** IP is never stored raw — only a salted hash, and only to throttle abuse. */
export const hashIp = (ip: string): string =>
  createHash("sha256").update(`${ip}:${process.env.WAITLIST_IP_SALT ?? ""}`).digest("hex");

export const addToWaitlist = async (
  signup: WaitlistSignup,
  meta: { userAgent?: string; ipHash?: string },
): Promise<AddResult> => {
  const emailNorm = normalizeEmail(signup.email);
  const rows = await sql`
    insert into waitlist (email, email_norm, referrer, utm_source, utm_medium, utm_campaign, user_agent, ip_hash)
    values (
      ${signup.email.trim()}, ${emailNorm}, ${signup.referrer ?? null},
      ${signup.utmSource ?? null}, ${signup.utmMedium ?? null}, ${signup.utmCampaign ?? null},
      ${meta.userAgent ?? null}, ${meta.ipHash ?? null}
    )
    on conflict (email_norm) do nothing
    returning id
  `;
  return { status: rows.length > 0 ? "added" : "duplicate" };
};

/** Signups from this IP hash in the last hour — used to throttle abuse. */
export const recentSignupCountFromIp = async (ipHash: string): Promise<number> => {
  const rows = await sql`
    select count(*)::int as count from waitlist
    where ip_hash = ${ipHash} and created_at > now() - interval '1 hour'
  `;
  return rows[0]?.count ?? 0;
};

export type WaitlistRow = {
  id: number;
  email: string;
  status: string;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  created_at: string;
};

export const listWaitlist = async (): Promise<WaitlistRow[]> => {
  const rows = await sql`
    select id, email, status, referrer, utm_source, utm_medium, utm_campaign, created_at
    from waitlist
    order by created_at asc
  `;
  return rows as WaitlistRow[];
};
