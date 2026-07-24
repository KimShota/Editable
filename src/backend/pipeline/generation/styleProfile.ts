import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { StyleProfileSchema } from "../schemas";
import { StyleProfile } from "../types";
import { formatStylesDir } from "../paths";

/**
 * A format's visual DNA (see schemas.ts's StyleProfileSchema doc comment),
 * hand-authored (v1) as formats/styles/<formatId>.json — a subdirectory,
 * not formatsDir itself, since loader.ts's listFormats() treats every
 * *.json directly in formatsDir as a Format to enumerate on the templates
 * page. Optional — a format with generated slots but no style file still
 * generates, just with bland/neutral defaults instead of the reference
 * reel's actual look, rather than failing the whole pipeline over a
 * missing aesthetic file.
 */
export const loadStyleProfile = (formatId: string): StyleProfile => {
  const file = path.join(formatStylesDir, `${formatId}.json`);
  if (!fs.existsSync(file)) {
    console.warn(`generate: no StyleProfile at ${file} — generated inserts will use neutral defaults`);
    return { formatId, environment: "a plain, neutral studio backdrop", lighting: "soft, even light" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`StyleProfile file ${file} is not valid JSON: ${(err as Error).message}`);
  }

  const parsed = StyleProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`StyleProfile "${formatId}" failed validation:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};
