import { useEffect, useState } from "react";
import { staffSiteDestination } from "../lib/staff-site";

export function StaffSiteHandoff({ destination, getIdToken }: {
  destination: string;
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
}) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function openSite() {
      const target = staffSiteDestination(destination, window.location.hash);
      if (!target) throw new Error("This site address is not supported.");
      const token = await getIdToken(true);
      const result = await fetch(`${target.origin}/__cms-session`, {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!result.ok) throw new Error("The site could not be opened. Please try again.");
      if (!controller.signal.aborted) window.location.replace(target.href);
    }
    void openSite().catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The site could not be opened.");
    });
    return () => controller.abort();
  }, [destination, getIdToken]);
  return <main className="auth-screen auth-handoff"><p role={error ? "alert" : "status"}>
    {error ?? "Opening the site with your CMS account."}
  </p>{error ? <a href="/">Return to the CMS</a> : null}</main>;
}
