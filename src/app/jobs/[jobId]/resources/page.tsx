import { notFound } from "next/navigation";
import { Suspense } from "react";
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

// The wizard's step (?step=) is a query param the page itself never reads
// server-side (only ResourcesBoard's useSearchParams does) — without this,
// Next can statically shell the page per jobId and ignore the query
// string entirely, so every step's initial HTML (and any no-JS view)
// would show step 1 regardless of the URL until client hydration corrects
// it. Forcing dynamic rendering makes the server reflect the real step
// immediately, matching what the client shows after hydration.
export const dynamic = "force-dynamic";

export default async function ResourcesPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!jobExists(jobId)) notFound();

  const manifest = readJobManifest(jobId);
  const format = loadFormat(manifest.format);

  return (
    <Container className="max-w-[1500px]">
      <PageHeader
        kicker={format.name}
        title="Build your video"
        subtitle="Three steps: write what appears on screen, add your clips and photos, then build. Frequently-used sounds and memes? Drag them straight from your Library on the right."
      />
      <Suspense fallback={null}>
        <ResourcesBoard
          jobId={jobId}
          format={format}
          initialBindings={manifest.bindings}
          initialScript={jobScriptExists(jobId) ? readJobScript(jobId) : null}
          initialHookFeedback={jobHookFeedbackExists(jobId) ? readJobHookFeedback(jobId) : null}
        />
      </Suspense>
    </Container>
  );
}
