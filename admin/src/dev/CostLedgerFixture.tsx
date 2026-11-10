import type { CostLedgerTransport } from "../routes/CostLedgerRoute";
type CostLedgerMutation = Parameters<CostLedgerTransport["mutate"]>[0];
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ShellLayout } from "../routes/ShellLayout";
import { ShellProvider, type ShellData } from "../routes/ShellContext";
import { CostLedgerSurface } from "../routes/CostLedgerRoute";
import { costLedgerFixture } from "./cost-ledger-fixture";
import styles from "../routes/CostLedgerRoute.css?inline";
import "../styles.css";

if (!import.meta.env.DEV)
  throw new Error("Costs fixtures are development-only.");
const params = new URLSearchParams(location.search);
const view = costLedgerFixture(params.get("state"));
let confirmedFixtureWrite = false;
let recoveryReadFailed = false;
const load = async (period?: string) => {
  if (
    params.get("state") === "recoverable-read" &&
    confirmedFixtureWrite &&
    !recoveryReadFailed
  ) {
    recoveryReadFailed = true;
    throw new Error("Sanitized fixture reload unavailable.");
  }
  if (params.get("state") === "pending-read" && period)
    return new Promise<never>(() => {});
  if (params.get("state") === "reload-error" && period)
    throw new Error("Sanitized fixture read unavailable.");
  if (params.get("state") === "reload-failure" && confirmedFixtureWrite)
    throw new Error("Sanitized fixture reload unavailable.");
  if (params.get("state") === "error")
    throw new Error("Sanitized fixture read unavailable.");
  const result = structuredClone(view);
  if (params.get("state") === "hardware-conflict" && period)
    result.hardware.machines[0].internetShareCents = 2500;
  return result;
};
const mutate = async (request: CostLedgerMutation) => {
  if (
    params.get("state") === "retained-amount" &&
    request.action === "saveLine" &&
    request.line.id === "gcp" &&
    !request.line.enabled
  ) {
    // In-memory response only; demonstrate a draft surviving an inactive-line reload.
    const line = view.lines.find((row) => row.id === request.line.id);
    if (line) {
      if (line.state === "known" && line.monthlyCents !== null) {
        const priorAmount = line.monthlyCents;
        view.monthlyCents -= priorAmount;
        view.annualRunRateCents = view.monthlyCents * 12;
        view.yearToDateCents -= priorAmount;
        view.knownLineCount--;
        view.byCategory[line.category] -= priorAmount;
        view.byProject[line.project] -= priorAmount;
      }
      // Supplied literal for this saved-response fixture; never build CSV from drafts.
      view.csv = "Period,Known total\n2026-09,10650.59\n";
      line.enabled = request.line.enabled;
      line.notes = request.line.notes;
      line.state = "inactive";
      line.monthlyCents = null;
    }
    return { success: true };
  }
  if (params.get("state") === "pending") return new Promise(() => {});
  if (
    params.get("state") === "reload-failure" ||
    params.get("state") === "recoverable-read"
  ) {
    confirmedFixtureWrite = true;
    return { success: true };
  }
  throw new Error("Fixture only: no changes are persisted.");
};
const shell: ShellData = {
  principal: { id: "cost-fixture", grants: [{ role: "super_admin" }] },
  user: {
    uid: "cost-fixture",
    email: "editor@example.test",
    displayName: "Sample editor",
  },
  userDoc: {
    role: "super_admin",
    displayName: "Sample editor",
  } as ShellData["userDoc"],
  signOut: () => {},
  navigationShares: [],
};
const router = createMemoryRouter(
  [
    {
      path: "/",
      element: <ShellLayout />,
      children: [
        {
          path: "admin/settings/costs",
          element: (
            <>
              <style>{styles}</style>
              <CostLedgerSurface load={load} mutate={mutate} />
            </>
          ),
          handle: { title: "Costs", description: "Review operating costs." },
        },
      ],
    },
  ],
  {
    initialEntries: [
      params.has("trailing-slash")
        ? "/admin/settings/costs/"
        : "/admin/settings/costs",
    ],
  },
);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShellProvider value={shell}>
      <RouterProvider router={router} />
    </ShellProvider>
  </StrictMode>,
);
