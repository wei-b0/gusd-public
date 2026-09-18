import { notFound } from "next/navigation";

/**
 * Catch-all so unmatched URLs resolve inside the (shell) group and its
 * not-found boundary renders with the machine shell around it.
 */
export default function NotFoundCatchAll() {
  notFound();
}
