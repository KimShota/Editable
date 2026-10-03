import "server-only";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { BrandRef } from "@backend/brand/access";
import { brandRepo } from "./brandRepo";
import type { SessionUser } from "./session";

/**
 * Which brand the signed-in user is looking at. URLs carry no brand slug
 * (plan/ui-ux-full-flow.md §2.5): the choice is the `katalab_brand` cookie,
 * set by the sidebar's brand switcher through POST /api/active-brand. The
 * cookie is only a preference: it is checked against the user's brands on
 * every request, so a stale or forged value falls back to their first brand.
 */
export const ACTIVE_BRAND_COOKIE = "katalab_brand";

export type ActiveBrand = { active: BrandRef | null; all: BrandRef[] };

export const getActiveBrand = async (user: Pick<SessionUser, "id" | "isAdmin">): Promise<ActiveBrand> => {
  const all = await brandRepo.listBrandsForUser(user);
  const wanted = (await cookies()).get(ACTIVE_BRAND_COOKIE)?.value;
  return { active: all.find((b) => b.slug === wanted) ?? all[0] ?? null, all };
};

/** For a page that cannot render without a brand: the active one, or a 404
 *  (the user has no brand yet, or none that exists). */
export const requireActiveBrand = async (user: Pick<SessionUser, "id" | "isAdmin">): Promise<BrandRef> => {
  const { active } = await getActiveBrand(user);
  if (!active) notFound();
  return active;
};
