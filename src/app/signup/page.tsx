import Link from "next/link";
import { Container, PageHeader } from "../_components/ui";
import { SignupForm } from "./_components/SignupForm";

export default function SignupPage() {
  return (
    <Container className="max-w-md">
      <PageHeader kicker="Editable" title="Create your account" subtitle="Sign up with your email to get started." />
      <SignupForm />
      <p className="mt-4 text-center text-sm text-[color:var(--ink-dim)]">
        Already have an account?{" "}
        <Link href="/login" className="text-[color:var(--accent)] hover:underline">
          Log in
        </Link>
      </p>
    </Container>
  );
}
