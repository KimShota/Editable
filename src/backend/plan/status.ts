import type { Actor, Card, CardStatus } from "./schemas";

/**
 * Every status change of a plan card goes through `transitionCard`
 * (plan/ui-ux-full-flow.md §2.3). It holds the allowed edges and who may take
 * each one, so a route handler never decides that on its own.
 *
 *   draft ─approve─▶ approved ─(admin release)─▶ queued ─▶ generating ─▶ internal_review
 *     ▲                 │                                       │              │ (admin sends)
 *     └── unapprove ────┘                                    failed            ▼
 *                                                       needs_review ─approve─▶ ready ─▶ posted
 *
 * `approved` is "the customer said yes, waiting for the founder to release
 * the spend"; `queued` is "released, waiting for a worker".
 */

const CUSTOMER_OR_ADMIN: readonly Actor[] = ["customer", "admin"];
const ADMIN: readonly Actor[] = ["admin"];
const SYSTEM: readonly Actor[] = ["system"];

type Edge = { from: CardStatus; to: CardStatus; by: readonly Actor[] };

const EDGES: readonly Edge[] = [
  { from: "draft", to: "approved", by: CUSTOMER_OR_ADMIN },
  { from: "approved", to: "draft", by: CUSTOMER_OR_ADMIN },
  { from: "approved", to: "queued", by: ADMIN },
  { from: "queued", to: "generating", by: SYSTEM },
  { from: "queued", to: "failed", by: SYSTEM },
  { from: "generating", to: "internal_review", by: SYSTEM },
  { from: "generating", to: "failed", by: SYSTEM },
  // A failed run goes back to the release gate, or straight to the queue.
  { from: "failed", to: "approved", by: ADMIN },
  { from: "failed", to: "queued", by: ADMIN },
  { from: "internal_review", to: "needs_review", by: ADMIN },
  // The founder rejects a take and re-runs production.
  { from: "internal_review", to: "queued", by: ADMIN },
  { from: "needs_review", to: "ready", by: CUSTOMER_OR_ADMIN },
  // A thumbs-down sends the video back behind the review gate.
  { from: "needs_review", to: "internal_review", by: CUSTOMER_OR_ADMIN },
  { from: "ready", to: "needs_review", by: CUSTOMER_OR_ADMIN },
  { from: "ready", to: "posted", by: CUSTOMER_OR_ADMIN },
  { from: "posted", to: "ready", by: ADMIN },
  // The post-time scheduler (Phase 2/M3) marks a day that passed unapproved.
  { from: "draft", to: "skipped", by: SYSTEM },
  { from: "approved", to: "skipped", by: SYSTEM },
  { from: "needs_review", to: "skipped", by: SYSTEM },
  { from: "ready", to: "skipped", by: SYSTEM },
];

export const MAX_HISTORY = 50;

export class TransitionError extends Error {
  constructor(
    message: string,
    readonly from: CardStatus,
    readonly to: CardStatus,
    readonly actor: Actor,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

export const canTransition = (from: CardStatus, to: CardStatus, actor: Actor): boolean =>
  EDGES.some((e) => e.from === from && e.to === to && e.by.includes(actor));

/** What `actor` may do next from `from`. Drives which buttons a screen shows. */
export const allowedNext = (from: CardStatus, actor: Actor): CardStatus[] =>
  EDGES.filter((e) => e.from === from && e.by.includes(actor)).map((e) => e.to);

/** Returns the card in its new status with the change appended to its
 *  history. Throws TransitionError for an edge that is not allowed. */
export const transitionCard = (card: Card, to: CardStatus, actor: Actor, now: Date = new Date()): Card => {
  if (!canTransition(card.status, to, actor)) {
    throw new TransitionError(`a ${actor} cannot move a card from ${card.status} to ${to}`, card.status, to, actor);
  }
  const history = [...card.history, { at: now.toISOString(), from: card.status, to, by: actor }].slice(-MAX_HISTORY);
  return { ...card, status: to, history };
};

/** A card's script, storyboard and angle may be edited only before it is
 *  approved: after that the founder may already be paying to generate it. */
export const isEditable = (status: CardStatus): boolean => status === "draft";

/** What a status is called to the person looking at it. The customer never
 *  sees the internal review gate or a failed run: to them the video is
 *  still being made. */
export type StatusAudience = "customer" | "admin";

export type StatusLabel = { key: StatusKey; label: string };
export type StatusKey = "draft" | "queued" | "working" | "review" | "ready" | "posted" | "bad";

export const statusLabel = (status: CardStatus, audience: StatusAudience): StatusLabel => {
  if (audience === "admin") {
    const admin: Record<CardStatus, StatusLabel> = {
      draft: { key: "draft", label: "Draft" },
      approved: { key: "queued", label: "Approved · awaiting release" },
      queued: { key: "queued", label: "Released · queued" },
      generating: { key: "working", label: "Generating" },
      internal_review: { key: "working", label: "Internal review" },
      needs_review: { key: "review", label: "Sent to customer" },
      ready: { key: "ready", label: "Ready to post" },
      posted: { key: "posted", label: "Posted" },
      skipped: { key: "bad", label: "Skipped" },
      failed: { key: "bad", label: "Failed" },
    };
    return admin[status];
  }
  const customer: Record<CardStatus, StatusLabel> = {
    draft: { key: "draft", label: "Draft" },
    approved: { key: "queued", label: "Queued for production" },
    queued: { key: "queued", label: "Queued for production" },
    generating: { key: "working", label: "Generating" },
    internal_review: { key: "working", label: "Generating" },
    needs_review: { key: "review", label: "Needs your review" },
    ready: { key: "ready", label: "Ready to post" },
    posted: { key: "posted", label: "Posted" },
    skipped: { key: "bad", label: "Skipped" },
    failed: { key: "working", label: "Generating" },
  };
  return customer[status];
};
