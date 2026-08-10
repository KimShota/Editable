import type { Slot } from "@backend/pipeline/types";

/** Human-friendly display name for a slot: its authored `label` when the
 *  format supplies one, otherwise a prettified version of the raw variable
 *  name (`resource1_desc` -> "Resource1 desc") — always readable, never the
 *  bare snake_case/kebab-case binding key. */
export const slotLabel = (slot: Pick<Slot, "name" | "label">): string => {
  if (slot.label) return slot.label;
  const spaced = slot.name.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
