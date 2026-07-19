import { listFormatSummaries } from "../lib/formats";
import { listJobs } from "../lib/jobs";
import { Container, PageHeader } from "../_components/ui";
import { TemplateGallery } from "./_components/TemplateGallery";

export default function TemplatesPage() {
  const formats = listFormatSummaries();
  const pastJobs = listJobs();

  return (
    <Container>
      <PageHeader
        kicker="Pick a format"
        title="What are you filming today?"
        subtitle="Proven structures, broken into labeled slots. Pick one for your niche, film what it asks for, get an assembled video out."
      />
      <TemplateGallery formats={formats} pastJobs={pastJobs} />
    </Container>
  );
}
