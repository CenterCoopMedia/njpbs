import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportProgressSteps } from "../src/components/ReportProgressSteps";
import type { BugReportProgress } from "../src/lib/functions";
const base: BugReportProgress = { phase: "received", label: "Received", detail: "Saved", active: true, updatedAt: null, lastSyncedAt: null, syncState: "not_linked", issues: [], pullRequests: [], deployment: "unverified" };
describe("evidence-based progress sequence", () => {
  it.each([ ["queued", "Work queued"], ["acknowledged", "Acknowledged"], ["reopened", "Reopened"], ["blocked", "Blocked"] ] as const)("keeps %s distinct from an investigation starting", (phase, label) => {
    const view = render(<ReportProgressSteps progress={{ ...base, phase, label }} />);
    expect(view.container.querySelector('[aria-current="step"]')).toHaveTextContent(label);
    const fixing = screen.getByText("Fix in progress").closest("li")!;
    expect(within(fixing).getByText(/Not confirmed/)).toBeInTheDocument();
  });
  it("shows merged code awaiting live verification without inventing completed review or release", () => {
    const view = render(<ReportProgressSteps progress={{ ...base, phase: "merged", label: "Merged; live verification pending" }} />);
    expect(view.container.querySelector('[aria-current="step"]')).toHaveTextContent("Merged; live verification pending");
    expect(screen.getByText("Fix in review").closest("li")).toHaveAttribute("data-state", "ahead");
    expect(screen.getByText("Fix released").closest("li")).toHaveAttribute("data-state", "ahead");
  });
  it("keeps administrative closure separate from evidence that a fix was released", () => {
    render(<ReportProgressSteps progress={{ ...base, phase: "dismissed", label: "Closed", active: false }} />);
    expect(screen.queryByText("Fix released")).not.toBeInTheDocument();
    expect(screen.getByText("Closed").closest("li")).toHaveAttribute("data-state", "done");
    expect(screen.getByText("Fix in review").closest("li")).toHaveAttribute("data-state", "ahead");
  });
});
