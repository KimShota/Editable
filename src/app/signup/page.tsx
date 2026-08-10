import { Suspense } from "react";
import { Container, PageHeader } from "../_components/ui";
import { SignupForm } from "./_components/SignupForm";

export default function SignupPage() {
  return (
    <Container className="max-w-md">
      <PageHeader kicker="Editable" title="Create your account" subtitle="You'll need an invite code — ask whoever sent you here." />
      {/* SignupForm reads ?invite= via useSearchParams, which needs a
       *  Suspense boundary to avoid forcing this whole route to bail out of
       *  static rendering. */}
      <Suspense>
        <SignupForm />
      </Suspense>
    </Container>
  );
}
