import { StrictMode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsNewDialog } from "../src/components/WhatsNewDialog";
import { LATEST_WHATS_NEW_ID } from "../src/lib/whats-new-seen";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";

vi.mock("../src/data/whats-new", () => ({ WHATS_NEW_NOTES: [
  { date: "2026-11-02", kind: "new", title: "Future change", body: "Not released yet.", prs: [] },
  { date: "2026-11-01", kind: "new", title: "New in November", body: "A recent addition.", prs: [] },
  { date: "2026-10-31", kind: "improved", title: "Improved in October", body: "A recent improvement.", prs: [] },
  { date: "2026-10-12", kind: "fixed", title: "First included day", body: "Twenty dates before today.", prs: [] },
  { date: "2026-10-11", kind: "fixed", title: "First excluded day", body: "Twenty-one dates before today.", prs: [] },
] }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T17:00:00Z"));
});
afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe("WhatsNewDialog", () => {
  it("opens once from a fresh-tab request and clears its own launcher unread state", async () => {
    render(<StrictMode><WhatsNewDialog userId="staff-1" initiallyOpen /></StrictMode>);
    const dialog = screen.getByRole("dialog", { name: "What's new" });
    expect(dialog).toHaveAttribute("open");
    expect(await within(dialog).findByRole("heading", { level: 4, name: "New in November" })).toBeVisible();
    expect(screen.getByRole("button", { name: "What's new" })).not.toHaveAttribute("data-unread");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close what's new" }));
    expect(dialog).not.toHaveAttribute("open");
  });
  it("shows an icon-only launcher with an unread dot until the notes open", async () => {
    render(<WhatsNewDialog userId="staff-1" />);
    const launch = screen.getByRole("button", { name: "What's new, unread updates" });
    expect(launch).toHaveAttribute("data-unread", "true");
    expect(launch).toHaveAttribute("title", "What's new");
    expect(launch.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(launch.querySelector(".workspace-more-label")).toHaveTextContent("What's new");

    fireEvent.click(launch);
    const dialog = screen.getByRole("dialog", { name: "What's new" });
    expect(dialog).toHaveAttribute("open");
    expect(await within(dialog).findByRole("heading", { level: 4, name: "New in November" })).toBeVisible();
    expect(screen.getByRole("button", { name: "What's new" })).not.toHaveAttribute("data-unread");
    expect(localStorage.getItem("boardwalk.whatsNew.seen.staff-1")).toBe(LATEST_WHATS_NEW_ID);
  });

  it("shows only the last 21 station dates, newest first, grouped by month with kind labels", async () => {
    render(<WhatsNewDialog userId="staff-1" />);
    fireEvent.click(screen.getByRole("button", { name: /What's new/ }));
    const dialog = screen.getByRole("dialog", { name: "What's new" });
    expect(await within(dialog).findByRole("region", { name: "November 2026" })).toBeVisible();
    expect(within(dialog).getByRole("region", { name: "October 2026" })).toBeVisible();
    expect(within(dialog).getAllByRole("heading", { level: 4 }).map(heading => heading.textContent))
      .toEqual(["New in November", "Improved in October", "First included day"]);
    expect(within(dialog).getAllByText(/^(New|Improved|Fixed)$/)).toHaveLength(3);
    expect(within(dialog).queryByText("First excluded day")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Future change")).not.toBeInTheDocument();
  });

  it("uses the station date before UTC midnight and recomputes cached notes when reopened", async () => {
    vi.setSystemTime(new Date("2026-11-01T03:59:00Z")); // Still October 31 in New Jersey.
    render(<WhatsNewDialog userId="staff-1" />);
    fireEvent.click(screen.getByRole("button", { name: /What's new/ }));
    const dialog = screen.getByRole("dialog", { name: "What's new" });
    expect(await within(dialog).findByRole("heading", { name: "First excluded day" })).toBeVisible();
    expect(within(dialog).queryByText("New in November")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close what's new" }));
    vi.setSystemTime(new Date("2026-11-01T05:01:00Z")); // November 1, before the fall-back transition.
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    expect(within(dialog).getByRole("heading", { name: "New in November" })).toBeVisible();
    expect(within(dialog).queryByText("First excluded day")).not.toBeInTheDocument();
  });

  it("explains when there are no recent entries", async () => {
    vi.setSystemTime(new Date("2027-01-01T17:00:00Z"));
    render(<WhatsNewDialog userId="staff-1" />);
    fireEvent.click(screen.getByRole("button", { name: /What's new/ }));
    const dialog = screen.getByRole("dialog", { name: "What's new" });
    expect(await within(dialog).findByText("No changes in the last three weeks.")).toBeVisible();
    expect(within(dialog).queryByRole("list")).not.toBeInTheDocument();
  });

  it("starts without the dot once the newest notes are seen", () => {
    localStorage.setItem("boardwalk.whatsNew.seen.staff-1", LATEST_WHATS_NEW_ID);
    render(<WhatsNewDialog userId="staff-1" />);
    expect(screen.getByRole("button", { name: "What's new" })).not.toHaveAttribute("data-unread");
  });

  it("closes from its labeled close button", async () => {
    render(<WhatsNewDialog userId="staff-1" />);
    fireEvent.click(screen.getByRole("button", { name: /What's new/ }));
    const dialog = screen.getByRole("dialog", { name: "What's new" });
    const close = within(dialog).getByRole("button", { name: "Close what's new" });
    expect(close).toHaveAttribute("title", "Close");
    fireEvent.click(close);
    expect(dialog).not.toHaveAttribute("open");
  });

  it("stays icon only in text-control mode, like the guide and report controls", () => {
    render(<ControlPresentationProvider value="text"><WhatsNewDialog userId="staff-1" /></ControlPresentationProvider>);
    expect(screen.getByRole("button", { name: /What's new/ })).toHaveClass("whats-new-launch");
    expect(screen.getByRole("button", { name: /What's new/ })).not.toHaveClass("whats-new-launch-text");
  });
});
