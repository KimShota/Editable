import { notFound } from "next/navigation";
import {
  jobExists,
  jobHookFeedbackExists,
  jobScriptExists,
  readJobHookFeedback,
  readJobManifest,
  readJobScript,
} from "../../../lib/jobs";
import { loadFormat } from "@backend/pipeline/loader";
import { Container, PageHeader } from "../../../_components/ui";
import { ResourcesBoard } from "./_components/ResourcesBoard";

export default async function ResourcesPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) notFound();

  const manifest = readJobManifest(jobId);
  const format = loadFormat(manifest.format);

  return (
    <Container className="max-w-[1500px]">
      <PageHeader
        kicker={format.name}
        title="Throw in your resources"
        subtitle="Film what each labeled slot asks for, then drop it in. Frequently-used sounds and memes? Drag them straight from your Library on the right."
      />
      <ResourcesBoard
        jobId={jobId}
        format={format}
        initialBindings={manifest.bindings}
        initialScript={jobScriptExists(jobId) ? readJobScript(jobId) : null}
        initialHookFeedback={jobHookFeedbackExists(jobId) ? readJobHookFeedback(jobId) : null}
      />
    </Container>
  );
}
