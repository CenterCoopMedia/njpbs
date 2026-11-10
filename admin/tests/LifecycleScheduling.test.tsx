import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { LifecycleActionsPanel } from "../src/components/LifecycleActionsPanel";
import { WorkspaceActionsProvider } from "../src/components/WorkspaceActions";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";

const props = {
  collection: "cmsPosts" as const, documentId: "post-1", baseVersion: 6,
  canPublish: true, canArchive: false, canRestore: false, canUnpublish: false,
  publicationSupported: true, status: "approved",
};
function openSchedule() {
  fireEvent.click(screen.getByRole("button", { name: "Schedule publish" }));
  return screen.getByLabelText("Publication time (New York)");
}

describe("Scheduling a post", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-16T12:00:00Z")));
  afterEach(() => vi.restoreAllMocks());

  it("keeps Publish and Schedule publish together and reveals the form outside a hidden inspector", () => {
    const actions = document.createElement("div");
    const secondary = document.createElement("div");
    const feedback = document.createElement("div");
    document.body.append(actions, secondary, feedback);
    const view = render(<WorkspaceActionsProvider target={actions} secondaryTarget={secondary} feedbackTarget={feedback}>
      <div hidden><LifecycleActionsPanel {...props} workspaceActions onPublish={vi.fn()} onSchedule={vi.fn()} /></div>
    </WorkspaceActionsProvider>);
    try {
      expect(within(actions).getByRole("button", { name: "Publish" })).toBeEnabled();
      expect(within(actions).getByRole("button", { name: "Schedule publish" })).toBeEnabled();
      expect(within(secondary).queryByRole("button", { name: "Schedule publish" })).toBeNull();
      const input = openSchedule();
      expect(input).toBeVisible();
      expect(input).toHaveFocus();
      expect(feedback).toContainElement(input);
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByLabelText("Publication time (New York)")).toBeNull();
      expect(within(actions).getByRole("button", { name: "Schedule publish" })).toHaveFocus();
    } finally { view.unmount(); actions.remove(); secondary.remove(); feedback.remove(); }
  });

  it.each(["draft", "in_review", "approved"])("lets a publisher schedule the saved %s version without review", async status => {
    const schedule = vi.fn(async (_baseVersion: number, _scheduleAt: string) => ({ document: { status: "scheduled", version: 7 } }));
    const changed = vi.fn();
    render(<LifecycleActionsPanel {...props} status={status} onPublish={vi.fn()} onSchedule={schedule} onChanged={changed} />);
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Schedule publish" })).toBeEnabled();
    fireEvent.change(openSchedule(), { target: { value: "2026-10-17T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm schedule" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Publication scheduled"));
    expect(schedule).toHaveBeenCalledOnce();
    // The request fields stay exact when the callback also receives progress reporting.
    const [baseVersion, scheduleAt] = schedule.mock.calls[0];
    expect({ baseVersion, scheduleAt }).toEqual({ baseVersion: 6, scheduleAt: "2026-10-17T14:00:00.000Z" });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ status: "scheduled", version: 7 });
    expect(screen.getByRole("status")).toHaveTextContent("Oct 17, 2026, 10:00 AM EDT");
    expect(screen.queryByLabelText("Publication time (New York)")).toBeNull();
  });

  it("keeps a Writer on the review path without publication actions", () => {
    const schedule = vi.fn();
    render(<LifecycleActionsPanel {...props} status="draft" canPublish={false} canEdit
      onTransition={vi.fn()} onPublish={vi.fn()} onSchedule={schedule} />);
    expect(screen.getByRole("button", { name: "Submit for review" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Schedule publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Publish$/ })).toBeNull();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("preserves unsaved-change locks", () => {
    render(<LifecycleActionsPanel {...props} disabledReason="Save your changes first." onPublish={vi.fn()} onSchedule={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Schedule publish" })).toBeDisabled();
    expect(screen.getByText("Save your changes first.")).toBeVisible();
  });

  it.each(["2026-10-15T12:00", "2026-11-17T12:00"])("blocks an out-of-range date %s before the request", local => {
    const schedule = vi.fn();
    render(<LifecycleActionsPanel {...props} onPublish={vi.fn()} onSchedule={schedule} />);
    fireEvent.change(openSchedule(), { target: { value: local } });
    expect(screen.getByLabelText("Publication time (New York)")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Confirm schedule" })).toBeDisabled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("rejects a nonexistent spring time without changing the selected time", () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2027-03-01T12:00:00Z"));
    render(<LifecycleActionsPanel {...props} onSchedule={vi.fn()} />);
    const input = openSchedule();
    fireEvent.change(input, { target: { value: "2027-03-14T02:30" } });
    expect(input).toHaveValue("2027-03-14T02:30");
    expect(screen.getByText(/does not exist in New York/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm schedule" })).toBeDisabled();
  });

  it("requires the fall-hour occurrence and submits its exact UTC instant", async () => {
    const schedule = vi.fn(async () => ({ document: { status: "scheduled", version: 7 } }));
    render(<LifecycleActionsPanel {...props} onSchedule={schedule} />);
    fireEvent.change(openSchedule(), { target: { value: "2026-11-01T01:30" } });
    expect(screen.getByRole("button", { name: "Confirm schedule" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Which occurrence?"), { target: { value: "2026-11-01T06:30:00.000Z" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm schedule" }));
    await waitFor(() => expect(schedule).toHaveBeenCalledWith(6, "2026-11-01T06:30:00.000Z", expect.any(Function)));
    expect(screen.getByRole("status")).toHaveTextContent("1:30 AM EST");
  });

  it("resets the occurrence choice when the date changes and permits the second occurrence after the first", () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-11-01T05:45:00Z"));
    render(<LifecycleActionsPanel {...props} onSchedule={vi.fn()} />);
    const input = openSchedule();
    expect(input).toHaveAttribute("min", "2026-11-01T00:00");
    fireEvent.change(input, { target: { value: "2026-11-01T01:15" } });
    fireEvent.change(screen.getByLabelText("Which occurrence?"), { target: { value: "2026-11-01T06:15:00.000Z" } });
    expect(screen.getByRole("button", { name: "Confirm schedule" })).toBeEnabled();
    fireEvent.change(input, { target: { value: "2026-11-01T01:30" } });
    expect(screen.getByLabelText("Which occurrence?")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Confirm schedule" })).toBeDisabled();
  });

  it("revalidates an expired time at confirmation", async () => {
    const schedule = vi.fn();
    render(<LifecycleActionsPanel {...props} onSchedule={schedule} />);
    fireEvent.change(openSchedule(), { target: { value: "2026-10-16T08:01" } });
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-16T12:02:00Z"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm schedule" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/must be in the future/));
    expect(schedule).not.toHaveBeenCalled();
  });

  it("does not let the native upper bound exclude a valid first fall occurrence", () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-01T05:30:00Z"));
    render(<LifecycleActionsPanel {...props} onSchedule={vi.fn()} />);
    const input = openSchedule();
    expect(input).toHaveAttribute("max", "2026-11-01T23:59");
    fireEvent.change(input, { target: { value: "2026-11-01T01:45" } });
    fireEvent.change(screen.getByLabelText("Which occurrence?"), { target: { value: "2026-11-01T05:45:00.000Z" } });
    expect(screen.getByRole("button", { name: "Confirm schedule" })).toBeEnabled();
  });

  it("retains the selected time after a server error and blocks duplicate requests", async () => {
    let reject!: (reason: Error) => void;
    const schedule = vi.fn(() => new Promise<never>((_resolve, rejectRequest) => { reject = rejectRequest; }));
    render(<LifecycleActionsPanel {...props} onSchedule={schedule} />);
    const input = openSchedule();
    fireEvent.change(input, { target: { value: "2026-10-17T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm schedule" }));
    fireEvent.click(screen.getByRole("button", { name: /^.+: Applying action…$/ }));
    expect(schedule).toHaveBeenCalledOnce();
    expect(input).toBeDisabled();
    await act(async () => reject(new Error("This version changed. Reload content.")));
    expect(input).toHaveValue("2026-10-17T10:00");
    expect(screen.getByRole("alert")).toHaveTextContent("This version changed.");
  });

  it("keeps the New York receipt through reload and displays the persisted schedule", async () => {
    function Editor() {
      const [saved, setSaved] = useState(false);
      return <SuccessNoticeProvider routeKey="post-1">
        <LifecycleActionsPanel {...props} status={saved ? "scheduled" : "approved"}
          baseVersion={saved ? 7 : 6} scheduledAt={saved ? "2026-10-17T14:00:00.000Z" : undefined}
          onSchedule={async () => ({ document: { status: "scheduled" } })} onChanged={() => setSaved(true)} />
      </SuccessNoticeProvider>;
    }
    render(<Editor />);
    fireEvent.change(openSchedule(), { target: { value: "2026-10-17T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm schedule" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent("Oct 17, 2026, 10:00 AM EDT"));
    expect(screen.getByText(/Cancel scheduled publication to change the time/)).toHaveTextContent("Oct 17, 2026, 10:00 AM EDT");
  });
});
