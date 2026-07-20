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

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={
        orientation === "vertical"
          ? "w-1 shrink-0 cursor-col-resize bg-white/6 hover:bg-[color:var(--accent)]/60 active:bg-[color:var(--accent)]"
          : "h-1 shrink-0 cursor-row-resize bg-white/6 hover:bg-[color:var(--accent)]/60 active:bg-[color:var(--accent)]"
      }
    />
  );
}
