import "server-only";
import { Resend } from "resend";

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
