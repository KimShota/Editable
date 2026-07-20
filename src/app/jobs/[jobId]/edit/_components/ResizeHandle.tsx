"use client";

/**
 * A thin draggable divider between two panels. Reports the incremental
 * pixel delta of each pointer move — the parent owns the actual size
 * state and decides how to clamp/apply it, this just turns a drag into a
 * stream of deltas.
 */
export function ResizeHandle({
  orientation,
  onResize,
}: {
  orientation: "vertical" | "horizontal";
  onResize: (deltaPx: number) => void;
}) {
  const axisPos = (e: React.PointerEvent<HTMLDivElement>) =>
    orientation === "vertical" ? e.clientX : e.clientY;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.dataset.lastPos = String(axisPos(e));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.dataset.lastPos === undefined) return;
    const pos = axisPos(e);
    onResize(pos - Number(el.dataset.lastPos));
    el.dataset.lastPos = String(pos);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    delete e.currentTarget.dataset.lastPos;
  };

  // The handle owns the whole gutter between two panels (not just a
  // hairline) so it reads as intentional negative space — a small nub
  // brightens on hover/drag, the rest of the gutter stays invisible.
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={
        orientation === "vertical"
          ? "group flex w-2.5 shrink-0 cursor-col-resize items-center justify-center"
          : "group flex h-2.5 shrink-0 cursor-row-resize items-center justify-center"
      }
    >
      <div
        className={
          orientation === "vertical"
            ? "h-8 w-[3px] rounded-full bg-[color:var(--ed-border-strong)] transition-colors group-hover:bg-[color:var(--ed-accent)] group-active:bg-[color:var(--ed-accent)]"
            : "h-[3px] w-8 rounded-full bg-[color:var(--ed-border-strong)] transition-colors group-hover:bg-[color:var(--ed-accent)] group-active:bg-[color:var(--ed-accent)]"
        }
      />
    </div>
  );
}
