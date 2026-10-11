import { redirect } from "next/navigation";

/** Admin opens on the pool of viral videos. */
export default function AdminIndex() {
  redirect("/admin/sources");
}
