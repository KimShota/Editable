import "server-only";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "@backend/pipeline/paths";
import { LIBRARY_CATEGORIES, LibraryAsset, LibraryCategory } from "./library-shared";

/**
 * Each signed-up user's reusable-asset library: SFX, memes/images, gifs,
 * screen recordings, and music they drop into format slots over and over.
 * Lives at library/<userId>/<category>/, sibling to jobs/ and formats/ —
 * same filesystem-as-store approach as the rest of the app.
 *
 * Per-user, not shared: this used to be one flat library/<category>/ tree
 * with no owner, which meant any signed-up tester could list, download,
 * and delete every other tester's uploads (the Library nav item exposed it
 * to everyone, and it wasn't a job — so middleware.ts's job-ownership
 * check never covered it). Every function below takes the CALLER's own
 * userId, sourced from getRequestUser() in every route in api/library/ —
 * never client-supplied — so no extra validation is needed on it.
 */

export { LIBRARY_CATEGORIES, isLibraryCategory } from "./library-shared";
export type { LibraryAsset, LibraryCategory } from "./library-shared";

export const libraryDir = (userId: string, category: LibraryCategory): string =>
  path.join(repoRoot, "library", userId, category);

const isValidFilename = (name: string): boolean =>
  /^[a-zA-Z0-9._-]+$/.test(name) && !name.startsWith(".");

const mediaUrlFor = (userId: string, category: LibraryCategory, filename: string): string =>
  `/api/media/library/${userId}/${category}/${filename}`;

export const listLibraryAssets = (userId: string, category?: LibraryCategory): LibraryAsset[] => {
  const categories = category ? [category] : LIBRARY_CATEGORIES.map((c) => c.id);
  return categories.flatMap((cat) => {
    const dir = libraryDir(userId, cat);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(isValidFilename)
      .map((filename): LibraryAsset => {
        const stat = fs.statSync(path.join(dir, filename));
        return {
          category: cat,
          filename,
          mediaUrl: mediaUrlFor(userId, cat, filename),
          sizeBytes: stat.size,
          updatedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
};

/** Writes a file into the user's category, de-duping filenames by suffixing -2, -3, ... */
export const saveLibraryAsset = (
  userId: string,
  category: LibraryCategory,
  filename: string,
  data: Buffer,
): LibraryAsset => {
  const dir = libraryDir(userId, category);
  fs.mkdirSync(dir, { recursive: true });

  const ext = path.extname(filename);
  const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9._-]+/g, "-") || "asset";
  let finalName = `${base}${ext}`;
  let n = 2;
  while (fs.existsSync(path.join(dir, finalName))) {
    finalName = `${base}-${n}${ext}`;
    n++;
  }

  fs.writeFileSync(path.join(dir, finalName), data);
  const stat = fs.statSync(path.join(dir, finalName));
  return {
    category,
    filename: finalName,
    mediaUrl: mediaUrlFor(userId, category, finalName),
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
};

export const deleteLibraryAsset = (userId: string, category: LibraryCategory, filename: string): void => {
  if (!isValidFilename(filename)) throw new Error(`invalid filename "${filename}"`);
  const filePath = path.join(libraryDir(userId, category), filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
};

/** Copies an asset within its category, reusing saveLibraryAsset's -2, -3, ... de-dupe. */
export const duplicateLibraryAsset = (userId: string, category: LibraryCategory, filename: string): LibraryAsset => {
  if (!isValidFilename(filename)) throw new Error(`invalid filename "${filename}"`);
  const filePath = path.join(libraryDir(userId, category), filename);
  if (!fs.existsSync(filePath)) throw new Error(`asset "${filename}" not found in ${category}`);
  return saveLibraryAsset(userId, category, filename, fs.readFileSync(filePath));
};
