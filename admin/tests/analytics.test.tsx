import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import type { AnalyticsReport } from "../../packages/content-core/src/analytics";
import type { Role } from "../../packages/content-core/src/rbac";
import { AnalyticsRoute, AnalyticsSurface } from "../src/routes/AnalyticsRoute";
import { analyticsFixture } from "../src/dev/analytics-fixture";
import { canViewAnalytics } from "../src/lib/access";
import { analyticsCsv, getAnalytics } from "../src/lib/analytics";
import { HttpError } from "../src/lib/functions";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import { eligibleNavDestinations } from "../src/lib/nav-destinations";
import { canOpenAdminPath } from "../src/lib/route-memory";
import { engagementPerUser, exportFilteredPages, exportRows, filterPages, insights, publicPageUrl } from "../src/components/analytics/analytics-model";

const getIdToken = vi.hoisted(() => vi.fn());
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => ({ getIdToken }) }));
vi.mock("../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/analytics")>()),
  getAnalytics: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  getIdToken.mockResolvedValue("test-token");
});

const report = (days: 7 | 30 | 90 = 30): AnalyticsReport => ({ ...analyticsFixture, days });
const adminShell: ShellData = {
  principal: { grants: [{ role: "admin" }] },
  user: { uid: "admin", email: "admin@example.test", displayName: "Admin" },
  userDoc: null,
  signOut: vi.fn(),
};
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

