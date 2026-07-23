import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeFile } from "../pipeline/intake";
import { authoringDir } from "../pipeline/paths";
import { IngestResult } from "./types";

/**
 * Module A1 — Ingest.
 * Downloads a reference reel (TikTok/Instagram/YouTube Shorts link) via
 * yt-dlp into a fresh authoring/<draftId>/ working directory, then probes
 * it with the same ffprobe-backed probeFile() the real intake stage uses,
 * so a bad/silent/non-video link fails here with a clear message instead
 * of confusing whisper or ffmpeg two stages downstream.
 */

export const newDraftId = (): string => `draft-${randomBytes(4).toString("hex")}`;

export const ingestFromUrl = (url: string, draftId: string = newDraftId()): IngestResult => {
  const dir = authoringDir(draftId);
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, "source.mp4");
  if (fs.existsSync(sourcePath)) fs.rmSync(sourcePath);

  try {
    // Single mp4 stream preferred (avoids a separate video+audio merge);
    // yt-dlp falls back to "best" and remuxes via ffmpeg if the source
    // isn't already a single mp4 track.
    execFileSync(
      "yt-dlp",
      ["-f", "mp4/best", "--no-playlist", "--merge-output-format", "mp4", "-o", sourcePath, url],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().slice(-2000);
    throw new Error(
      `ingest: yt-dlp failed to download "${url}"${stderr ? `:\n${stderr}` : ` (${(err as Error).message})`}`,
    );
  }

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`ingest: yt-dlp reported success but no file was written to ${sourcePath}`);
  }

  const probed = probeFile(sourcePath);
  if (probed.mediaType !== "video") {
    throw new Error(`ingest: downloaded file at "${url}" is not a video (probed as ${probed.mediaType})`);
  }
  if (!probed.durationSec || !probed.width || !probed.height) {
    throw new Error(`ingest: could not read duration/dimensions from the downloaded file`);
  }
  if (probed.hasAudio === false) {
    throw new Error(`ingest: "${url}" has no audio track — can't transcribe a silent reel`);
  }

  return {
    draftId,
    sourcePath,
    sourceUrl: url,
    durationSec: probed.durationSec,
    width: probed.width,
    height: probed.height,
  };
};
