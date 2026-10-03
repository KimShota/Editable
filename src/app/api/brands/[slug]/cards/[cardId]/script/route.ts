import { NextResponse } from "next/server";
import { z } from "zod";
import { updatePlan } from "@backend/plan/store";
import { isEditable } from "@backend/plan/status";
import { getStorage } from "@backend/storage";
import { brandRoute, ConflictError, readJsonBody } from "../../../../../../lib/brandApi";
import { brandRepo } from "../../../../../../lib/brandRepo";
import { queue } from "../../../../../../lib/tasks";

/**
 * PUT /api/brands/<slug>/cards/<cardId>/script { lines: [{ index, text }] }
 * Saves the customer's edits to the adapted lines of a draft. Only the words
 * change: shots, treatments and timing come from the source and stay put.
 */

const Body = z.object({
  lines: z.array(z.object({ index: z.number().int().min(0), text: z.string().trim().min(1, "a line cannot be empty").max(400) })).min(1).max(40),
});

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string; cardId: string }> }) {
  const { slug, cardId } = await params;
  return brandRoute(slug, async () => {
    const { lines } = await readJsonBody(req, Body);
    const card = await brandRepo.getCard(slug, cardId);
    if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!isEditable(card.status)) throw new ConflictError("Only a draft can be edited. Unapprove it first.");
    if ((await queue.listTasks({ slug, cardId, kinds: ["card.adapt"] })).length > 0) throw new ConflictError("A new script is being written. Try again when it is done.");

    const script = await brandRepo.getScript(slug, cardId);
    if (!script) throw new ConflictError("This video has no script yet.");
    const edits = new Map(lines.map((l) => [l.index, l.text]));
    for (const index of edits.keys()) if (!script.lines.some((l) => l.index === index)) throw new ConflictError(`There is no line ${index}.`);

    const next = {
      ...script,
      lines: script.lines.map((l) => {
        const text = edits.get(l.index);
        // A line the customer changed is no longer the source's verbatim line.
        return text === undefined || text === l.text ? l : { ...l, text, kept: false, wordCount: text.split(/\s+/).filter(Boolean).length };
      }),
    };
    await brandRepo.saveScript(slug, cardId, next);
    await updatePlan(getStorage(), slug, (plan) => ({ ...plan, cards: plan.cards.map((c) => (c.id === cardId ? { ...c, hook: next.lines[0]?.text ?? c.hook } : c)) }));
    return NextResponse.json({ ok: true });
  });
}
