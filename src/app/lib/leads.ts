import { sql } from "./db";

/**
 * Landing-page lead capture (plan/landing-page-founder-proof.md section 3).
 * Step one stores the pasted website, step two attaches the email.
 */

/** A website typed into a text box → a clean https URL, or null if it is not a real domain. */
export const normalizeWebsite = (raw: string): { url: string; host: string } | null => {
  const text = raw.trim();
  if (!text || text.length > 300 || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  // A real public domain: dotted labels, a letters-only TLD (so no bare IPs, no "localhost").
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) return null;
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return { url: `https://${host}${path}`, host: host.replace(/^www\./, "") };
};

export const normalizeEmail = (raw: string): string | null => {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
};

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

/** Keeps only known UTM keys, with short string values. */
export const cleanUtm = (raw: unknown): Record<string, string> | null => {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" && value) out[key] = value.slice(0, 100);
  }
  return Object.keys(out).length ? out : null;
};

export type Lead = { id: string; website: string; email: string | null; referrer: string | null; utm: Record<string, string> | null };

export const createLead = async (website: string, referrer: string | null, utm: Record<string, string> | null): Promise<string> => {
  const rows = await sql`
    insert into leads (website, referrer, utm) values (${website}, ${referrer}, ${utm ? JSON.stringify(utm) : null}::jsonb)
    returning id`;
  return (rows[0] as { id: string }).id;
};

/** Attaches the email to a lead that has none yet. Returns the lead, or null if the id is unknown or already completed. */
export const completeLead = async (id: string, email: string): Promise<Lead | null> => {
  const rows = await sql`
    update leads set email = ${email}, completed_at = now()
    where id = ${id}::uuid and email is null
    returning id, website, email, referrer, utm`;
  return (rows[0] as Lead | undefined) ?? null;
};

/** Per-IP limit: this endpoint is public and sends mail to the founder. In-process, like the other caches here. */
const hits = new Map<string, number[]>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_HITS = 20;

export const rateLimited = (ip: string): boolean => {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [key, times] of hits) if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(key);
  return recent.length > MAX_HITS;
};
