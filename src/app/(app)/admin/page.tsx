import { redirect } from "next/navigation";

/** The founder's home is the production queue (the brands list arrives with
 *  the rest of Admin). */
export default function AdminIndex() {
  redirect("/admin/production");
}