it.each<[Role, boolean]>([
  ["admin", true], ["super_admin", true], ["editor", false],
  ["contributor", false], ["staff", false],
])("restricts analytics for %s", (role, expected) => {
  const principal = { grants: [{ role }] };
  expect(canViewAnalytics(principal)).toBe(expected);
  expect(eligibleNavDestinations(principal).some(item => item.id === "analytics")).toBe(expected);
  expect(canOpenAdminPath(principal, "/analytics/")).toBe(expected);
});
it("does not widen scoped administrator grants", () => {
  expect(canViewAnalytics({ grants: [{ role: "admin", sections: ["news"] }] })).toBe(false);
});
it("does not mount the loader for a forbidden direct route", () => {
  render(<MemoryRouter initialEntries={["/analytics"]}>
    <ShellProvider value={{ ...adminShell, principal: { grants: [{ role: "editor" }] } }}>
      <AnalyticsRoute />
    </ShellProvider>
  </MemoryRouter>);
  expect(getIdToken).not.toHaveBeenCalled();
  expect(getAnalytics).not.toHaveBeenCalled();
});
it("preserves unrelated URL parameters while changing views and comparison", async () => {
  vi.mocked(getAnalytics).mockResolvedValue(report(7));
  render(<MemoryRouter initialEntries={["/analytics?view=content&compare=off&keep=1"]}>
    <ShellProvider value={adminShell}><AnalyticsRoute /><LocationProbe /></ShellProvider>
  </MemoryRouter>);
  expect(await screen.findByRole("tab", { name: "Content performance" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("tab", { name: "Audience" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Compare GA4 totals" }));
  expect(Object.fromEntries(new URLSearchParams(screen.getByTestId("location").textContent ?? "")))
    .toEqual({ view: "audience", compare: "on", keep: "1" });
  expect(getAnalytics).toHaveBeenCalledTimes(1);
});
it("opens the Newsletters tab from the overview campaign control", async () => {
  render(<AnalyticsSurface load={vi.fn().mockResolvedValue(report())} initialDays={30} />);
  await screen.findByRole("heading", { name: "Your audience at a glance" });
  fireEvent.click(screen.getByRole("button", { name: "View campaigns" }));
  expect(screen.getByRole("tab", { name: "Newsletters" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("heading", { name: "How newsletters are performing" })).toBeInTheDocument();
});
it("keeps available providers visible when GA4 is missing", async () => {
  const load = vi.fn().mockResolvedValue({
    ...report(), ga4: { status: "not_configured", data: null, message: "GA4 access is pending." },
  });
  render(<AnalyticsSurface load={load} initialDays={30} fixedPeriod />);
  expect(await screen.findByText("GA4 access is pending.")).toBeInTheDocument();
  expect(screen.getByText("2,100,450")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Newsletters" }));
  const campaigns = screen.getByRole("heading", { name: "Campaign results" });
  fireEvent.click(screen.getByRole("link", { name: "View campaigns" }));
  expect(campaigns.closest(".bw-campaign-target")).toHaveFocus();
  expect(load).toHaveBeenCalledTimes(1);
});
it("keeps zero distinct from missing data and shows partial coverage", async () => {
  const zero = structuredClone(report());
  zero.ga4.data!.totals.activeUsers = 0;
  zero.cloudflare.data!.complete = false;
  zero.mailchimp.data!.truncated = true;
  zero.mailchimp.data!.growth = [];
  render(<AnalyticsSurface load={vi.fn().mockResolvedValue(zero)} initialDays={30} />);
  expect(await screen.findByText(/Partial delivery period/)).toBeInTheDocument();
  expect(screen.getByText(/Campaign results are limited/)).toBeInTheDocument();
  expect(screen.getByText("0", { selector: ".bw-value" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Newsletters" }));
  expect(screen.getByText("No data was reported for this period.")).toBeInTheDocument();
});
it("aborts obsolete requests during rapid 30, 7, and 90-day changes", async () => {
  let resolveSeven!: (value: AnalyticsReport) => void;
  const load = vi.fn((days: 7 | 30 | 90, _signal: AbortSignal) => {
    if (days === 7) return new Promise<AnalyticsReport>(resolve => { resolveSeven = resolve; });
    return Promise.resolve(days === 90 ? {
      ...report(90), ga4: { status: "unavailable" as const, data: null, message: "New period unavailable." },
    } : report());
  });
  render(<AnalyticsSurface load={load} initialDays={30} />);
  await screen.findByRole("heading", { name: "Your audience at a glance" });
  fireEvent.change(screen.getByLabelText("Reporting period"), { target: { value: "7" } });
  expect(screen.queryByRole("heading", { name: "Your audience at a glance" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Reporting period"), { target: { value: "90" } });
  expect(await screen.findByText("New period unavailable.")).toBeInTheDocument();
  expect(load.mock.calls[1][1].aborted).toBe(true);
  resolveSeven(report(7));
  await waitFor(() => expect(screen.getByText("New period unavailable.")).toBeInTheDocument());
  expect(screen.getByRole("combobox", { name: "Reporting period" })).toHaveValue("90");
});
it("keeps a same-period report when refresh fails and allows retry", async () => {
  const load = vi.fn().mockResolvedValueOnce(report()).mockRejectedValueOnce(new Error("private provider details"))
    .mockResolvedValueOnce(report());
  render(<AnalyticsSurface load={load} initialDays={30} />);
  await screen.findByRole("heading", { name: "Your audience at a glance" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText(/Showing the last successfully loaded report/)).toBeInTheDocument();
  expect(screen.queryByText("private provider details")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
});
it("keeps the period selector after a failed initial load", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("Transport failed")).mockResolvedValueOnce(report(30));
  render(<AnalyticsSurface load={load} />);
  expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Reporting period" })).toBeEnabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Reporting period" }), { target: { value: "30" } });
  expect(await screen.findByRole("heading", { name: "Your audience at a glance" })).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(2);
});
it("gives an access reason for a denied report without exposing transport errors", async () => {
  render(<AnalyticsSurface load={vi.fn().mockRejectedValue(new HttpError(403, "Untrusted proxy text"))} />);
  expect(await screen.findByText("Analytics access and a valid session are required.")).toBeInTheDocument();
  expect(screen.queryByText("Untrusted proxy text")).not.toBeInTheDocument();
});
it("keeps provider quality notes visible and comparison opt-out consistent", async () => {
  const sampled = structuredClone(report());
  sampled.ga4.data!.notes = ["Tagged browser traffic.", "Dates follow the GA4 property timezone.", "Google used sampled data in this report."];
  render(<AnalyticsSurface load={vi.fn().mockResolvedValue(sampled)} initialDays={30} />);
  await screen.findByRole("heading", { name: "Your audience at a glance" });
  expect(document.querySelector(".bw-source-notices")?.textContent).toContain("Google used sampled data in this report.");
  fireEvent.click(screen.getByRole("checkbox", { name: "Compare GA4 totals" }));
  expect(screen.getByText("12,450 active users")).toBeInTheDocument();
  expect(insights(sampled, false)[0].body).not.toMatch(/previous|prior/i);
  expect(screen.getByRole("group", { name: "Report source status" })).toBeInTheDocument();
});
it("does not request again for local controls or a stable loader rerender", async () => {
  const load = vi.fn().mockResolvedValue(report());
  const { rerender } = render(<AnalyticsSurface load={load} initialDays={30} />);
  await screen.findByRole("heading", { name: "Your audience at a glance" });
  rerender(<AnalyticsSurface load={load} initialDays={30} />);
  fireEvent.click(screen.getByRole("tab", { name: "Content performance" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search reported pages" }), { target: { value: "water" } });
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Compare GA4 totals" }));
  expect(load).toHaveBeenCalledTimes(1);
});
it("aborts an in-flight report when the surface unmounts", () => {
  const load = vi.fn((_days: 7 | 30 | 90, _signal: AbortSignal) => new Promise<AnalyticsReport>(() => {}));
  const { unmount } = render(<AnalyticsSurface load={load} />);
  const signal = load.mock.calls[0][1];
  expect(screen.getByRole("button", { name: "Export report" })).toBeDisabled();
  unmount();
  expect(signal.aborted).toBe(true);
});
it("keeps ready-without-data separate from reported zero", async () => {
  const emptyReady = { ...report(), ga4: { status: "ready" as const, message: "", data: null } };
  render(<AnalyticsSurface load={vi.fn().mockResolvedValue(emptyReady)} initialDays={30} />);
  expect(await screen.findByText("GA4 data is unavailable.")).toBeInTheDocument();
  expect(screen.getByText("2,100,450")).toBeInTheDocument();
  expect(screen.queryByText("0", { selector: ".bw-value" })).not.toBeInTheDocument();
});
it("filters reported paths, resets pagination, and sorts numeric views", async () => {
  const many = structuredClone(report());
  many.ga4.data!.pages = Array.from({ length: 10 }, (_, index) => ({
    ...analyticsFixture.ga4.data!.pages[0],
    name: index % 2 ? `/service-${index}/` : `/posts/story-${index}/`,
    views: index + 1,
  }));
  render(<AnalyticsSurface load={vi.fn().mockResolvedValue(many)} initialDays={30} />);
  await screen.findByRole("heading", { name: "Your audience at a glance" });
  fireEvent.click(screen.getByRole("tab", { name: "Content performance" }));
  expect(screen.getByText("1 / 2")).toBeInTheDocument();
  expect(screen.getByText("10 matching rows. Showing rows 1 through 8. Page 1 of 2. Post filter uses /posts/<slug> paths.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("2 / 2")).toBeInTheDocument();
  expect(screen.getByText("10 matching rows. Showing rows 9 through 10. Page 2 of 2. Post filter uses /posts/<slug> paths.")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Show" }), { target: { value: "posts" } });
  expect(screen.getByText("1 / 1")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search reported pages" }), { target: { value: "story-4" } });
  expect(screen.getByText("1 matching rows. Showing rows 1 through 1. Page 1 of 1. Post filter uses /posts/<slug> paths.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export filtered rows" })).toBeEnabled();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search reported pages" }), { target: { value: "missing" } });
  expect(screen.getByRole("button", { name: "Export filtered rows" })).toBeDisabled();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search reported pages" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /^Views/ }));
  const rows = within(screen.getAllByRole("region", { name: "Story and page performance" })[1]).getAllByRole("row");
  expect(within(rows[1]).getByRole("button", { name: "/posts/story-0/" })).toBeInTheDocument();
});
it("provides roving tabs, chart figures, and a named page dialog", async () => {
  render(<AnalyticsSurface load={vi.fn().mockResolvedValue(report())} initialDays={30} />);
  await screen.findByRole("heading", { name: "Your audience at a glance" });
  fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Content performance" })).toHaveAttribute("aria-selected", "true");
  const detail = screen.getByRole("button", { name: "/posts/new-jersey-water-quality/" });
  fireEvent.click(detail);
  expect(screen.getByRole("dialog", { name: "/posts/new-jersey-water-quality/" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close page details" }));
  expect(detail).toHaveFocus();
  fireEvent.click(screen.getByRole("tab", { name: "Audience" }));
  fireEvent.click(screen.getByText("View daily figures"));
  expect(within(screen.getByRole("region", { name: "Daily counts figures" })).getAllByRole("row")).toHaveLength(31);
});
it("exports raw metadata, safe links, and one CSV formula rule", () => {
  const audience = analyticsFixture.ga4.data!;
  const page = audience.pages[0];
  expect(engagementPerUser(page)).toBe(page.engagementSeconds / page.activeUsers);
  const sorted = filterPages(audience.pages, "", "posts", "engagementSeconds", false);
  expect(engagementPerUser(sorted[0])!).toBeGreaterThanOrEqual(engagementPerUser(sorted[1])!);
  expect(publicPageUrl("/posts/example/")).toBe("https://njpbs.org/posts/example/");
  expect(publicPageUrl("//evil.example")).toBeNull();
  expect(analyticsCsv([["  =1+1", 'a"b', 14]])).toBe('"\'  =1+1","a""b","14"');
  const filtered = exportFilteredPages(analyticsFixture, [page]);
  expect(filtered[1]).toEqual(expect.arrayContaining(["GA4", audience.period.start, audience.period.end, audience.period.timezone, page.name, page.engagementSeconds]));
  expect(String(filtered[1][4])).toContain("Public hosts");
  const all = exportRows(analyticsFixture);
  expect(all.some(row => row[5] === "Audience" && row[1] === "" && row[4] === "CURRENT audience, not historical")).toBe(true);
});
