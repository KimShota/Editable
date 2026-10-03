import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { anthropicCostEntry, type CostSink } from "../cost/ledger";
import { CYCLE_DAYS } from "./schemas";

/**
 * Fills the free days of a brand's 14-day plan from its pool of viral
 * sources (plan/ui-ux-full-flow.md §2.4, `plan.build`). Claude picks which
 * source backs each day and writes a one-line angle for it; everything else
 * (that the answer covers exactly the free days, uses real sources, does not
 * repeat a format back to back or repeat an angle) is checked here in code,
 * not trusted.
 */

export type PoolSource = {
  sourceId: string;
  topic: string;
  hook: string;
  whyItWorks: string;
  durationSec: number;
  language: string;
};

export type ProposeInput = {
  company: string;
  product: { name: string; oneLiner: string; features: string[] };
  audience: string;
  language: string;
  /** The angle locked for this cycle, if the customer picked one. */
  niche: { title: string; whyItFits: string } | null;
  sources: PoolSource[];
  /** Days (1..14) that need a card. */
  freeDays: number[];
  /** Cards already in the plan: kept as they are, and context for the rest. */
  existing: { day: number; sourceId: string; angle: string }[];
};

export const ProposalSchema = z.object({
  cards: z
    .array(
      z.object({
        day: z.number().int().describe("The day number this card is for."),
        sourceId: z.string().describe("Exactly one id from the source list."),
        angle: z.string().describe("What THIS video says, one sentence, specific to the product. Not the source's topic."),
      }),
    )
    .describe("Exactly one entry per day to fill, in day order."),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export class ProposalError extends Error {
  constructor(readonly problems: string[]) {
    super(`plan proposal rejected: ${problems.join("; ")}`);
    this.name = "ProposalError";
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Everything wrong with `proposal`, or an empty list. Pure. */
export const proposalProblems = (input: ProposeInput, proposal: Proposal): string[] => {
  const problems: string[] = [];
  const ids = new Set(input.sources.map((s) => s.sourceId));
  const free = new Set(input.freeDays);
  const seenDays = new Set<number>();

  for (const c of proposal.cards) {
    if (!free.has(c.day)) problems.push(`day ${c.day} is not a day to fill`);
    if (seenDays.has(c.day)) problems.push(`day ${c.day} appears twice`);
    seenDays.add(c.day);
    if (!ids.has(c.sourceId)) problems.push(`day ${c.day}: "${c.sourceId}" is not a source in the list`);
    if (!c.angle.trim()) problems.push(`day ${c.day}: the angle is empty`);
  }
  for (const d of input.freeDays) if (!seenDays.has(d)) problems.push(`day ${d} has no card`);

  // The same angle twice means two videos that say the same thing.
  const angles = new Map<string, number>();
  for (const e of input.existing) angles.set(norm(e.angle), e.day);
  for (const c of proposal.cards) {
    const key = norm(c.angle);
    const clash = angles.get(key);
    if (clash !== undefined && clash !== c.day) problems.push(`day ${c.day} repeats the angle of day ${clash}`);
    angles.set(key, c.day);
  }

  if (input.sources.length > 1) {
    // The whole schedule as it would stand, to compare neighbours.
    const bySourceDay = new Map<number, string>();
    for (const e of input.existing) bySourceDay.set(e.day, e.sourceId);
    for (const c of proposal.cards) bySourceDay.set(c.day, c.sourceId);
    for (const c of proposal.cards) {
      if (bySourceDay.get(c.day - 1) === c.sourceId || bySourceDay.get(c.day + 1) === c.sourceId) {
        problems.push(`day ${c.day} uses the same source as a neighbouring day`);
      }
    }
    // No format should dominate: each source at most its fair share plus one.
    const total = input.existing.length + proposal.cards.length;
    const cap = Math.ceil(total / input.sources.length) + 1;
    const uses = new Map<string, number>();
    for (const sourceId of bySourceDay.values()) uses.set(sourceId, (uses.get(sourceId) ?? 0) + 1);
    for (const [sourceId, n] of uses) if (n > cap) problems.push(`source ${sourceId} is used ${n} times (at most ${cap})`);
  }
  return problems;
};

/** Up to `count` other sources per card for "Swap", the ones used least so
 *  far, so the alternates spread across the pool. Pure and deterministic. */
export const pickAlternates = (cards: { day: number; sourceId: string }[], sources: PoolSource[], count = 2): Map<number, string[]> => {
  const uses = new Map<string, number>(sources.map((s) => [s.sourceId, 0]));
  for (const c of cards) uses.set(c.sourceId, (uses.get(c.sourceId) ?? 0) + 1);
  const out = new Map<number, string[]>();
  for (const c of cards) {
    const others = sources
      .filter((s) => s.sourceId !== c.sourceId)
      .sort((a, b) => (uses.get(a.sourceId) ?? 0) - (uses.get(b.sourceId) ?? 0) || a.sourceId.localeCompare(b.sourceId))
      .slice(0, count)
      .map((s) => s.sourceId);
    out.set(c.day, others);
    // Offering a source as an alternate counts a little, so the next card gets different ones.
    for (const id of others) uses.set(id, (uses.get(id) ?? 0) + 0.01);
  }
  return out;
};

export const buildProposalText = (input: ProposeInput): string => {
  const sources = input.sources
    .map((s) => `  ${s.sourceId} (${s.durationSec.toFixed(0)}s, ${s.language}): ${s.topic}\n    hook: ${s.hook}\n    why it works: ${s.whyItWorks}`)
    .join("\n");
  const existing = input.existing.length
    ? [...input.existing]
        .sort((a, b) => a.day - b.day)
        .map((e) => `  day ${e.day}: ${e.sourceId} · "${e.angle}"`)
        .join("\n")
    : "  (none)";
  return [
    `BRAND: ${input.company}. PRODUCT: ${input.product.name}: ${input.product.oneLiner}`,
    `Features (the only product facts to build on):\n${input.product.features.map((f) => `  - ${f}`).join("\n")}`,
    `Audience: ${input.audience}. Content language: ${input.language}.`,
    input.niche ? `NICHE LOCKED FOR THIS CYCLE: ${input.niche.title}. ${input.niche.whyItFits}` : "No niche has been locked: stay close to the product's own value.",
    ``,
    `VIRAL SOURCES available (each is a format to recreate with the brand's own character and product):\n${sources}`,
    ``,
    `ALREADY PLANNED:\n${existing}`,
    ``,
    `Plan a video for each of these days: ${input.freeDays.join(", ")} (of ${CYCLE_DAYS}).`,
    `Rules: use only the listed source ids. Never use the same source on two neighbouring days, counting days already planned. Spread the sources: no one format more than its fair share. Every angle must be a different idea, specific to this product, and fit the source's format. Do not repeat an angle already planned.`,
  ].join("\n");
};

const DEFAULT_MODEL = "claude-sonnet-5-5";
const FALLBACK_MODEL = "claude-opus-4-8";

export type Proposer = (input: ProposeInput) => Promise<Proposal>;

/** Builds a Proposer that records its cost to `costSink` under `ref`. */
export type ProposerFactory = (costSink: CostSink, ref: string) => Proposer;

/** Asks Claude for the plan, and once more with the problems named if the
 *  first answer breaks a rule. A second failure is an error. */
export const claudeProposer =
  (opts: { costSink?: CostSink; ref?: string; model?: string; client?: Anthropic } = {}): Proposer =>
  async (input) => {
    const client = opts.client ?? new Anthropic({ timeout: 120_000 });
    const model = opts.model ?? process.env.PLAN_MODEL ?? DEFAULT_MODEL;
    const ask = async (extra?: string): Promise<Proposal> => {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 8_000,
        betas: ["server-side-fallback-2026-06-01"],
        fallbacks: [{ model: FALLBACK_MODEL }],
        output_config: { effort: "low", format: betaZodOutputFormat(ProposalSchema) },
        system:
          "You plan a brand's daily short-form video calendar. Each day recreates one proven viral format with the brand's recurring character, so the series builds a recognisable identity. " +
          "Write angles the way a creator would pitch them: concrete and specific, never generic marketing. State no product facts beyond those given.",
        messages: [{ role: "user", content: extra ? `${buildProposalText(input)}\n\n${extra}` : buildProposalText(input) }],
      });
      await opts.costSink?.(anthropicCostEntry(response.model, response.usage, "plan_propose", { ref: opts.ref }));
      if (response.stop_reason === "refusal") throw new Error("plan: the model declined to plan these videos");
      if (response.stop_reason === "max_tokens") throw new Error("plan: the plan was cut off at max_tokens");
      if (!response.parsed_output) throw new Error("plan: response did not match the proposal schema");
      return response.parsed_output;
    };

    const first = await ask();
    const problems = proposalProblems(input, first);
    if (problems.length === 0) return first;
    const second = await ask(`Your previous answer was rejected for these reasons. Fix every one and answer again in full:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    const again = proposalProblems(input, second);
    if (again.length > 0) throw new ProposalError(again);
    return second;
  };
