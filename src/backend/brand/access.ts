import type { QueryFn } from "../../app/lib/db";

/**
 * Who may see which brand, as plain SQL over `brands`, `workspace_members`
 * and `users` (plan/ui-ux-full-flow.md §2.1). Shared by `BrandRepo` (pages
 * and API routes) and the request proxy (media and the editor's job
 * routes), so there is one definition of "may open this brand".
 *
 * Only brands linked to files (a slug) are visible. An admin sees them all.
 */

export type Viewer = { id: string; isAdmin: boolean };

export type BrandRef = { brandId: string; slug: string; name: string; workspaceId: string };

const toBrandRef = (row: Record<string, unknown>): BrandRef => ({
  brandId: String(row.id),
  slug: String(row.slug),
  name: String(row.name),
  workspaceId: String(row.workspace_id),
});

/** The brands a viewer may open, oldest first. */
export const listBrandsForViewer = async (query: QueryFn, viewer: Viewer): Promise<BrandRef[]> => {
  const rows = viewer.isAdmin
    ? await query(`select id, slug, name, workspace_id from brands where slug is not null order by created_at, id`)
    : await query(
        `select b.id, b.slug, b.name, b.workspace_id
           from brands b join workspace_members m on m.workspace_id = b.workspace_id
          where m.user_id = $1 and b.slug is not null
          order by b.created_at, b.id`,
        [viewer.id],
      );
  return rows.map(toBrandRef);
};

/** The brand if the viewer may open it, else null (a missing brand and a
 *  forbidden one are indistinguishable, so a slug can't be probed). */
export const findBrandForViewer = async (query: QueryFn, viewer: Viewer, slug: string): Promise<BrandRef | null> => {
  const rows = viewer.isAdmin
    ? await query(`select id, slug, name, workspace_id from brands where slug = $1`, [slug])
    : await query(
        `select b.id, b.slug, b.name, b.workspace_id
           from brands b join workspace_members m on m.workspace_id = b.workspace_id
          where b.slug = $1 and m.user_id = $2`,
        [slug, viewer.id],
      );
  return rows.length > 0 ? toBrandRef(rows[0]) : null;
};

/** The linked brand a video job id belongs to (`<slug>-<cardId>`), by the
 *  longest slug that prefixes it, or null. */
export const brandSlugForVideoJob = async (query: QueryFn, jobId: string): Promise<string | null> => {
  const rows = await query(
    `select slug from brands where slug is not null and $1 like slug || '-%' order by length(slug) desc limit 1`,
    [jobId],
  );
  return rows.length > 0 ? String(rows[0].slug) : null;
};
