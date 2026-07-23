import { Format } from "../pipeline/types";
import { ScriptSuggestionSchema } from "./schemas";
import { ScriptSuggestion } from "./types";
import { ContentChoice, generateStructured } from "./provider";

/**
 * Suggests spoken lines / short on-screen text for a format's slots, given
 * a topic — the "what do I actually say" gap between a format's generic
 * filming instructions and a specific creator's content. A voice block's
 * suggested line MUST open with its literal anchor's marker phrase
 * verbatim (that's how the structure gets found in the real recording);
 * everything after the marker is where the topic-specific content lives.
 */

const buildScriptPrompt = (format: Format, topic: string): string => {
  const sections: string[] = [];

  for (const block of format.blocks) {
    const lines: string[] = [];

    if (block.kind === "voice") {
      const literalAnchors = block.anchors.filter((a) => a.kind === "literal");
      lines.push(`  Write the full spoken line for slot "${block.videoSlot}" (said on camera).`);
      for (const a of literalAnchors) {
        const phraseList = a.phrases.map((p) => `"${p}"`).join(" or ");
        const captureNote = a.capture
          ? ` — then continue with the topic-specific words to capture${a.captureUntil ? `, ending right before "${a.captureUntil}"` : ""}`
          : "";
        lines.push(`    must open with one of: ${phraseList}${captureNote}`);
      }
    }

    for (const slot of block.slots) {
      if (slot.mediaType !== "text") continue;
      lines.push(`  Write short text for slot "${slot.name}": ${slot.instructions}`);
    }

    if (lines.length > 0) {
      sections.push(`Block "${block.id}" ("${block.title}"):\n${lines.join("\n")}`);
    }
  }

  return `You are writing the spoken lines and short on-screen text for one video, filmed into the format "${format.name}" (${format.description}), about this topic: "${topic}".

${sections.join("\n\n")}

For every voice-block line, open with the required marker phrase EXACTLY as given verbatim, then continue with topic-specific content fitting the block's instructions. Match the tone the block's title/instructions imply. Keep each line short enough to say naturally in a few seconds.

Return a JSON object: {"suggestions": [{"blockId": "<block id>", "slotName": "<slot name>", "text": "<the line or short text>"}, ...]} — exactly one entry per line requested above. Respond with ONLY the JSON object, no other text.`;
};

export const generateScript = async (
  format: Format,
  topic: string,
  choice: ContentChoice = "auto",
): Promise<ScriptSuggestion> => {
  const prompt = buildScriptPrompt(format, topic);
  const raw = await generateStructured(
    prompt,
    ScriptSuggestionSchema.omit({ topic: true, createdAt: true }),
    choice,
  );
  return { topic, createdAt: new Date().toISOString(), suggestions: raw.suggestions };
};
