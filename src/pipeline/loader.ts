import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FormatSchema } from "./schemas";
import { Format } from "./types";
import { formatsDir } from "./paths";

/**
 * Module 1 — Format loader.
 * Takes a format id, returns a validated format definition. This is where
 * the founder's authored judgment enters the system; everything downstream
 * trusts the shape because it is validated here, once.
 */
export const loadFormat = (formatId: string): Format => {
  const file = path.join(formatsDir, `${formatId}.json`);
  if (!fs.existsSync(file)) {
    const available = listFormats().join(", ") || "(none)";
    throw new Error(
      `Unknown format "${formatId}" — no such file ${file}. Available formats: ${available}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Format file ${file} is not valid JSON: ${(err as Error).message}`);
  }

  const parsed = FormatSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Format "${formatId}" failed validation:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
};

/** All format ids available in the library (one config file per format). */
export const listFormats = (): string[] => {
  if (!fs.existsSync(formatsDir)) return [];
  return fs
    .readdirSync(formatsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
};
