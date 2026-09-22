import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FormatSchema } from "../pipeline/schemas";
import { formatsDir } from "../pipeline/paths";

/**
 * Module A5 — Save.
 * Promotes a validated draft Format into the real format library
 * (formats/<id>.json) — the moment a draft graduates out of authoring/.
 * Shared by the web save route (src/app/api/authoring/[draftId]/save/
 * route.ts, which re-validates whatever the reviewer edited in the UI)
 * and `npm run author:save` (saveCli.ts, which reads draft.json straight
 * off disk — see its own doc comment), so there's exactly one place that
 * decides what "already exists" means and what actually gets written.
 */

/** Whether formats/<id>.json exists at all — the "already exists" guard,
 *  and the same check src/app/lib/formats.ts's formatExists makes for
 *  404 handling (kept as a separate copy here since backend code can't
 *  import from src/app — see SlotSchema's own doc comment on the split). */
export const formatExists = (formatId: string): boolean =>
  fs.existsSync(path.join(formatsDir, `${formatId}.json`));

export class FormatAlreadyExistsError extends Error {
  constructor(formatId: string) {
    super(`a format with id "${formatId}" already exists — change the id and try again`);
    this.name = "FormatAlreadyExistsError";
  }
}

/** Validates and writes a Format to formats/<id>.json. Throws a plain
 *  Error (with FormatSchema's own prettified zod message) if `format`
 *  doesn't validate — including its cross-reference superRefine checks,
 *  the exact same ones loadFormat() runs on every real format — or a
 *  FormatAlreadyExistsError if the id is taken. */
export const saveFormat = (format: unknown): { formatId: string } => {
  const parsed = FormatSchema.safeParse(format);
  if (!parsed.success) {
    throw new Error(`format failed validation:\n${z.prettifyError(parsed.error)}`);
  }
  if (formatExists(parsed.data.id)) {
    throw new FormatAlreadyExistsError(parsed.data.id);
  }
  fs.mkdirSync(formatsDir, { recursive: true });
  fs.writeFileSync(path.join(formatsDir, `${parsed.data.id}.json`), JSON.stringify(parsed.data, null, 2));
  return { formatId: parsed.data.id };
};
