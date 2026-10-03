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

export const sendVerificationEmail = async (to: string, verifyUrl: string): Promise<void> => {
  const { error } = await resend().emails.send({
    from: fromAddress(),
    to,
    subject: "Confirm your Katalab account",
    html: `
      <p>Click below to confirm your email and start your free trial:</p>
      <p><a href="${verifyUrl}">${verifyUrl}</a></p>
      <p>This link expires in 24 hours. If you didn't sign up for Katalab, you can ignore this email.</p>
    `,
  });
  if (error) {
    throw new Error(`Resend rejected the verification email: ${error.message}`);
  }
};

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
