import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeFile } from "../pipeline/intake";
import { authoringDir } from "../pipeline/paths";
import { IngestResult } from "./types";

/**
 * Module A1 — Ingest.
 * Gets a reference reel (from a URL via yt-dlp, or a local file already on
 * disk) into a fresh authoring/<draftId>/ working directory, then probes
 * it with the same ffprobe-backed probeFile() the real intake stage uses,
 * so a bad/silent/non-video source fails here with a clear message instead
 * of confusing whisper or ffmpeg two stages downstream.
 */

export const newDraftId = (): string => `draft-${randomBytes(4).toString("hex")}`;

const validateSourceProbe = (sourcePath: string, label: string) => {
  const probed = probeFile(sourcePath);
  if (probed.mediaType !== "video") {
    throw new Error(`ingest: "${label}" is not a video (probed as ${probed.mediaType})`);
  }
  if (!probed.durationSec || !probed.width || !probed.height) {
    throw new Error(`ingest: could not read duration/dimensions from "${label}"`);
  }
  if (probed.hasAudio === false) {
    throw new Error(`ingest: "${label}" has no audio track — can't transcribe a silent reel`);
  }
  return probed;
};

export const ingestFromUrl = (url: string, draftId: string = newDraftId()): IngestResult => {
  const dir = authoringDir(draftId);
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, "source.mp4");
  if (fs.existsSync(sourcePath)) fs.rmSync(sourcePath);

  // Instagram increasingly gates anonymous access (login wall or an empty
  // media response) — EDITABLE_YTDLP_COOKIES_BROWSER (e.g. "chrome") reads
  // that browser's own logged-in session cookies locally via yt-dlp's
  // --cookies-from-browser, same as a human would from their own machine.
  // Nothing is sent anywhere except to Instagram itself.
  const cookiesBrowser = process.env.EDITABLE_YTDLP_COOKIES_BROWSER;
  const ytDlpArgs = ["-f", "mp4/best", "--no-playlist", "--merge-output-format", "mp4"];
  if (cookiesBrowser) ytDlpArgs.push("--cookies-from-browser", cookiesBrowser);
  ytDlpArgs.push("-o", sourcePath, url);

  try {
    // Single mp4 stream preferred (avoids a separate video+audio merge);
    // yt-dlp falls back to "best" and remuxes via ffmpeg if the source
    // isn't already a single mp4 track.
    execFileSync("yt-dlp", ytDlpArgs, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().slice(-2000);
    const loginHint =
      !cookiesBrowser && /login|rate.limit|not available/i.test(stderr ?? "")
        ? "\n(this looks like a login wall — set EDITABLE_YTDLP_COOKIES_BROWSER=chrome (or firefox/safari/edge) " +
          "to reuse that browser's logged-in Instagram session, or download the reel yourself and pass --file)"
        : "";
    throw new Error(
      `ingest: yt-dlp failed to download "${url}"${stderr ? `:\n${stderr}` : ` (${(err as Error).message})`}${loginHint}`,
    );
  }

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`ingest: yt-dlp reported success but no file was written to ${sourcePath}`);
  }

  const probed = validateSourceProbe(sourcePath, url);
  return {
    draftId,
    sourcePath,
    sourceUrl: url,
    durationSec: probed.durationSec!,
    width: probed.width!,
    height: probed.height!,
  };
};

/**
 * Same as ingestFromUrl but for a reel already downloaded to disk (a
 * screen-recording, or a manual browser download) — the fallback path
 * when a link hits a login wall yt-dlp can't get past even with cookies,
 * or when the reference simply isn't on a URL at all. Remuxes into mp4
 * (matching yt-dlp's own output shape) so every downstream stage sees one
 * consistent container regardless of how the reel arrived.
 */
export const ingestFromFile = (filePath: string, draftId: string = newDraftId()): IngestResult => {
  const dir = authoringDir(draftId);
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, "source.mp4");
  if (fs.existsSync(sourcePath)) fs.rmSync(sourcePath);

  const absInput = path.resolve(filePath);
  if (!fs.existsSync(absInput)) {
    throw new Error(`ingest: no file at "${absInput}"`);
  }

  if (path.extname(absInput).toLowerCase() === ".mp4") {
    fs.copyFileSync(absInput, sourcePath);
  } else {
    try {
      // Try a stream copy first (fast, lossless) — fails when the source
      // codec can't be held by an mp4 container as-is.
      execFileSync("ffmpeg", ["-y", "-i", absInput, "-c", "copy", sourcePath], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      execFileSync("ffmpeg", ["-y", "-i", absInput, sourcePath], { stdio: ["ignore", "ignore", "pipe"] });
    }
  }

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`ingest: failed to stage "${filePath}" to ${sourcePath}`);
  }

  const probed = validateSourceProbe(sourcePath, filePath);
  return {
    draftId,
    sourcePath,
    // Not a real URL — flagged with the file:// scheme so downstream
    // consumers (e.g. formats/meta/reels.json registration) can tell a
    // local ingest apart from a real reel link without a separate field.
    sourceUrl: `file://${absInput}`,
    durationSec: probed.durationSec!,
    width: probed.width!,
    height: probed.height!,
  };
};
