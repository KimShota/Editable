import { listProjects } from "../lib/projects";
import { getRequestUser } from "../lib/auth";
import { Container } from "../_components/ui";
import { ProjectGrid } from "./_components/ProjectGrid";

// Mutations (rename/trash/restore/delete) happen via API routes and the
// client re-triggers a server render after each one (see ProjectGrid) —
// force-dynamic keeps this page reading jobs/ fresh every time rather than
// letting Next statically shell a snapshot of the list.
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  // middleware.ts already requires a session for every non-public route
  // (this one included), so a null user here would mean this page somehow
  // rendered without middleware having run — nothing left to show.
  const user = await getRequestUser();
  const projects = user ? await listProjects(user) : [];
  return (
    <Container className="max-w-[1500px]">
      <ProjectGrid projects={projects} />
    </Container>
  );
}
