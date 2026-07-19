import { notFound } from "next/navigation";
import { formatExists, getFormatSummary } from "../../lib/formats";
import { loadFormat } from "../../../pipeline/loader";
import { Container, Pill } from "../../_components/ui";
import { StartButton } from "./_components/StartButton";

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ formatId: string }>;
}) {
  const { formatId } = await params;
  if (!formatExists(formatId)) notFound();

  const summary = getFormatSummary(formatId);
  const format = loadFormat(formatId);

  return (
    <Container className="max-w-[1100px]">
      <a href="/templates" className="text-sm text-[color:var(--ink-dim)] hover:text-[color:var(--ink)]">
        ← All templates
      </a>

      <div className="mt-6 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,380px)_1fr]">
        <div>
          <div className="sticky top-24">
            <div className="overflow-hidden rounded-2xl border border-[color:var(--card-border)] bg-black/40">
              {summary.exampleVideoUrl ? (
                <video
                  src={summary.exampleVideoUrl}
                  controls
                  loop
                  className="aspect-[9/16] w-full bg-black"
                />
              ) : (
                <div className="flex aspect-[9/16] w-full flex-col items-center justify-center gap-2 px-6 text-center text-[color:var(--ink-dim)]">
                  <p className="font-[family-name:var(--font-display)] text-sm">No example render yet</p>
                  <p className="text-xs">Be the first to fill this one in.</p>
                </div>
              )}
            </div>
            <div className="mt-5">
              <StartButton formatId={format.id} />
            </div>
          </div>
        </div>

        <div>
          <div className="mb-3 flex flex-wrap gap-2">
            <Pill tone="accent">{summary.niche}</Pill>
            <Pill>{summary.requiredSlots.length} required slots</Pill>
            {summary.optionalSlotCount > 0 && <Pill>{summary.optionalSlotCount} optional</Pill>}
            <Pill>~{summary.estimatedMinutes} min to film</Pill>
          </div>
          <h1 className="font-[family-name:var(--font-display)] text-4xl font-bold text-[color:var(--ink)]">
            {format.name}
          </h1>
          <p className="mt-4 max-w-2xl text-[color:var(--ink-dim)]">{format.description}</p>

          <h2 className="mt-10 mb-4 font-[family-name:var(--font-display)] text-sm tracking-[0.2em] text-[color:var(--accent)] uppercase">
            What you'll film
          </h2>
          <div className="flex flex-col gap-4">
            {format.blocks.map((block) => (
              <div key={block.id} className="rounded-xl border border-[color:var(--card-border)] p-5">
                <div className="mb-3 flex items-center gap-2">
                  <h3 className="font-[family-name:var(--font-display)] font-bold text-[color:var(--ink)]">
                    {block.title}
                  </h3>
                  <Pill>{block.kind === "voice" ? "spoken" : "b-roll"}</Pill>
                </div>
                <div className="flex flex-col gap-3">
                  {block.slots.map((slot) => (
                    <div key={slot.name} className="flex gap-3 text-sm">
                      <span
                        className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                          slot.required ? "bg-[color:var(--accent)]" : "bg-white/20"
                        }`}
                      />
                      <div>
                        <p className="text-[color:var(--ink)]">
                          <span className="font-medium">{slot.name}</span>{" "}
                          <span className="text-[color:var(--ink-dim)]">
                            ({slot.mediaType}
                            {!slot.required ? ", optional" : ""})
                          </span>
                        </p>
                        <p className="text-[color:var(--ink-dim)]">{slot.instructions}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Container>
  );
}
