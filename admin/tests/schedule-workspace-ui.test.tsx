import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastAiring, BroadcastSchedule } from "../src/data/broadcast-schedule";
import { ScheduleRoute, ScheduleSurface } from "../src/routes/ScheduleRoute";

const api = vi.hoisted(() => ({ getIdToken: vi.fn(), getSchedule: vi.fn() }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => ({ getIdToken: api.getIdToken }) }));
vi.mock("../src/lib/functions", () => ({ cmsGetBroadcastSchedule: api.getSchedule }));

const airing: BroadcastAiring = {
  date: "2026-10-01", time: "5:30 a.m.", station: "NJ PBS", program: "One-on-One",
  episode: "2951", title: "Guests and community", premiere: false,
  detailsStatus: "provided", status: "scheduled",
};
const schedule: BroadcastSchedule = {
  source: { coverageStart: "2026-10-01", coverageEnd: "2026-11-05", label: "Synthetic review packet",
    received: "2026-09-16", timezone: "America/New_York" },
  airings: [airing, { ...airing, station: "Thirteen", time: "12 a.m.", status: "preempted" },
    { ...airing, date: "2026-10-02", program: "State of Affairs", episode: "1022", title: "Local education", premiere: true }],
};
function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output aria-label="Current location">{location.search}</output><button onClick={() => navigate(-1)}>Go back</button></>;
}
function surface(url = "/schedule?week=2026-09-28", today = "2026-09-18") {
  return render(<MemoryRouter initialEntries={[url]}><ScheduleSurface schedule={schedule} today={today} /><LocationProbe /></MemoryRouter>);
}
beforeEach(() => { api.getIdToken.mockResolvedValue("fixture-token"); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

describe("broadcast workspace navigation", () => {
  it("separates upcoming coverage from live freshness and bounds the first week", () => {
    surface();
    expect(screen.getByText(/Upcoming coverage/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "This week" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous schedule week" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next schedule week" })).not.toBeDisabled();
    expect(within(screen.getByRole("group", { name: "Choose a day" })).getAllByRole("button")).toHaveLength(8);
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("canonicalizes invalid dates without discarding filters or unrelated URL state", async () => {
    surface("/schedule?week=2026-11-09&day=invalid&station=NJ+PBS&q=community&from=ops");
    await waitFor(() => expect(screen.getByLabelText("Current location")).toHaveTextContent("week=2026-11-02"));
    expect(screen.getByLabelText("Current location")).toHaveTextContent("station=NJ+PBS");
    expect(screen.getByLabelText("Current location")).toHaveTextContent("from=ops");
    expect(screen.getByLabelText("Current location")).not.toHaveTextContent("day=");
    expect(screen.getByLabelText("Search this week")).toHaveValue("community");
  });

  it("combines search and station filters and clears only filter parameters", () => {
    surface("/schedule?week=2026-09-28&from=ops");
    fireEvent.change(screen.getByLabelText("Search this week"), { target: { value: "2951 community" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Station" }), { target: { value: "NJ PBS" } });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(within(screen.getByRole("article")).queryByText("Thirteen")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByLabelText("Search this week")).toHaveValue("");
    expect(screen.getByLabelText("Current location")).toHaveTextContent("week=2026-09-28&from=ops");
  });

  it("filters preemptions without hiding their status or duplicating episode rows", () => {
    surface();
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), { target: { value: "preempted" } });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    const article = screen.getByRole("article");
    expect(within(article).getByText("Preempted")).toBeInTheDocument();
    expect(within(article).getByText("Thirteen")).toBeInTheDocument();
    expect(within(article).queryByText("NJ PBS")).not.toBeInTheDocument();
  });

  it("uses the day strip, resets day when changing week, and restores it with browser back", () => {
    surface("/schedule?week=2026-09-28&station=NJ+PBS");
    fireEvent.click(screen.getByRole("button", { name: /Friday, October 2:/ }));
    expect(screen.getByLabelText("Current location")).toHaveTextContent("day=2026-10-02");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Next schedule week" }));
    expect(screen.getByLabelText("Current location")).toHaveTextContent("week=2026-10-05");
    expect(screen.getByLabelText("Current location")).not.toHaveTextContent("day=");
    expect(screen.getByRole("combobox", { name: "Station" })).toHaveValue("NJ PBS");
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByRole("button", { name: /Friday, October 2:/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Full week" }));
    expect(screen.getByLabelText("Current location")).not.toHaveTextContent("day=");
  });

  it("gives unavailable station links a visible selection and a clear recovery", () => {
    surface("/schedule?week=2026-09-28&station=Unknown");
    expect(screen.getByRole("combobox", { name: "Station" })).toHaveValue("Unknown");
    expect(screen.getByRole("option", { name: "Unknown (not in packet)" })).toBeInTheDocument();
    expect(screen.getByText("No broadcasts match these filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.queryByText("No broadcasts match these filters.")).not.toBeInTheDocument();
  });

  it("does not describe an uncovered selected day as an empty broadcast day", () => {
    surface("/schedule?week=2026-09-28&day=2026-09-29&q=unmatched");
    expect(screen.getByText("Outside this source packet's coverage.")).toBeInTheDocument();
    expect(screen.queryByText("No broadcasts match these filters.")).not.toBeInTheDocument();
  });

  it("updates coverage after Eastern midnight without making an API request", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T03:59:30Z"));
    render(<MemoryRouter><ScheduleSurface schedule={{ ...schedule, source: { ...schedule.source, coverageEnd: "2026-10-01" } }} /></MemoryRouter>);
    expect(screen.getByText(/Today is within/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText(/Coverage has ended/)).toBeInTheDocument();
    expect(api.getSchedule).not.toHaveBeenCalled();
  });
});

describe("broadcast schedule refresh", () => {
  it("retains the current packet, filters, and successful check time after a failed refresh", async () => {
    let rejectRefresh!: (reason: Error) => void;
    api.getSchedule.mockResolvedValueOnce(schedule)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }))
      .mockResolvedValueOnce(schedule);
    render(<MemoryRouter initialEntries={["/schedule?week=2026-09-28&station=NJ+PBS"]}><ScheduleRoute /></MemoryRouter>);
    await screen.findByText("Guests and community");
    const checkedBefore = document.querySelector(".broadcast-checked time")?.getAttribute("datetime");
    fireEvent.click(screen.getByRole("button", { name: "Refresh schedule" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh schedule: Checking schedule" }));
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Guests and community")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Station" })).toHaveValue("NJ PBS");
    await act(async () => { rejectRefresh(new Error("offline")); });
    expect(await screen.findByText("Could not check for a newer packet")).toBeInTheDocument();
    expect(document.querySelector(".broadcast-checked time")?.getAttribute("datetime")).toBe(checkedBefore);
    fireEvent.click(screen.getByRole("button", { name: "Refresh schedule" }));
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText("Could not check for a newer packet")).not.toBeInTheDocument());
  });

  it.each([401, 403])("drops the retained packet when refresh explicitly denies access (%s)", async (status) => {
    api.getSchedule.mockResolvedValueOnce(schedule).mockRejectedValueOnce({ status });
    render(<MemoryRouter initialEntries={["/schedule?week=2026-09-28"]}><ScheduleRoute /></MemoryRouter>);
    await screen.findByText("Guests and community");
    fireEvent.click(screen.getByRole("button", { name: "Refresh schedule" }));
    expect(await screen.findByText("Broadcast schedule unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Guests and community")).not.toBeInTheDocument();
  });

  it("offers retry after an initial failure rather than presenting an empty schedule", async () => {
    api.getSchedule.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(schedule);
    render(<MemoryRouter initialEntries={["/schedule?week=2026-09-28"]}><ScheduleRoute /></MemoryRouter>);
    expect(await screen.findByText("Broadcast schedule unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText("Browse the schedule")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Guests and community")).toBeInTheDocument();
  });
});
