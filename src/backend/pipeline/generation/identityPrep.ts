import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateText } from "./geminiImage";
import { PoseTag } from "../types";

/**
 * Prepares a job's identity photos for use as generation references:
 * strips letterbox bars (an iPhone screenshot's own black top/bottom bars
 * — common when a photo was pulled from Messages/Photos rather than shot
 * directly) via ffmpeg's own border detection, then (Gemini available)
 * classifies each photo's pose into a small fixed vocabulary so
 * generation/modelShots.ts's plateStill kind can pick "the sitting photo"
 * or "the standing arms-crossed photo" instead of an arbitrary seed%n
 * index — the fix for a generated montage's wardrobe/angle flickering
 * between shots because consecutive slots' seeds landed on different
 * source photos with nothing in common.
 */

const cropDir = (jobDir: string): string => path.join(jobDir, "generated", "identity-prepped");

/** ffmpeg's own `cropdetect` filter finds the largest non-black rectangle
 *  in a frame — generic border removal, no hardcoded bar thickness, so it
 *  works for whatever aspect ratio a given screenshot/photo happens to
 *  have. Copies the file through unchanged if no crop was found (a photo
 *  with no letterboxing at all). */
const cropLetterbox = (inputPath: string, outputPath: string): void => {
  const result = spawnSync(
    "ffmpeg",
    ["-i", inputPath, "-vf", "cropdetect=24:2:0", "-frames:v", "1", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const stderr = result.stderr ?? "";
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const last = matches[matches.length - 1];
  if (!last) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }
  const [, w, h, x, y] = last;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", inputPath, "-vf", `crop=${w}:${h}:${x}:${y}`, outputPath]);
};

/** Letterbox-cropped copies of `identityImages`, cached by content hash so
 *  repeated jobs/re-runs don't re-run cropdetect on unchanged photos. */
export const prepIdentityImages = (identityImages: string[], jobDir: string): string[] => {
  const dir = cropDir(jobDir);
  fs.mkdirSync(dir, { recursive: true });
  return identityImages.map((imagePath) => {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(imagePath)).digest("hex").slice(0, 16);
    const outPath = path.join(dir, `${sha}${path.extname(imagePath) || ".png"}`);
    if (!fs.existsSync(outPath)) cropLetterbox(imagePath, outPath);
    return outPath;
  });
};

const POSE_TAGS: PoseTag[] = ["standing", "closeup", "profile", "sitting", "other"];

/** Deterministic fallback when Gemini is unavailable or its response can't
 *  be trusted — cycles through the tag vocabulary by index so a job with
 *  enough photos still gets some spread rather than every slot picking
 *  photo 0. Not as good as real classification, but never breaks a build. */
const fallbackPoseTags = (count: number): PoseTag[] =>
  Array.from({ length: count }, (_, i) => POSE_TAGS[i % POSE_TAGS.length]);

const classifyPrompt = (count: number): string =>
  `You are given ${count} reference photos of one person, in order, numbered 0 to ${count - 1}. ` +
  `Classify EACH photo's pose into exactly one of these tags: ` +
  `"standing" (full body or most of the body visible, standing), ` +
  `"closeup" (face/head-and-shoulders close-up), ` +
  `"profile" (side-on or three-quarter angle, face not fully forward), ` +
  `"sitting" (seated), ` +
  `"other" (none of the above clearly applies). ` +
  `Respond with ONLY a JSON array of ${count} strings, one tag per photo in order, no other text. ` +
  `Example for 3 photos: ["standing","closeup","sitting"]`;

const parsePoseTags = (text: string, count: number): PoseTag[] | undefined => {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== count) return undefined;
  const tags = parsed.map((t) => (POSE_TAGS.includes(t as PoseTag) ? (t as PoseTag) : "other"));
  return tags as PoseTag[];
};

/** Classifies each identity photo's pose via one Gemini text call — see
 *  this module's doc comment. Falls back to a deterministic round-robin
 *  (never throws) when GEMINI_API_KEY is unset or the call/parse fails,
 *  so a missing key degrades pose selection quality rather than breaking
 *  the build. */
export const classifyPoses = async (identityImages: string[]): Promise<PoseTag[]> => {
  if (identityImages.length === 0) return [];
  if (!process.env.GEMINI_API_KEY) return fallbackPoseTags(identityImages.length);
  try {
    const text = await generateText(classifyPrompt(identityImages.length), identityImages);
    return parsePoseTags(text, identityImages.length) ?? fallbackPoseTags(identityImages.length);
  } catch (err) {
    console.warn(`identityPrep: pose classification failed, using fallback ordering — ${(err as Error).message}`);
    return fallbackPoseTags(identityImages.length);
  }
};

/** Picks the identity photo best matching `poseTag`, preferring an exact
 *  tag match; falls back to `seed % n` over the whole set when no photo
 *  has that tag (or no tag was requested) — same "always returns SOME
 *  photo" contract the old seed-only selection had. */
export const pickByPose = (
  images: string[],
  tags: PoseTag[],
  poseTag: PoseTag | undefined,
  seed: number,
): string => {
  if (images.length === 0) throw new Error("pickByPose: no identity images available");
  if (poseTag) {
    const matches = images.filter((_, i) => tags[i] === poseTag);
    if (matches.length > 0) return matches[seed % matches.length];
  }
  return images[seed % images.length];
};
