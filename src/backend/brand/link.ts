import type { QueryFn } from "../../app/lib/db";
import type { Storage } from "../storage";
import { readJsonIfExists } from "../storageJson";
import { type BrandIntake, BrandIntakeSchema } from "./intake/schemas";
import { assertBrandSlug, brandKeys } from "./keys";
import { createBrandFromIntake, createWorkspace } from "./store";

/**
 * Connects a brand's files (`storage/brands/<slug>/`) to the database rows
 * that say who may see them: a workspace, a brand row carrying the slug, and
 * the workspace's members (plan/ui-ux-full-flow.md §2.1).
 *
 * Idempotent: running it again finds the brand by slug and only adds the
 * members that are missing. It never changes an existing brand's data.
 */

export type LinkResult = {
  brandId: string;
  workspaceId: string;
  /** False when the slug was already linked. */
  created: boolean;
  membersAdded: string[];
  /** Emails with no account yet: they get linked when they sign up with an
   *  invite for this workspace (a later slice). */
  missingEmails: string[];
};

export const linkBrand = async (
  query: QueryFn,
  storage: Storage,
  input: { slug: string; websiteUrl?: string; workspaceName?: string; memberEmails?: string[] },
): Promise<LinkResult> => {
  const slug = assertBrandSlug(input.slug);

  let brandId: string;
  let workspaceId: string;
  let created = false;

  const existing = await query(`select id, workspace_id from brands where slug = $1`, [slug]);
  if (existing.length > 0) {
    brandId = String(existing[0].id);
    workspaceId = String(existing[0].workspace_id);
  } else {
    const raw = await readJsonIfExists(storage, brandKeys(slug).intake);
    if (raw === null) throw new Error(`no intake for ${slug} at ${brandKeys(slug).intake}: run the intake first`);
    const intake: BrandIntake = BrandIntakeSchema.parse((raw as { intake?: unknown }).intake ?? raw);
    workspaceId = await createWorkspace(query, { name: input.workspaceName ?? intake.companyName });
    ({ brandId } = await createBrandFromIntake(query, {
      workspaceId,
      websiteUrl: input.websiteUrl ?? "",
      intake,
      slug,
    }));
    created = true;
  }

  const membersAdded: string[] = [];
  const missingEmails: string[] = [];
  for (const email of input.memberEmails ?? []) {
    const users = await query(`select id from users where email_norm = $1`, [email.trim().toLowerCase()]);
    if (users.length === 0) {
      missingEmails.push(email);
      continue;
    }
    const inserted = await query(
      `insert into workspace_members (workspace_id, user_id) values ($1, $2) on conflict do nothing returning user_id`,
      [workspaceId, users[0].id],
    );
    if (inserted.length > 0) membersAdded.push(email);
  }

  return { brandId, workspaceId, created, membersAdded, missingEmails };
};
