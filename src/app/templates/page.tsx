import { listFormatSummaries } from "../lib/formats";
import { Container, PageHeader } from "../_components/ui";
import { AnimatedTitle } from "./_components/AnimatedTitle";
import { TemplateGallery } from "./_components/TemplateGallery";

export default function TemplatesPage() {
  const formats = listFormatSummaries();

  return (
    <Container>
      <PageHeader
        title={<AnimatedTitle text="Pick your niche and viral format" />}
        subtitle="Proven structures, broken into labeled slots. Pick one for your niche, film what it asks for, get an assembled video out."
      />
      <TemplateGallery formats={formats} />
    </Container>
  );
}
