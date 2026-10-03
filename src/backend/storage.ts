import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./pipeline/paths";

/**
 * The one place media bytes are read and written by the creator-brand-memory
 * code (creator-brand-memory plan, section 5: "every stage reads and writes
 * through it"). Phase 1 backs it with local disk; Phase 2 swaps in an
 * S3-compatible driver (R2 or Hetzner object storage) behind the SAME
 * interface, so no caller changes.
 *
 * Callers hold KEYS ("videos/ab/abcd….mp4"), never filesystem paths. The
 * one thing a caller needs a real path for is running ffmpeg on a file, and
 * that is what `localPath` is for: the local driver returns the file
 * in place, a remote driver would download it to a cache and return that.
 *
 * Existing pipeline stages (jobs/, artifacts/, authoring/) still use their
 * own paths — they migrate onto this as they are touched, not in one sweep.
 */

export type StoredObject = { key: string; bytes: number; sha256: string };

export interface Storage {
  readonly driver: string;
  putFile(key: string, sourcePath: string): Promise<StoredObject>;
  putBuffer(key: string, data: Buffer): Promise<StoredObject>;
  /** A path ffmpeg (or anything else that needs a real file) can read. Do
   *  NOT write to it — it may be the stored object itself. */
  localPath(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  /** Removing a missing key is not an error. */
  remove(key: string): Promise<void>;
  /** Keys under `prefix`, sorted. */
  list(prefix: string): Promise<string[]>;
  /** A URL a browser can fetch directly, or null when the driver has none
   *  (local disk — media is served through an authenticated app route). */
  publicUrl(key: string): string | null;
}

const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_KEY_LENGTH = 512;

/** Keys are POSIX-style relative paths of safe segments. This is the path
 *  traversal defence for the local driver, and it keeps keys portable to an
 *  object store (which has no notion of ".."). Throws on anything else. */
export const assertValidKey = (key: string): void => {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new Error(`storage: invalid key (length ${typeof key === "string" ? key.length : "n/a"})`);
  }
  for (const segment of key.split("/")) {
    // Rejects "", ".", "..", a leading "/" (empty first segment), and any
    // segment starting with "." or containing a backslash/NUL/space.
    if (!KEY_SEGMENT.test(segment)) {
      throw new Error(`storage: invalid key "${key}"`);
    }
  }
};

const sha256OfFile = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

/** Streaming sha256 of a local file — the analysis cache key
 *  (videos.content_hash), so the same bytes are analyzed once. */
export const hashFile = sha256OfFile;

/** Key for a video's media, sharded by hash prefix so no one directory
 *  grows to hundreds of thousands of entries. */
export const videoKey = (contentHash: string, ext: string): string => {
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error("storage: videoKey needs a sha256 hex hash");
  if (!/^[a-z0-9]{1,8}$/.test(cleanExt)) throw new Error(`storage: bad extension "${ext}"`);
  return `videos/${contentHash.slice(0, 2)}/${contentHash}.${cleanExt}`;
};

export class LocalStorage implements Storage {
  readonly driver = "local";

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertValidKey(key);
    return path.join(this.root, ...key.split("/"));
  }

  async putFile(key: string, sourcePath: string): Promise<StoredObject> {
    const dest = this.resolve(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Copy to a temp name and rename, so a reader (or a crash mid-copy)
    // never sees a half-written object under its final key.
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.copyFileSync(sourcePath, tmp);
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { key, bytes: fs.statSync(dest).size, sha256: await sha256OfFile(dest) };
  }

  async putBuffer(key: string, data: Buffer): Promise<StoredObject> {
    const dest = this.resolve(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { key, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }

  async localPath(key: string): Promise<string> {
    const p = this.resolve(key);
    if (!fs.existsSync(p)) throw new Error(`storage: no object at key "${key}"`);
    return p;
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.resolve(key));
  }

  async remove(key: string): Promise<void> {
    fs.rmSync(this.resolve(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    // The prefix is a directory-style key ("videos/ab"), validated the same
    // way; an empty prefix lists everything.
    const base = prefix === "" ? this.root : this.resolve(prefix.replace(/\/$/, ""));
    if (!fs.existsSync(base)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (!entry.name.endsWith(".tmp")) out.push(path.relative(this.root, full).split(path.sep).join("/"));
      }
    };
    walk(base);
    return out.sort();
  }

  publicUrl(): string | null {
    return null;
  }
}

/** Where local objects live: STORAGE_ROOT, or `storage/` in the repo. */
export const storageRoot = (): string => path.resolve(process.env.STORAGE_ROOT || path.join(repoRoot, "storage"));

let cached: Storage | undefined;

/** The process-wide storage. STORAGE_DRIVER selects the backend ("local" is
 *  the only one built); STORAGE_ROOT overrides where local objects live. */
export const getStorage = (): Storage => {
  if (cached) return cached;
  const driver = process.env.STORAGE_DRIVER || "local";
  if (driver !== "local") {
    throw new Error(`storage: unknown STORAGE_DRIVER "${driver}" — only "local" is implemented (Phase 1)`);
  }
  cached = new LocalStorage(storageRoot());
  return cached;
};
