import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportNudge } from "../src/components/ReportNudge";
import type { BugReportNudge } from "../src/lib/functions";
const state: BugReportNudge = { version: 1, eligible: true, eligibleAt: "2026-10-04T00:00:00Z", progressAt: "2026-10-01T00:00:00Z", requestedAt: null, history: [], historyTruncated: false };
describe("reporter nudge feedback", () => {
  it("presents shared pending/error state and retains result focus after the action", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const view = render(<ReportNudge state={state} label="Clip report" action={{ pending: true, error: null }} onNudge={action} />);
    const button = screen.getByRole("button", { name: "Nudge for Clip report" });
    expect(button).toBeDisabled(); fireEvent.click(button); expect(action).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Queuing your follow-up request");
    view.rerender(<ReportNudge state={state} label="Clip report" action={{ pending: false, error: "Temporary failure", version: state.version }} onNudge={action} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Use Nudge to retry");
    fireEvent.click(button); await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
    expect(action).toHaveBeenCalledOnce();
  });
  it("distinguishes queued, sent and unconfirmed requests without claiming work started", () => {
    const entry = { requestedAt: "2026-10-05T00:00:00Z", delivery: "pending" as const, decision: null, decidedAt: null };
    const view = render(<ReportNudge state={{ ...state, eligible: false, history: [entry] }} label="Clip report" onNudge={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Nudge queued");
    expect(screen.queryByRole("button", { name: /Nudge for/ })).not.toBeInTheDocument();
    view.rerender(<ReportNudge state={{ ...state, eligible: false, history: [{ ...entry, delivery: "unknown" }] }} label="Clip report" onNudge={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("delivery is unconfirmed");
    view.rerender(<ReportNudge state={{ ...state, eligible: false, history: [{ ...entry, delivery: "delivered", decision: "approved" }] }} label="Clip report" onNudge={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Nudge sent");
    expect(screen.getByRole("status")).toHaveTextContent("Follow-up approved and requested");
    expect(screen.queryByText(/investigation started/i)).not.toBeInTheDocument();
  });
});
