import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { BoardwalkUsageSurface, type UsageLoader } from "../src/routes/BoardwalkUsageRoute";
import { ReportsRoute } from "../src/routes/ReportsRoute";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import type { UsageReport } from "../src/lib/boardwalk-usage";

const zeroFriction = () => ({ transitions: 0, backForth: 0, pairs: [], publish: { items: 0, repeats: 0, repeatedItems: 0 }, preview: { items: 0, repeats: 0, repeatedItems: 0 } });
const zeroJobs = () => ({ previews: 0, failed: 0, expired: 0, stuckUploads: 0 });
const grid = () => Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
const screenRow = (id: string, label: string, views: number, visibleMs: number) => ({ id, label, views, visibleMs, personDays: 0,
  newsroom: { views: 0, visibleMs: 0, personDays: 0 }, product: { views: 0, visibleMs: 0, personDays: 0 } });
const fixture = (days = 30): UsageReport => ({ days, analyticsEnabled: false, generatedAt: "2026-11-07T12:00:00Z",
  history: { status: "ready", start: "2026-10-09", end: "2026-11-07", actions: [{ id: "auth.login", label: "Accepted sign-ins", count: 25 }] },
  firstCollectedDate: "2026-11-01", easternFromDate: "2026-11-05", timezone: "America/New_York",
  daily: [{ date: "2026-11-04", timezone: "UTC", activeUsers: 3, newsroom: null, product: null },
    { date: "2026-11-07", timezone: "America/New_York", activeUsers: 4, newsroom: 3, product: 1 }],
  weekly: [{ week: "2026-11-02", timezone: "America/New_York", activeUsers: 7, newsroom: 5, product: 2,
    byRole: [{ role: "editor", activeUsers: 5 }, { role: "owner", activeUsers: 2 }] }],
  weekCompare: { thisWeek: { newsroom: 9, product: 2 }, lastWeek: { newsroom: 7, product: 2 } },
  sessions: { newsroom: { sessions: 4, visibleMs: 1_200_000 }, product: { sessions: 0, visibleMs: 0 } },
  activePeople: { status: "ready", newsroom: 5, product: 2 },
  roleActivity: { status: "ready", rows: [{ role: "editor", group: "newsroom", roster: 8, active: 5, sessions: 4, visibleMs: 1_200_000 }] },
  hourMs: { newsroom: grid().map((row, day) => day === 0 ? row.map((ms, hour) => hour === 9 ? 600_000 : ms) : row), product: grid() },
  screens: [{ ...screenRow("posts", "Posts", 12, 120_000), personDays: 5,
    newsroom: { views: 10, visibleMs: 90_000, personDays: 4 }, product: { views: 2, visibleMs: 30_000, personDays: 1 } },
  screenRow("pages", "Pages", 0, 0)],
  actions: [{ id: "content.publish.request", label: "Content publish attempts", count: 3, personDays: 2, lastUsed: "2026-11-06",
    newsroom: { count: 3, personDays: 2 }, product: { count: 0, personDays: 0 } }],
  friction: {
    current: { newsroom: { ...zeroFriction(), transitions: 20, backForth: 5, pairs: [{ screens: ["Post editor", "Posts list"], count: 3 }],
      publish: { items: 4, repeats: 2, repeatedItems: 1 } }, product: zeroFriction() },
    prior: { newsroom: zeroFriction(), product: zeroFriction() },
    jobs: { status: "ready", current: { newsroom: { ...zeroJobs(), previews: 10, failed: 1, stuckUploads: 2 }, product: zeroJobs() },
      prior: { newsroom: zeroJobs(), product: zeroJobs() }, previewCoverage: { current: { status: "full" }, prior: { status: "full" } } } },
  contentFlow: { status: "ready", teams: "ready", medianHoursToFirstPublish: 3.5, publishedWeeks: [{ week: "2026-11-02", total: 9, newsroom: 6, product: 1, other: 2 }],
    openDrafts: [{ bucket: "day", total: 1, newsroom: 1, product: 0, other: 0 }, { bucket: "week", total: 0, newsroom: 0, product: 0, other: 0 },
      { bucket: "month", total: 0, newsroom: 0, product: 0, other: 0 }, { bucket: "older", total: 3, newsroom: 2, product: 0, other: 1 }] },
  problemReports: { status: "ready", open: 3, resolved: 2, medianDaysToResolve: 1.5, filed: 4, topPages: [{ page: "/content/post", count: 3 }] },
  excludedAccounts: 2 });
const mount = (load: UsageLoader) => render(<MemoryRouter><BoardwalkUsageSurface load={load} /></MemoryRouter>);
afterEach(() => vi.unstubAllGlobals());

