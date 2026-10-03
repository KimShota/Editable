/**
 * What a customer may upload as a product asset or a logo. The type is
 * decided by looking at the file's first bytes, never by its name or the
 * browser's claim, and the kind of upload decides what is allowed (a logo or
 * photo is an image; a screen recording is a video).
 */

export type AssetKind = "photo" | "screenshot" | "screen_recording" | "logo";
export const ASSET_KINDS: readonly AssetKind[] = ["photo", "screenshot", "screen_recording", "logo"];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 150 * 1024 * 1024;

export type Sniffed = { mime: string; ext: string; family: "image" | "video" };

const startsWith = (b: Uint8Array, bytes: number[], at = 0): boolean => bytes.every((v, i) => b[at + i] === v);

/** The real type of a file from its leading bytes, or null if it is not one we accept. */
export const sniff = (head: Uint8Array): Sniffed | null => {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png", family: "image" };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg", family: "image" };
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return { mime: "image/gif", ext: "gif", family: "image" };
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return { mime: "image/webp", ext: "webp", family: "image" };
  if (startsWith(head, [0x66, 0x74, 0x79, 0x70], 4)) return { mime: "video/mp4", ext: "mp4", family: "video" }; // "ftyp": mp4 and mov
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "video/webm", ext: "webm", family: "video" };
  return null;
};

export class UploadError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
    this.name = "UploadError";
  }
}

/** Checks one upload and says what to store it as. Throws UploadError with
 *  a message a person can act on. */
export const checkUpload = (kind: string, size: number, head: Uint8Array): { sniffed: Sniffed; kind: AssetKind } => {
  if (!ASSET_KINDS.includes(kind as AssetKind)) throw new UploadError("Say what this is: a photo, a screenshot, a screen recording or a logo.");
  if (size === 0) throw new UploadError("That file is empty.");
  const sniffed = sniff(head);
  if (!sniffed) throw new UploadError("That file type is not supported. Use a PNG, JPEG, WebP or GIF picture, or an MP4 or WebM recording.");
  const wantsVideo = kind === "screen_recording";
  if (wantsVideo && sniffed.family !== "video") throw new UploadError("A screen recording must be a video (MP4 or WebM).");
  if (!wantsVideo && sniffed.family !== "image") throw new UploadError(kind === "logo" ? "A logo must be a picture (PNG, JPEG, WebP or GIF)." : "That should be a picture, not a video. Choose 'screen recording' for videos.");
  const max = sniffed.family === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (size > max) throw new UploadError(`That file is too large. The most is ${Math.round(max / 1024 / 1024)} MB.`, 413);
  return { sniffed, kind: kind as AssetKind };
};
