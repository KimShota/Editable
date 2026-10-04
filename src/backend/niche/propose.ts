import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { BrandIntake } from "../brand/intake/schemas";
import { anthropicCostEntry, type CostSink } from "../cost/ledger";

/**
 * The 3 to 5 content angles a brand could build its daily videos around
 * (plan decision 4): one is picked, and stays for the 14-day cycle. Claude
 * proposes; whether the answer is usable (3 to 5, distinct, each with real
 * example hooks) is checked here in code, not trusted.
 *
 * "Evidence" (what is actually going viral in each angle) comes with the
 * research at launch; today an angle is justified by the product alone, and
 * says so.
 */

export const AngleDraftSchema = z.object({
  title: z.string().describe("The angle in a few words, as a series name: e.g. 'Mac shortcuts you did not know'."),
  whyItFits: z.string().describe("Two sentences: why this angle suits this product and this audience, using only facts you were given."),
  exampleHooks: z.array(z.string()).describe("Two or three opening lines a creator could actually say, specific to the product."),
});

export const NicheProposalSchema = z.object({
  angles: z.array(AngleDraftSchema).describe("Between 3 and 5 angles that are clearly different from each other."),
});
export type NicheProposal = z.infer<typeof NicheProposalSchema>;

export class NicheProposalError extends Error {
  constructor(readonly problems: string[]) {
    super(`niche proposal rejected: ${problems.join("; ")}`);
    this.name = "NicheProposalError";
  }
}

const slugOf = (title: string): string =>
  title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48);

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Everything wrong with a proposal, or an empty list. Pure. */
export const nicheProblems = (proposal: NicheProposal): string[] => {
  const problems: string[] = [];
  const n = proposal.angles.length;
  if (n < 3 || n > 5) problems.push(`expected 3 to 5 angles, got ${n}`);
  const titles = new Set<string>();
  const ids = new Set<string>();
  for (const [i, a] of proposal.angles.entries()) {
    const label = `angle ${i + 1}`;
    if (!a.title.trim()) problems.push(`${label} has no title`);
    if (!a.whyItFits.trim()) problems.push(`${label} does not say why it fits`);
    const hooks = a.exampleHooks.map((h) => h.trim()).filter(Boolean);
    if (hooks.length < 2 || hooks.length > 3) problems.push(`${label} needs 2 or 3 example hooks, got ${hooks.length}`);
    if (new Set(hooks.map(norm)).size !== hooks.length) problems.push(`${label} repeats a hook`);
    const t = norm(a.title);
    if (titles.has(t)) problems.push(`two angles are both called "${a.title}"`);
    titles.add(t);
    const id = slugOf(a.title);
    if (!id) problems.push(`${label} has a title that makes no id`);
    if (id && ids.has(id)) problems.push(`two angles make the same id "${id}"`);
    ids.add(id);
  }
  return problems;
};

/** The proposal as stored: each angle gets a stable id from its title. */
export const withIds = (proposal: NicheProposal) =>
  proposal.angles.map((a) => ({ id: slugOf(a.title), title: a.title.trim(), whyItFits: a.whyItFits.trim(), exampleHooks: a.exampleHooks.map((h) => h.trim()).filter(Boolean) }));

export const buildNicheText = (intake: BrandIntake): string => {
  const product = intake.products[intake.recommendedProductIndex] ?? intake.products[0];
  return [
    `BRAND: ${intake.companyName}. ${intake.summary}`,
    `PRODUCT: ${product.name}: ${product.oneLiner} (${product.type}).`,
    `Features (the only product facts you may use):\n${product.features.map((f) => `  - ${f}`).join("\n")}`,
    `Price and access: ${product.priceNote ?? "unknown"}`,
    `Audience: ${product.audience || intake.audience}. Tone: ${intake.tone.join(", ")}. Language: ${intake.language}.`,
    ``,
    `Propose 3 to 5 angles for a daily short-form video series starring one recurring character. Each is a repeatable series idea, not a one-off video, and clearly different from the others.`,
  ].join("\n");
};

// No server-side fallback here: the API refuses one for Sonnet 5.5 (it lists no allowed fallback models).
const DEFAULT_MODEL = "claude-sonnet-5-5";

export type NicheProposer = (intake: BrandIntake) => Promise<NicheProposal>;
export type NicheProposerFactory = (costSink: CostSink, ref: string) => NicheProposer;

/** Asks Claude, and once more with the problems named if the answer breaks a
 *  rule. A second failure is an error. */
export const claudeNicheProposer =
  (opts: { costSink?: CostSink; ref?: string; model?: string; client?: Anthropic } = {}): NicheProposer =>
  async (intake) => {
    const client = opts.client ?? new Anthropic({ timeout: 120_000 });
    const model = opts.model ?? process.env.NICHE_MODEL ?? DEFAULT_MODEL;
    const ask = async (extra?: string): Promise<NicheProposal> => {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 4_000,
        output_config: { effort: "low", format: betaZodOutputFormat(NicheProposalSchema) },
        system:
          "You help a brand choose what its daily short-form videos are about. Write like a creator pitching a series: concrete and specific, never generic marketing. State no product facts beyond those given, and no invented numbers or results.",
        messages: [{ role: "user", content: extra ? `${buildNicheText(intake)}\n\n${extra}` : buildNicheText(intake) }],
      });
      await opts.costSink?.(anthropicCostEntry(response.model, response.usage, "niche_propose", { ref: opts.ref }));
      if (response.stop_reason === "refusal") throw new Error("niche: the model declined to propose angles");
      if (response.stop_reason === "max_tokens") throw new Error("niche: the answer was cut off at max_tokens");
      if (!response.parsed_output) throw new Error("niche: response did not match the schema");
      return response.parsed_output;
    };
    const first = await ask();
    const problems = nicheProblems(first);
    if (problems.length === 0) return first;
    const second = await ask(`Your previous answer was rejected for these reasons. Fix every one and answer again in full:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    const again = nicheProblems(second);
    if (again.length > 0) throw new NicheProposalError(again);
    return second;
  };
