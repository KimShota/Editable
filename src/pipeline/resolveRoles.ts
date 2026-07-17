import { Format, ResolvedRole, ResolvedRoles, Transcript, TrimPoints, Word } from "./types";
import { anchoredTimeSec, clamp, toTrimmedWords } from "./timing";
import { pickResolver, ResolverChoice } from "./resolvers";
import { RoleResolution } from "./resolvers/protocol";

/**
 * Module 5 — Role resolution (the brain).
 * The format lists roles as plain-language descriptions; an LLM reads each
 * user's specific trimmed transcript and returns a timestamp per role with
 * a confidence. Below the confidence threshold — or when no LLM is
 * available, or the call fails — the role degrades gracefully to its config
 * fallback position. Returned times snap to the nearest word start so
 * overlays land on word boundaries.
 *
 * All times here are TRIMMED-clip seconds (the trim-then-time rule).
 */

const CONFIDENCE_THRESHOLD = 0.6;

const snapToWordStart = (timeSec: number, words: Word[]): number => {
  if (words.length === 0) return timeSec;
  let best = words[0].startSec;
  for (const w of words) {
    if (Math.abs(w.startSec - timeSec) < Math.abs(best - timeSec)) {
      best = w.startSec;
    }
  }
  return best;
};

export const resolveRoles = async (
  format: Format,
  transcript: Transcript,
  trims: TrimPoints,
  choice: ResolverChoice = "auto",
): Promise<ResolvedRoles> => {
  const resolver = pickResolver(choice);
  const roles: ResolvedRole[] = [];

  for (const block of format.blocks) {
    if (block.kind !== "voice" || block.roles.length === 0) continue;

    const trim = trims.blocks.find((b) => b.blockId === block.id);
    if (!trim) throw new Error(`resolveRoles: no trim points for block "${block.id}"`);
    const blockDurationSec = trim.srcOutSec - trim.srcInSec;

    const rawWords = transcript.blocks.find((b) => b.blockId === block.id)?.words ?? [];
    const words = toTrimmedWords(rawWords, trim.srcInSec, blockDurationSec);

    let resolutions: RoleResolution[] = [];
    if (resolver && words.length > 0) {
      try {
        resolutions = await resolver.resolveBlock({
          blockId: block.id,
          roles: block.roles,
          words,
          blockDurationSec,
        });
      } catch (err) {
        console.warn(
          `resolveRoles: ${resolver.name} failed on block "${block.id}" (${(err as Error).message}) — using fallbacks`,
        );
      }
    }

    for (const role of block.roles) {
      const hit = resolutions.find((r) => r.roleId === role.id);
      if (hit && hit.confidence >= CONFIDENCE_THRESHOLD) {
        roles.push({
          blockId: block.id,
          roleId: role.id,
          timeSec: clamp(snapToWordStart(hit.timeSec, words), 0, blockDurationSec),
          confidence: clamp(hit.confidence, 0, 1),
          source: "llm",
          quote: hit.quote,
        });
      } else {
        roles.push({
          blockId: block.id,
          roleId: role.id,
          timeSec: anchoredTimeSec(role.fallback, blockDurationSec),
          confidence: hit ? clamp(hit.confidence, 0, 1) : 0,
          source: "fallback",
        });
      }
    }
  }

  return { resolver: resolver?.name ?? "fallback", roles };
};