describe("Boardwalk usage Reports view", () => {
  it("shows aggregate counts, zero-use features, collection state and honest time limits", async () => {
    mount(async () => fixture());
    expect(await screen.findByText(/New usage analytics collection is off/)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Accepted sign-ins 25" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Posts 4 1 12 10 2 2.0 1.5 0.5" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Pages 0 0 0 0 0 0.0 0.0 0.0" })).toBeInTheDocument();
    expect(screen.getByText(/does not measure productivity/)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "2026-11-04 (UTC) 3 Not recorded Not recorded" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "2026-11-07 4 3 1" })).toBeInTheDocument();
    expect(screen.getByText(/Rows marked UTC were collected before Eastern dates began on 2026-11-05/)).toBeInTheDocument();
  });

  it("reads every analysis table for the period from the dashboard", async () => {
    mount(async () => fixture());
    const tile = async (name: string) => (await screen.findByRole("heading", { name })).closest("article")!;
    expect(await tile("Newsroom active this week")).toHaveTextContent("9Last week 7. Product team this week 2.");
    expect(await tile("Newsroom active today")).toHaveTextContent("3Product team 1.");
    expect(await tile("Average visible minutes per session")).toHaveTextContent("5.0Newsroom, 4 sessions. Product team No sessions.");
    expect(await tile("Open problem reports")).toHaveTextContent("3");
    expect(screen.getByRole("img", { name: /highest day had 3/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "2026-11-02 7 5 2 Editor 5, Owner 2" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Editor Newsroom 8 5 4 20.0 4.0" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^Monday 0 0 0 0 0 0 0 0 0 10 0/ })).toHaveTextContent(/10\.00\.0$/);
    expect(screen.getByRole("row", { name: "Content publish attempts 3 3 0 2 0 2026-11-06" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Items with a repeated publish attempt 1 of 4 0 of 0 0 of 0 0 of 0" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Preview jobs that failed 10% (1 of 10) None None None" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Moves straight back to the screen before last 25% (5 of 20) None None None" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Uploads started in the period and still active after a day 2 0 0 0" })).toBeInTheDocument();
    expect(screen.getByText("Newsroom: Post editor and Posts list (3)")).toBeInTheDocument();
    expect(screen.getByText(/first publishing it, for posts first published in this period: 3.5 hours/)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "2026-11-02 9 6 1 2" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "30 days or more 3 2 0 1" })).toBeInTheDocument();
    expect(screen.getByText(/3 open. 4 filed in this period. Median time to resolve for the 2 resolved in this period: 1.5 days/)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "/content/post 3" })).toBeInTheDocument();
    expect(screen.getByText("2 agent, test or vendor accounts are excluded.")).toBeInTheDocument();
  });

  it("shows unreadable report sections as unavailable instead of zeros", async () => {
    mount(async () => ({ ...fixture(), roleActivity: { status: "unavailable", rows: [] }, contentFlow: { status: "unavailable" },
      problemReports: { status: "unavailable" }, friction: { ...fixture().friction, jobs: { status: "unavailable" } } }));
    expect(await screen.findByText(/The staff roster or active people could not be read completely/)).toBeInTheDocument();
    expect(screen.getByText(/Post records could not be read completely/)).toBeInTheDocument();
    expect(screen.getByText(/Problem reports could not be read completely/)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Preview jobs that failed Unavailable Unavailable Unavailable Unavailable" })).toBeInTheDocument();
    expect((await screen.findByRole("heading", { name: "Open problem reports" })).closest("article")).toHaveTextContent("Unavailable");
  });

  it("explains UTC rows whenever any appear, even when collection began on the switch date", async () => {
    mount(async () => ({ ...fixture(), firstCollectedDate: "2026-11-05", easternFromDate: "2026-11-05",
      daily: [{ date: "2026-11-05", timezone: "UTC", activeUsers: 2, newsroom: null, product: null },
        { date: "2026-11-05", timezone: "America/New_York", activeUsers: 1, newsroom: 1, product: 0 }] }));
    expect(await screen.findByRole("row", { name: "2026-11-05 (UTC) 2 Not recorded Not recorded" })).toBeInTheDocument();
    expect(screen.getByText(/A date or week can have both a UTC row and an Eastern row/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to problem reports" })).toHaveAttribute("href", "/reports");
    expect(screen.getByRole("link", { name: "What Boardwalk records and why" })).toHaveAttribute("href", "/guide/boardwalk-usage");
  });

  it("discloses Preview record coverage and hides team splits without a roster", async () => {
    const base = fixture();
    const { jobs } = base.friction;
    const flow = base.contentFlow;
    if (jobs.status !== "ready" || flow.status !== "ready") throw new Error("fixture");
    mount(async () => ({ ...base,
      friction: { ...base.friction, jobs: { ...jobs, previewCoverage: { current: { status: "partial", from: "2026-10-08" }, prior: { status: "unavailable" } } } },
      contentFlow: { ...flow, teams: "unavailable",
        publishedWeeks: [{ week: "2026-11-02", total: 9, newsroom: null, product: null, other: null }],
        openDrafts: flow.openDrafts.map(row => ({ ...row, newsroom: null, product: null, other: null })) } }));
    expect(await screen.findByRole("row", { name: "Preview jobs that failed 10% (1 of 10) since 2026-10-08 Unavailable None since 2026-10-08 Unavailable" })).toBeInTheDocument();
    expect(screen.getByText(/Preview job records are kept for 30 days/)).toBeInTheDocument();
    expect(screen.getByText(/posts are not split by team/)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "2026-11-02 9" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "30 days or more 3" })).toBeInTheDocument();
  });

  it("clears an old window immediately and ignores stale responses", async () => {
    let resolveOld!: (value: UsageReport) => void;
    const load: UsageLoader = days => days === 30 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(fixture(days));
    mount(load);
    fireEvent.change(screen.getByLabelText("Reporting period"), { target: { value: "7" } });
    expect(await screen.findByText("Posts")).toBeInTheDocument();
    resolveOld({ ...fixture(), screens: [screenRow("old", "Stale window", 100, 0)] });
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
    // Content flow and problem reports do not depend on usage collection.
    expect(screen.getByRole("heading", { name: "Content flow" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "2026-11-02 9 6 1 2" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Problem reports" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "/content/post 3" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Friction" })).not.toBeInTheDocument();
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
