import { Container, PageHeader } from "../_components/ui";
import { LibraryPanel } from "../_components/library/LibraryPanel";

export default function LibraryPage() {
  return (
    <Container className="max-w-[1400px]">
      <PageHeader
        kicker="Your assets"
        title="Library"
        subtitle="Sound effects, memes, gifs, screen recordings, music — the stuff you reuse across every video. Drag any of it straight into a slot from the resources page."
      />
      <div className="min-h-[600px] overflow-hidden rounded-2xl border border-[color:var(--card-border)] bg-[color:var(--card)]">
        <LibraryPanel variant="page" />
      </div>
    </Container>
  );
}
