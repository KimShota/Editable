import { notFound } from "next/navigation";
import { Container, PageHeader } from "../../../_components/ui";
import { TaskProgressDemo } from "./TaskProgressDemo";

/**
 * A harness for <TaskProgress>, used by the browser tests: it renders the
 * component for a task id (`?task=<id>`) or a scripted replay (`?replay=1`)
 * and reports what the component did. It exists only when
 * KATALAB_STUB_PROVIDERS=1 (the test environment) and 404s everywhere else.
 */
export default async function TaskProgressDevPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  if (process.env.KATALAB_STUB_PROVIDERS !== "1") notFound();
  const sp = await searchParams;
  const task = typeof sp.task === "string" ? Number(sp.task) : undefined;
  return (
    <Container>
      <PageHeader title="Task progress" subtitle="Test harness" />
      <TaskProgressDemo taskId={Number.isSafeInteger(task) ? task : undefined} replay={sp.replay === "1"} />
    </Container>
  );
}
