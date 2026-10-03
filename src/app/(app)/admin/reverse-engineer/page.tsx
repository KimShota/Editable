import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getRequestUser } from "../../../lib/auth";
import { Container, PageHeader } from "../../../_components/ui";
import { AdminTabs } from "../_components/AdminTabs";
import { NewDraftForm } from "./_components/NewDraftForm";

export const metadata: Metadata = { title: "Reverse-engineer · Katalab" };

/** The format-authoring tool (the old template product), kept for the
 *  founder, now under Admin. */
export default async function AdminReverseEngineerPage() {
  const user = await getRequestUser();
  if (!user?.isAdmin) notFound();
  return (
    <Container className="max-w-3xl">
      <PageHeader kicker="Reverse-engineer" title="Paste a link to a viral reel." subtitle="We'll download it, transcribe it, sample its frames, and reverse-engineer the structure into a draft format you can review before it joins the library." />
      <AdminTabs />
      <NewDraftForm />
    </Container>
  );
}
