import { notFound } from "next/navigation";
import { draftExists } from "../../lib/authoring";
import { Container, PageHeader } from "../../_components/ui";
import { DraftReview } from "./_components/DraftReview";

export default async function AuthoringDraftPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  if (!draftExists(draftId)) notFound();

  return (
    <Container className="max-w-4xl">
      <PageHeader
        kicker="Review draft"
        title="Check the structure before it joins the library."
        subtitle="Everything here was inferred from the reference reel — filming instructions, timing, and overlays. Read it over, adjust anything that's off, then save it."
      />
      <DraftReview draftId={draftId} />
    </Container>
  );
}
