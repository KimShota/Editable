/**
 * Library constants/types shared by server code (src/app/lib/library.ts)
 * AND client components — kept free of "server-only"/node:fs imports so
 * client bundles can import LIBRARY_CATEGORIES without pulling in
 * filesystem code.
 */

export const LIBRARY_CATEGORIES = [
  { id: "sfx", label: "Sound effects" },
  { id: "images", label: "Images & memes" },
  { id: "gifs", label: "Gifs" },
  { id: "screen-recordings", label: "Screen recordings" },
  { id: "music", label: "Music" },
] as const;

export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number]["id"];

export const isLibraryCategory = (value: string): value is LibraryCategory =>
  LIBRARY_CATEGORIES.some((c) => c.id === value);

export type LibraryAsset = {
  category: LibraryCategory;
  filename: string;
  mediaUrl: string;
  sizeBytes: number;
  updatedAt: string;
};
