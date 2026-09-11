import { Container, PageHeader } from "../_components/ui";
import { SignupForm } from "./_components/SignupForm";

export default function SignupPage() {
  return (
    <Container className="max-w-md">
      <PageHeader kicker="Editable" title="Create your account" subtitle="Sign up with your email to get started." />
      <SignupForm />
    </Container>
  );
}
