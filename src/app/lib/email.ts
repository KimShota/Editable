import "server-only";
import fs from "node:fs";
import path from "node:path";
import { Resend } from "resend";
import { storageRoot } from "@backend/storage";

/**
 * Lazy on purpose, same reasoning as stripe.ts/db.ts — constructing this
 * eagerly would throw at module import when RESEND_API_KEY is unset,
 * 500-ing every route that imports this file even if the request never
 * sends an email.
 */
let client: Resend | undefined;

const resend = (): Resend => {
  if (!client) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not set — see .env for Resend setup.");
    }
    client = new Resend(process.env.RESEND_API_KEY);
  }
  return client;
};

/** Defaults to Resend's own shared onboarding domain, which only delivers
 *  to the Resend account's own verified address — fine for development,
 *  not for real signups. Set RESEND_FROM_EMAIL once a sending domain is
 *  verified in the Resend dashboard (Domains). */
const fromAddress = (): string => process.env.RESEND_FROM_EMAIL ?? "Katalab <onboarding@resend.dev>";

type Message = { to: string; subject: string; html: string };

/** Sends through Resend, or in the test environment (KATALAB_STUB_PROVIDERS=1)
 *  appends the message to storage/outbox.jsonl instead, so a test can read
 *  what would have been sent and no real email ever leaves. */
const deliver = async (message: Message): Promise<void> => {
  if (process.env.KATALAB_STUB_PROVIDERS === "1") {
    fs.mkdirSync(storageRoot(), { recursive: true });
    fs.appendFileSync(path.join(storageRoot(), "outbox.jsonl"), `${JSON.stringify({ ...message, at: new Date().toISOString() })}\n`);
    return;
  }
  const { error } = await resend().emails.send({ from: fromAddress(), ...message });
  if (error) throw new Error(`Resend rejected the email to ${message.to}: ${error.message}`);
};

export const sendVerificationEmail = async (to: string, verifyUrl: string): Promise<void> => {
  await deliver({
    to,
    subject: "Confirm your Katalab account",
    html: `
      <p>Click below to confirm your email address:</p>
      <p><a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a></p>
      <p>This link expires in 24 hours. If you didn't sign up for Katalab, you can ignore this email.</p>
    `,
  });
};

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One email per batch, not per video: the founder just released N videos to review. */
export const sendVideosReadyEmail = async (to: string, brandName: string, count: number, link: string): Promise<void> => {
  const noun = count === 1 ? "video is" : "videos are";
  await deliver({
    to,
    subject: `${count} ${count === 1 ? "video" : "videos"} for ${brandName} ${count === 1 ? "is" : "are"} ready to review`,
    html: `
      <p>${count} ${noun} ready for you to review.</p>
      <p>Open the calendar, watch each one, and approve it or tell us what is off.</p>
      <p><a href="${escapeHtml(link)}">Review your videos</a></p>
    `,
  });
};

/** An invitation to join a brand's workspace. Signup is open, so the link is
 *  the signup page: when the invited address is verified they are in. */
export const sendInviteEmail = async (to: string, brandName: string, link: string): Promise<void> => {
  await deliver({
    to,
    subject: `You are invited to ${brandName} on Katalab`,
    html: `
      <p>You have been invited to review and approve the videos for ${escapeHtml(brandName)}.</p>
      <p>Create your account with this email address, confirm it, and the brand will be there when you sign in.</p>
      <p><a href="${escapeHtml(link)}">Create your account</a></p>
    `,
  });
};

/** The first 14 days are planned and waiting for the customer to read and approve. */
export const sendPlanReadyEmail = async (to: string, brandName: string, link: string): Promise<void> => {
  await deliver({
    to,
    subject: `Your plan for ${brandName} is ready to review`,
    html: `
      <p>Your first 14 days of videos for ${escapeHtml(brandName)} are planned.</p>
      <p>Read each script, change what you like, and approve the ones you want made. Nothing is created until you do.</p>
      <p><a href="${escapeHtml(link)}">Review your plan</a></p>
    `,
  });
};

/** Tells the founder a landing-page visitor left their website and email. */
export const sendLeadNotificationEmail = async (
  to: string,
  lead: { website: string; email: string; referrer: string | null; utm: Record<string, string> | null },
): Promise<void> => {
  const utm = lead.utm ? Object.entries(lead.utm).map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`).join(", ") : "none";
  await deliver({
    to,
    subject: `New Katalab lead: ${lead.website}`,
    html: `
      <p><strong>${escapeHtml(lead.email)}</strong> wants a character for <a href="${escapeHtml(lead.website)}">${escapeHtml(lead.website)}</a>.</p>
      <p>Referrer: ${escapeHtml(lead.referrer ?? "direct")}<br>UTM: ${utm}</p>
      <p>They were told you would send their character and first 14-day plan within 3 days.</p>
    `,
  });
};
