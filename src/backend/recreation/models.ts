/**
 * The server-side fallback for a recreation call: what the API retries on if the main model is
 * overloaded. A model may only fall back to the ones its own record allows (GET /v1/models/<id>
 * `allowed_fallback_models`), and every model that can answer must have a price in cost/ledger.ts,
 * or the call's cost cannot be recorded after it is paid for. Sonnet 5.5 may only fall back to
 * claude-sonnet-5, which has no price there yet, so Sonnet runs have no fallback.
 */
const FALLBACKS: Record<string, string> = {
  "claude-opus-5-5": "claude-opus-4-8",
};

export const fallbackOptions = (model: string): { betas: string[]; fallbacks?: { model: string }[] } => {
  const to = FALLBACKS[model];
  return to ? { betas: ["server-side-fallback-2026-06-01"], fallbacks: [{ model: to }] } : { betas: [] };
};
