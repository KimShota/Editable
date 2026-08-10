import { Container, PageHeader } from "../_components/ui";
import { LoginForm } from "./_components/LoginForm";

export default function LoginPage() {
  return (
    <Container className="max-w-md">
      <PageHeader kicker="Editable" title="Log in" />
      <LoginForm />
    </Container>
  );
}
