import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueueList } from "../src/components/QueueList";

describe("QueueList", () => {
  it("keeps internal content IDs in details while showing available titles in the list", () => {
    render(<QueueList items={[{
      id: "job-20",
      changes: [
        { collection: "cmsPosts", id: "post-20", title: "Transit funding vote" },
        { collection: "cmsPages", id: "page-20" },
      ],
    }]} />);

    const row = screen.getByTestId("queue-item");
    expect(within(row).getByRole("cell", { name: /Transit funding vote, 1 other publication change/ })).toBeVisible();
    expect(screen.getByText("cmsPages/page-20")).not.toBeVisible();
    fireEvent.click(within(row).getByRole("button", { name: /^Details: Publication job / }));
    expect(screen.getByText("cmsPages/page-20")).toBeVisible();
  });

  it("describes queued settings as publication changes and preserves their exact paths", () => {
    render(<QueueList items={[{
      id: "settings-job",
      changes: [{ collection: "cmsSettings", id: "publicHomepageBanner" }],
    }]} />);

    const row = screen.getByTestId("queue-item");
    expect(within(row).getByRole("cell", { name: "1 publication change" })).toBeVisible();
    expect(screen.getByText("cmsSettings/publicHomepageBanner")).not.toBeVisible();
    fireEvent.click(within(row).getByRole("button", { name: /^Details: Publication job / }));
    expect(screen.getByText("cmsSettings/publicHomepageBanner")).toBeVisible();
  });

  it("keeps exact publication evidence and requester identity in job details", () => {
    render(
      <QueueList
        items={[
          {
            id: "job-17",
            status: "public_unconfirmed",
            triggeredBy: "publisher@example.com",
            triggeredById: "publisher-17",
            timestamp: new Date("2026-07-07T17:00:00.000Z"),
            completedAt: new Date("2026-07-07T17:02:00.000Z"),
            error: "The public receipt could not be confirmed.",
            transport: "serializer",
            changes: [
              {
                collection: "cmsPosts",
                id: "transit-vote",
                title: "Transit funding vote",
                sourceVersion: 7,
                operation: "withdraw",
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Needs confirmation")).toHaveClass(
      "publication-status-public-unconfirmed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Details: Publication job job-17" }));
    expect(screen.getByText("job-17")).toBeVisible();
    expect(screen.getByText("publisher-17")).toBeVisible();
    expect(screen.getByText("2026-07-07T17:00:00.000Z")).toBeVisible();
    expect(screen.getByText("2026-07-07T17:02:00.000Z")).toBeVisible();
    expect(screen.getByText("serializer")).toBeVisible();
    expect(
      screen.getByText("The public receipt could not be confirmed."),
    ).toBeVisible();
    expect(screen.getByText("cmsPosts/transit-vote")).toBeVisible();
    expect(screen.getByText("Source version 7")).toBeVisible();
    expect(screen.getByText("Operation: withdraw")).toBeVisible();
  });

});


describe("publication recheck", () => {
  const page = { id: "A".repeat(20), status: "failed", transport: "page-no-build-v1" };
  it("shows per-item pending and failed feedback without changing other rows", async () => {
    let finish!: (result: { success: true; queueId: string; outcome: "failed"; message: string }) => void;
    const onCheckAgain = vi.fn(() => new Promise<{ success: true; queueId: string; outcome: "failed"; message: string }>(resolve => { finish = resolve; }));
    render(<QueueList items={[page, { ...page, id: "B".repeat(20) }]} onCheckAgain={onCheckAgain} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Check again" })[0]);
    expect(screen.getByRole("button", { name: "Check again: Checking…" })).toHaveAttribute("aria-busy", "true");
    fireEvent.click(screen.getByRole("button", { name: "Check again: Checking…" }));
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Check again" })).not.toHaveAttribute("aria-busy");
    finish({ success: true, queueId: page.id, outcome: "failed", message: "The public copy is still unavailable. Retry publication." });
    expect(await screen.findByRole("alert")).toHaveTextContent("Retry publication.");
    expect(screen.getAllByText("Failed")).toHaveLength(2);
  });
  it("keeps network refusal feedback beside the original row", async () => {
    render(<QueueList items={[page]} onCheckAgain={async () => { throw new Error("Publish access required."); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Publish access required.");
    expect(screen.getByText("Failed")).toBeVisible();
  });
  it.each(["confirmed_late", "superseded"] as const)("announces the %s result", async outcome => {
    const message = outcome === "confirmed_late" ? "Publication confirmed on the public site." : "A newer publication is live.";
    render(<QueueList items={[page]} onCheckAgain={async () => ({ success: true, queueId: page.id, outcome, message })} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByText(message)).toBeVisible());
  });
  it("offers the explicit exhausted Post proof state and hides other settled or unsupported actions", () => {
    render(<QueueList items={[
      { ...page, transport: "post-no-build-v1", status: "success", proofRecovery: true },
      { ...page, id: "B".repeat(20), status: "success" },
      { ...page, id: "C".repeat(20), status: "pending" },
      { ...page, id: "D".repeat(20), transport: "serializer" },
    ]} onCheckAgain={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1);
    expect(screen.getByText("Public check failed")).toHaveClass("status-badge-failed");
    expect(screen.getByText(/This publication cannot be checked here/)).toBeVisible();
  });
  it("offers no publication mutation without the publish callback", () => {
    render(<QueueList items={[page]} />);
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
  });
});
