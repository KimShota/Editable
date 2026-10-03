import "server-only";
import { BrandAccessError, BrandRepo, type Viewer } from "@backend/brand/repo";
import { getStorage } from "@backend/storage";
import { query } from "./db";

/**
 * The app's one BrandRepo (plan/ui-ux-full-flow.md §2.1): the production
 * database and the local object storage. Pages and route handlers import
 * this, never the storage keys.
 */
export const brandRepo = new BrandRepo(query, getStorage());

export { BrandAccessError };
export type { Viewer };
