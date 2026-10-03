import type { QueryFn } from "../../app/lib/db";

/**
 * Who belongs to a brand's workspace, and how someone joins
 * (plan/ui-ux-full-flow.md §8, Admin > Brands). No roles in v1: every member
 * can do everything.
 *
 * An invitation to an address with a verified account adds that account at
 * once. Anything else (no account yet, or an account whose email is not
 * verified) is kept as a pending invitation and claimed when the address is
 * verified, because only then is it proven to belong to the person joining.
 */

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export type InviteResult = { status: "added" | "already_member" | "invited"; email: string };

export const inviteToWorkspace = async (query: QueryFn, workspaceId: string, email: string, invitedBy?: string | null): Promise<InviteResult> => {
  const emailNorm = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) throw new Error(`"${email}" is not an email address`);

  // Admins are not email-verified (they are made by tool), so an admin counts as proven.
  const users = await query(`select id from users where email_norm = $1 and (email_verified_at is not null or is_admin)`, [emailNorm]);
  if (users.length > 0) {
    const inserted = await query(`insert into workspace_members (workspace_id, user_id) values ($1, $2) on conflict do nothing returning user_id`, [workspaceId, users[0].id]);
    return { status: inserted.length > 0 ? "added" : "already_member", email: emailNorm };
  }
  await query(`insert into workspace_invites (workspace_id, email_norm, invited_by) values ($1, $2, $3) on conflict do nothing`, [workspaceId, emailNorm, invitedBy ?? null]);
  return { status: "invited", email: emailNorm };
};

/** Turns a user's pending invitations into memberships. Call it when their
 *  email has just been verified. Returns how many workspaces they joined. */
export const claimInvites = async (query: QueryFn, userId: string): Promise<number> => {
  const rows = await query(
    `with mine as (
       delete from workspace_invites i using users u
        where u.id = $1 and i.email_norm = u.email_norm and (u.email_verified_at is not null or u.is_admin)
        returning i.workspace_id
     )
     insert into workspace_members (workspace_id, user_id)
       select workspace_id, $1 from mine
       on conflict do nothing
       returning workspace_id`,
    [userId],
  );
  return rows.length;
};

export const listPendingInvites = async (query: QueryFn, workspaceId: string): Promise<{ email: string; invitedAt: string }[]> =>
  (await query(`select email_norm, created_at from workspace_invites where workspace_id = $1 order by created_at`, [workspaceId])).map((r) => ({
    email: String(r.email_norm),
    invitedAt: new Date(String(r.created_at)).toISOString(),
  }));

export const cancelInvite = async (query: QueryFn, workspaceId: string, email: string): Promise<boolean> =>
  (await query(`delete from workspace_invites where workspace_id = $1 and email_norm = $2 returning email_norm`, [workspaceId, normalizeEmail(email)])).length > 0;
