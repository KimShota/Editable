import "server-only";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../../pipeline/paths";
import { LIBRARY_CATEGORIES, LibraryAsset, LibraryCategory } from "./library-shared";

/**
 * The user's reusable-asset library: SFX, memes/images, gifs, screen
 * recordings, and music they drop into format slots over and over. Lives
 * at library/<category>/, sibling to jobs/ and formats/ — same
 * filesystem-as-store approach as the rest of the app.
 */

export { LIBRARY_CATEGORIES, isLibraryCategory } from "./library-shared";
export type { LibraryAsset, LibraryCategory } from "./library-shared";

export const libraryDir = (category: LibraryCategory): string =>
  path.join(repoRoot, "library", category);

const isValidFilename = (name: string): boolean =>
  /^[a-zA-Z0-9._-]+$/.test(name) && !name.startsWith(".");

export const listLibraryAssets = (category?: LibraryCategory): LibraryAsset[] => {
  const categories = category ? [category] : LIBRARY_CATEGORIES.map((c) => c.id);
  return categories.flatMap((cat) => {
    const dir = libraryDir(cat);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(isValidFilename)
      .map((filename): LibraryAsset => {
        const stat = fs.statSync(path.join(dir, filename));
        return {
          category: cat,
          filename,
          mediaUrl: `/api/media/library/${cat}/${filename}`,
          sizeBytes: stat.size,
          updatedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
};

/** Writes a file into the category, de-duping filenames by suffixing -2, -3, ... */
export const saveLibraryAsset = (
  category: LibraryCategory,
  filename: string,
  data: Buffer,
): LibraryAsset => {
  const dir = libraryDir(category);
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
    mediaUrl: `/api/media/library/${category}/${finalName}`,
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
};

export const deleteLibraryAsset = (category: LibraryCategory, filename: string): void => {
  if (!isValidFilename(filename)) throw new Error(`invalid filename "${filename}"`);
  const filePath = path.join(libraryDir(category), filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
};
