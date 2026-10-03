import { NextResponse } from "next/server";
import { z } from "zod";
import { recreationKeys } from "@backend/brand/keys";
import { pickAlternates } from "@backend/plan/propose";
import { updatePlan } from "@backend/plan/store";
import { getStorage } from "@backend/storage";
import { isEditable } from "@backend/plan/status";
import { brandRoute, ConflictError, readJsonBody } from "../../../../../lib/brandApi";
import { brandRepo } from "../../../../../lib/brandRepo";
import { enqueueBrandTask, queue } from "../../../../../lib/tasks";

/**
 * POST /api/brands/<slug>/cards/<cardId> { action }
 *
 *   approve      draft → approved (needs a script; nothing may still be writing it)
 *   unapprove    approved → draft
 *   rewrite      a new script for the card, with an optional note (drafts only)
 *   swap         back the card with another source and write a new script (drafts only)
 *   storyboard   one still per shot (drafts and approved cards)
 *
 * Status rules live in backend/plan/status.ts; this only adds what needs the
 * queue or the files.
 */

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("unapprove") }),
  z.object({ action: z.literal("rewrite"), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("swap"), sourceId: z.string().min(1).max(100) }),
  z.object({ action: z.literal("storyboard") }),
]);

/** Storyboards cost real money (an image per shot), so a customer cannot
 *  start them all at once. */
const MAX_LIVE_STORYBOARDS = 4;

const WRITING_KINDS = ["card.adapt", "card.storyboard"];

export async function POST(req: Request, { params }: { params: Promise<{ slug: string; cardId: string }> }) {
  const { slug, cardId } = await params;
  return brandRoute(slug, async ({ user }) => {
    const body = await readJsonBody(req, Body);
    const card = await brandRepo.getCard(slug, cardId);
    if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
    const actor = user.isAdmin ? "admin" : "customer";
    const live = await queue.listTasks({ slug, cardId, kinds: WRITING_KINDS });

    switch (body.action) {
      case "approve": {
        if (live.length > 0) throw new ConflictError("This video is still being written. Try again in a moment.");
        if (!(await brandRepo.getScript(slug, cardId))) throw new ConflictError("This video has no script yet.");
        await brandRepo.transitionCard(slug, cardId, "approved", actor);
        return NextResponse.json({ ok: true });
      }
      case "unapprove": {
        await brandRepo.transitionCard(slug, cardId, "draft", actor);
        return NextResponse.json({ ok: true });
      }
      case "rewrite": {
        if (!isEditable(card.status)) throw new ConflictError("Only a draft can be rewritten. Unapprove it first.");
        const taskId = await enqueueBrandTask("card.adapt", { slug, cardId, note: body.note }, { discriminator: "rewrite" });
        return NextResponse.json({ ok: true, taskId: taskId ?? live.find((t) => t.kind === "card.adapt")?.id ?? null });
      }
      case "swap": {
        if (!isEditable(card.status)) throw new ConflictError("Only a draft can change its source. Unapprove it first.");
        if (live.length > 0) throw new ConflictError("This video is still being written. Try again in a moment.");
        const pool = (await brandRepo.listSources(slug)).filter((s) => s.hasSpec);
        if (!pool.some((s) => s.sourceId === body.sourceId)) throw new ConflictError("That is not one of this brand's viral videos.");
        if (body.sourceId !== card.sourceId) {
          const storage = getStorage();
          // Stills of the old video would sit under the new one.
          for (const key of await storage.list(recreationKeys(slug).board(cardId))) await storage.remove(key);
          await updatePlan(storage, slug, (plan) => {
            const cards = plan.cards.map((c) => (c.id === cardId ? { ...c, sourceId: body.sourceId } : c));
            const alternates = pickAlternates(cards, pool.map((s) => ({ sourceId: s.sourceId, topic: "", hook: "", whyItWorks: "", durationSec: 0, language: "" })));
            return { ...plan, cards: cards.map((c) => (c.id === cardId ? { ...c, alternates: (alternates.get(c.day) ?? []).map((sourceId) => ({ sourceId, angle: "" })) } : c)) };
          });
        }
        const taskId = await enqueueBrandTask("card.adapt", { slug, cardId }, { discriminator: "swap" });
        return NextResponse.json({ ok: true, taskId });
      }
      case "storyboard": {
        if (!(await brandRepo.getScript(slug, cardId))) throw new ConflictError("Write the script first.");
        const running = (await queue.listTasks({ slug, kinds: ["card.storyboard"] })).length;
        if (running >= MAX_LIVE_STORYBOARDS) throw new ConflictError("Other storyboards are being made. Try again when one finishes.");
        const taskId = await enqueueBrandTask("card.storyboard", { slug, cardId });
        return NextResponse.json({ ok: true, taskId: taskId ?? live.find((t) => t.kind === "card.storyboard")?.id ?? null });
      }
    }
  });
}
