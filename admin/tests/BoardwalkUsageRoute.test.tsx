import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { BoardwalkUsageSurface, type UsageLoader } from "../src/routes/BoardwalkUsageRoute";
import { ReportsRoute } from "../src/routes/ReportsRoute";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import type { UsageReport } from "../src/lib/boardwalk-usage";

const fixture = (days = 30): UsageReport => ({ days, analyticsEnabled: false, generatedAt: "2026-11-07T12:00:00Z",
  history: { status: "ready", start: "2026-10-09", end: "2026-11-07", actions: [{ id: "auth.login", label: "Accepted sign-ins", count: 25 }] },
  firstCollectedDate: "2026-11-01", timezone: "UTC", daily: [{ date: "2026-11-07", activeUsers: 4 }],
  weekly: [{ week: "2026-11-02", activeUsers: 7 }],
  screens: [{ id: "posts", label: "Posts", views: 12, visibleMs: 120_000 }, { id: "pages", label: "Pages", views: 0, visibleMs: 0 }],
  actions: [{ id: "content.publish.request", label: "Content publish attempts", count: 3 }] });
const mount = (load: UsageLoader) => render(<MemoryRouter><BoardwalkUsageSurface load={load} /></MemoryRouter>);
afterEach(() => vi.unstubAllGlobals());

describe("Boardwalk usage Reports view", () => {
  it("shows aggregate counts, zero-use features, collection state and honest time limits", async () => {
    mount(async () => fixture());
    expect(await screen.findByText(/New usage analytics collection is off/)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Accepted sign-ins 25" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Posts 12 2.0" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Pages 0 0.0" })).toBeInTheDocument();
    expect(screen.getByText(/does not measure productivity/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to problem reports" })).toHaveAttribute("href", "/reports");
    expect(screen.getByRole("link", { name: "What Boardwalk records and why" })).toHaveAttribute("href", "/guide/boardwalk-usage");
  });

  it("clears an old window immediately and ignores stale responses", async () => {
    let resolveOld!: (value: UsageReport) => void;
    const load: UsageLoader = days => days === 30 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(fixture(days));
    mount(load);
    fireEvent.change(screen.getByLabelText("Reporting period"), { target: { value: "7" } });
    expect(await screen.findByText("Posts")).toBeInTheDocument();
    resolveOld({ ...fixture(), screens: [{ id: "old", label: "Stale window", views: 100, visibleMs: 0 }] });
    await waitFor(() => expect(screen.queryByText("Stale window")).not.toBeInTheDocument());
  });

  it("offers an empty explanation and recovers from failures without exposing errors", async () => {
    let calls = 0;
    mount(async () => {
      if (++calls === 1) throw new Error("private server detail");
      return { ...fixture(), firstCollectedDate: null, daily: [], weekly: [], screens: [], actions: [] };
    });
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText(/private server/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("No new usage analytics collected")).toBeInTheDocument();
    expect(screen.getByText("Time without analytics does not mean a tool is unused.")).toBeInTheDocument();
  });

  it("opens usage directly for scoped staff without loading problem reports", async () => {
    const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/cmsGetBoardwalkUsage");
      const { days } = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(fixture(days)), { status: 200 });
    });
    vi.stubGlobal("fetch", network);
    const shell = { user: { uid: "staff-1", email: null }, principal: { id: "staff-1", grants: [{ role: "editor", sections: ["news"] }] },
      getIdToken: async () => "synthetic-token", userDoc: null, signOut: () => {} } as ShellData;
    render(<MemoryRouter initialEntries={["/reports/usage"]}><ShellProvider value={shell}><ReportsRoute /></ShellProvider></MemoryRouter>);
    expect(await screen.findByText("Posts")).toBeInTheDocument();
    expect(network).toHaveBeenCalledTimes(1);
  });
});
