import { redirect } from "next/navigation";

/** Moved under Admin. */
export default function ReverseEngineerRedirect() {
  redirect("/admin/reverse-engineer");
}
