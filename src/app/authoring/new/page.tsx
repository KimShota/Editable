import { Container, PageHeader } from "../../_components/ui";
import { NewDraftForm } from "./_components/NewDraftForm";

export default function NewAuthoringPage() {
  return (
    <Container className="max-w-2xl">
      <PageHeader
        kicker="Create from a reel"
        title="Paste a link to a viral reel."
        subtitle="We'll download it, transcribe it, sample its frames, and reverse-engineer the structure into a draft format you can review before it joins the library."
      />
      <NewDraftForm />
    </Container>
  );
}
