// Dev-server-only entry for the existing Playwright visual job. Tests replace
// the API module before navigation; this file contains no production identity.
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { ReportsRoute } from "../routes/ReportsRoute";
import { ShellProvider, type ShellData } from "../routes/ShellContext";
import "../styles.css";

if (!import.meta.env.DEV) throw new Error("The report fixture is development-only.");
const params = new URLSearchParams(window.location.search);
const role = params.get("role") === "admin" ? "admin" : "editor";
const shell = {
  principal: { id: "report-fixture-editor", grants: [{ role }] },
  user: { uid: "report-fixture-editor", email: null },
  userDoc: null,
  signOut: () => {},
  getIdToken: async () => "synthetic-fixture-token",
} as ShellData;
const reportId = `br_${"a".repeat(32)}`;
createRoot(document.getElementById("report-progress-root")!).render(
  <MemoryRouter initialEntries={[params.get("usage") === "1" ? "/reports/usage" : params.get("list") === "1" ? "/reports" : `/reports/${reportId}`]}>
    <ShellProvider value={shell}>
      <main style={{ padding: "var(--space-5)" }}><ReportsRoute /></main>
    </ShellProvider>
  </MemoryRouter>,
);
