import { listProjects } from "../lib/projects";
import { Container } from "../_components/ui";
import { ProjectGrid } from "./_components/ProjectGrid";

// Mutations (rename/trash/restore/delete) happen via API routes and the
// client re-triggers a server render after each one (see ProjectGrid) —
// force-dynamic keeps this page reading jobs/ fresh every time rather than
// letting Next statically shell a snapshot of the list.
export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  const projects = listProjects();
  return (
    <Container className="max-w-[1500px]">
      <ProjectGrid projects={projects} />
    </Container>
  );
}
