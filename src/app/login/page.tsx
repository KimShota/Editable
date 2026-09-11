import Link from "next/link";
import { Container, PageHeader } from "../_components/ui";
import { LoginForm } from "./_components/LoginForm";

export default function LoginPage() {
  return (
    <Container className="max-w-md">
      <PageHeader kicker="Editable" title="Log in" />
      <LoginForm />
      <p className="mt-4 text-center text-sm text-[color:var(--ink-dim)]">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="text-[color:var(--accent)] hover:underline">
          Sign up
        </Link>
      </p>
    </Container>
  );
}
