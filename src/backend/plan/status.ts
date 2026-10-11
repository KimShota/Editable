import type { Actor, Card, CardStatus } from "./schemas";

/**
 * Every status change of a plan card goes through `transitionCard`
 * (plan/ui-ux-full-flow.md §2.3). It holds the allowed edges and who may take
 * each one, so a route handler never decides that on its own. There is one
 * kind of person: whoever is signed in can take every human edge; only the
 * worker can start or fail a run.
 *
 *   draft ─approve─▶ approved ─make─▶ queued ─▶ generating ─▶ ready ─▶ posted
 *     ▲                 │                              │
 *     └── unapprove ────┘                           failed
 *
 * `approved` is "said yes, not made yet"; `queued` is "the person pressed
 * Make this video (which spends money), waiting for a worker".
 */

const USER: readonly Actor[] = ["user"];
const SYSTEM: readonly Actor[] = ["system"];

type Edge = { from: CardStatus; to: CardStatus; by: readonly Actor[] };

const EDGES: readonly Edge[] = [
  { from: "draft", to: "approved", by: USER },
  { from: "approved", to: "draft", by: USER },
  { from: "approved", to: "queued", by: USER },
  { from: "queued", to: "generating", by: SYSTEM },
  { from: "queued", to: "failed", by: SYSTEM },
  { from: "generating", to: "ready", by: SYSTEM },
  { from: "generating", to: "failed", by: SYSTEM },
  // A failed run can be made again, or put back to approved.
  { from: "failed", to: "approved", by: USER },
  { from: "failed", to: "queued", by: USER },
  { from: "ready", to: "posted", by: USER },
  { from: "posted", to: "ready", by: USER },
  // The post-time scheduler (Phase 2/M3) marks a day that passed unapproved.
  { from: "draft", to: "skipped", by: SYSTEM },
  { from: "approved", to: "skipped", by: SYSTEM },
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
 *  approved: after that it may already be paying to generate. */
export const isEditable = (status: CardStatus): boolean => status === "draft";

export type StatusLabel = { key: StatusKey; label: string };
export type StatusKey = "draft" | "queued" | "working" | "ready" | "posted" | "bad";

/** What a status is called to the person looking at it. */
export const statusLabel = (status: CardStatus): StatusLabel => LABELS[status];

const LABELS: Record<CardStatus, StatusLabel> = {
  draft: { key: "draft", label: "Draft" },
  approved: { key: "queued", label: "Approved · ready to make" },
  queued: { key: "queued", label: "Queued" },
  generating: { key: "working", label: "Generating" },
  ready: { key: "ready", label: "Ready to post" },
  posted: { key: "posted", label: "Posted" },
  skipped: { key: "bad", label: "Skipped" },
  failed: { key: "bad", label: "Failed" },
};
