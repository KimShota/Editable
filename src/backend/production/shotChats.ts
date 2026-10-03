import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { repoRoot } from "../pipeline/paths";

/**
 * The conversation behind each AI shot's changes: the user says what they
 * want ("her hand should tap the trackpad, not type"), Claude answers with a
 * plan (shotChange.ts), and a plan the user accepts becomes a new take
 * (`npm run produce -- regen-clip --plan <id>`). Kept beside takes.json as
 * jobs/<jobId>/shot-chats.json, keyed by shot, so a shot's history survives
 * reloads and every take can say which request made it.
 */

/**
 * What Claude decides for one request. Plain types only: this schema is also
 * the structured-output format sent to Claude (see recreation/schemas.ts).
 */
export const ChangePlanSchema = z.object({
  /** What to tell the user, in their language: the plan, a question, or why not. */
  reply: z.string(),
  /** "regenerate": a paid new take with the fields below. "none": nothing to
   *  generate (a question back, an edit the editor already does for free, or
   *  a change this shot cannot make). */
  action: z.enum(["regenerate", "none"]),
  /** The complete new prompt for the video model, or null to keep the current one. */
  motion: z.string().nullable(),
  /** An edit to the still the clip starts from (outfit, framing, props…), or null to keep it. */
  stillEdit: z.string().nullable(),
  /** A few words naming the change, shown on the take ("tap, not type"). */
  label: z.string(),
});
export type ChangePlan = z.infer<typeof ChangePlanSchema>;

export type ShotMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  /** Assistant messages: the plan, with its price when it regenerates. */
  plan?: ChangePlan & { estimateUsd?: number };
  /** Set once the plan was generated: the take it made. */
  takeId?: string;
};

type ShotChatsFile = Record<string, ShotMessage[]>;

const chatsPath = (jobId: string) => path.join(repoRoot, "jobs", jobId, "shot-chats.json");

const readAll = (jobId: string): ShotChatsFile => (fs.existsSync(chatsPath(jobId)) ? (JSON.parse(fs.readFileSync(chatsPath(jobId), "utf8")) as ShotChatsFile) : {});
const writeAll = (jobId: string, all: ShotChatsFile) => fs.writeFileSync(chatsPath(jobId), JSON.stringify(all, null, 2));

export const readShotChat = (jobId: string, shotId: string): ShotMessage[] => readAll(jobId)[shotId] ?? [];

export const newMessage = (m: Omit<ShotMessage, "id" | "at">): ShotMessage => ({ id: randomUUID().slice(0, 8), at: new Date().toISOString(), ...m });

export const appendShotMessages = (jobId: string, shotId: string, messages: ShotMessage[]): void => {
  const all = readAll(jobId);
  all[shotId] = [...(all[shotId] ?? []), ...messages];
  writeAll(jobId, all);
};

export const updateShotMessage = (jobId: string, shotId: string, id: string, patch: Partial<ShotMessage>): void => {
  const all = readAll(jobId);
  all[shotId] = (all[shotId] ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m));
  writeAll(jobId, all);
};

/** The plan a "Generate" refers to: an assistant message of this shot that regenerates. */
export const findPlan = (jobId: string, shotId: string, id: string): { message: ShotMessage; request: string } => {
  const chat = readShotChat(jobId, shotId);
  const i = chat.findIndex((m) => m.id === id);
  const message = chat[i];
  if (!message || message.role !== "assistant" || message.plan?.action !== "regenerate") throw new Error(`no change plan ${id} for shot ${shotId}`);
  // The request it answers: the user message right before it.
  const request = [...chat.slice(0, i)].reverse().find((m) => m.role === "user")?.text ?? "";
  return { message, request };
};
