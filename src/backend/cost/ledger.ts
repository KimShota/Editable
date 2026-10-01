import type { QueryFn } from "../../app/lib/db";

/**
 * The cost ledger: one row per paid API call (plan section 3.4). Every
 * provider wrapper reports here, so "cost per video" is a SQL sum rather
 * than an estimate, and the tier prices in plan section 4 can be set from
 * measured numbers.
 *
 * Recording is best-effort by design: a ledger write that fails must never
 * fail the generation it describes (the money is already spent), so
 * `recordCost` logs and swallows its own errors.
 */

export type CostEntry = {
  brandId?: string | null;
  provider: string;
  model: string;
  operation: string;
  /** Raw usage as the provider reported it (tokens, seconds, credits). */
  units: Record<string, number>;
  usd: number;
  ref?: string | null;
};

/** A sink for cost entries. The CLI tools use `consoleSink` when there is no
 *  database to write to; the app and the worker use `dbSink`. */
export type CostSink = (entry: CostEntry) => Promise<void>;

export const dbSink =
  (query: QueryFn): CostSink =>
  async (entry) => {
    try {
      await query(
        `insert into cost_ledger (brand_id, provider, model, operation, units, usd, ref)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [entry.brandId ?? null, entry.provider, entry.model, entry.operation, JSON.stringify(entry.units), entry.usd, entry.ref ?? null],
      );
    } catch (err) {
      console.warn(`cost ledger: failed to record ${entry.provider}/${entry.operation} ($${entry.usd.toFixed(4)}): ${err instanceof Error ? err.message : err}`);
    }
  };

export const consoleSink: CostSink = async (entry) => {
  console.log(`  $ ${entry.usd.toFixed(4)}  ${entry.provider}/${entry.model}  ${entry.operation}${entry.ref ? `  (${entry.ref})` : ""}`);
};

/** Anthropic list prices, USD per million tokens. Cache writes bill at
 *  1.25× input, cache reads at 0.1× input. */
const ANTHROPIC_PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** USD for one Messages API response. Throws on an unknown model rather than
 *  recording $0, which would silently understate cost per video. */
export const anthropicCostUsd = (model: string, usage: AnthropicUsage): number => {
  const price = ANTHROPIC_PRICES[model];
  if (!price) throw new Error(`cost ledger: no price for Anthropic model "${model}" — add it to ANTHROPIC_PRICES`);
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return (
    (usage.input_tokens * price.input + cacheWrite * price.input * 1.25 + cacheRead * price.input * 0.1 + usage.output_tokens * price.output) /
    1_000_000
  );
};

/** Google image-model list prices, USD per output image at ≤2K resolution. */
const GOOGLE_IMAGE_PRICES: Record<string, number> = {
  "gemini-3-pro-image": 0.134,
};

export const googleImageCostEntry = (model: string, images: number, operation: string, extra: { brandId?: string | null; ref?: string | null } = {}): CostEntry => {
  const price = GOOGLE_IMAGE_PRICES[model];
  if (price === undefined) throw new Error(`cost ledger: no price for Google image model "${model}" — add it to GOOGLE_IMAGE_PRICES`);
  return { ...extra, provider: "google", model, operation, units: { images }, usd: price * images };
};

export const anthropicCostEntry = (
  model: string,
  usage: AnthropicUsage,
  operation: string,
  extra: { brandId?: string | null; ref?: string | null } = {},
): CostEntry => ({
  ...extra,
  provider: "anthropic",
  model,
  operation,
  units: {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  },
  usd: anthropicCostUsd(model, usage),
});
