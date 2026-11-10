import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportProblemDialog } from "../src/components/ReportProblemDialog";
import { adminPerf, PERF_MEASURES } from "../src/lib/perf-receipts";

const mocks = vi.hoisted(() => ({
  cmsSubmitBugReport: vi.fn(),
  getConsoleLogs: vi.fn(() => [{
    level: "error" as const,
    message: "Save request failed",
    timestamp: "2026-08-28T20:29:55.000Z",
  }]),
}));
vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsSubmitBugReport: mocks.cmsSubmitBugReport,
}));
vi.mock("../src/lib/console-capture", () => ({
  getConsoleLogs: mocks.getConsoleLogs,
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.cmsSubmitBugReport.mockResolvedValue({
    success: true,
    created: true,
    report: { id: `br_${"a".repeat(32)}` },
  });
});

describe("ReportProblemDialog", () => {
  it("keeps an outdated Admin refusal in the dialog without a success receipt", async () => {
    mocks.cmsSubmitBugReport.mockRejectedValue(new Error("This Boardwalk version is out of date. Reload Boardwalk to send your report."));
    render(<MemoryRouter><ReportProblemDialog currentPath="/guide" getIdToken={async () => "id-token"} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    fireEvent.change(screen.getByLabelText("Tell us what happened"), { target: { value: "The guide did not open." } });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reload Boardwalk to send your report.");
    expect(screen.queryByText("Report received")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open this report" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Tell us what happened")).toHaveValue("The guide did not open.");
  });

  it("announces a trusted dev stored-only receipt without promising email or linking unavailable detail", async () => {
    mocks.cmsSubmitBugReport.mockResolvedValue({ success: true, report: {
      id: `br_${"a".repeat(32)}`, environment: { deploymentEnvironment: "development" },
    } });
    render(<MemoryRouter><ReportProblemDialog currentPath="/guide" getIdToken={async () => "id-token"} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    fireEvent.change(screen.getByLabelText("Tell us what happened"), { target: { value: "The guide did not open." } });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Report received")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("No confirmation email or updates will be sent.");
    expect(screen.queryByRole("link", { name: "Open this report" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close problem report" })).toHaveFocus();
  });

  it("files from the current route without navigation and returns the durable ID", async () => {
    const requestId = "abcdef00-0000-4000-8000-000000000001";
    const receipt = adminPerf.receipt();
    receipt.measures = [{ name: PERF_MEASURES.cmsTransport, durationMs: 25, detail: { requestId } }];
    vi.spyOn(adminPerf, "receipt").mockReturnValue(receipt);
    const getIdToken = vi.fn(async () => "id-token");
    render(
      <MemoryRouter>
        <ReportProblemDialog
          currentPath="/content/post/post-7/edit"
          getIdToken={getIdToken}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("open");
    fireEvent.change(screen.getByLabelText("What were you trying to do?"), {
      target: { value: "Update the headline" },
    });
    fireEvent.change(screen.getByLabelText("Tell us what happened"), {
      target: { value: "The save stopped" },
    });
    fireEvent.change(screen.getByLabelText("What did you expect?"), {
      target: { value: "The draft should save" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByText("Report received")).toBeVisible();
    expect(screen.getByText(`br_${"a".repeat(32)}`)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(/email/i);
    expect(screen.getByRole("link", { name: "Open this report" })).toBeVisible();
    expect(getIdToken).toHaveBeenCalledTimes(1);
    expect(mocks.cmsSubmitBugReport).toHaveBeenCalledWith(
      "id-token",
      expect.objectContaining({
        tryingToDo: "Update the headline",
        route: "/content/post/post-7/edit",
        affectedRecord: { kind: "post", id: "post-7" },
        correlationIds: [requestId],
        consoleLogs: [{
          level: "error",
          message: "Save request failed",
          timestamp: "2026-08-28T20:29:55.000Z",
        }],
      }),
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
      null,
    );
  });

  it("rejects an oversized screenshot before sending", async () => {
    render(
      <MemoryRouter>
        <ReportProblemDialog currentPath="/media" getIdToken={async () => "id-token"} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    const screenshot = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "screen.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText(/Screenshot/), {
      target: { files: [screenshot] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/no larger than 5 MiB/i);
    expect(mocks.cmsSubmitBugReport).not.toHaveBeenCalled();
  });

  it("reuses the request ID when a submission is retried", async () => {
    mocks.cmsSubmitBugReport
      .mockRejectedValueOnce(new Error("The response was lost."))
      .mockResolvedValueOnce({
        success: true,
        created: false,
        report: { id: `br_${"a".repeat(32)}` },
      });
    render(
      <MemoryRouter>
        <ReportProblemDialog currentPath="/media" getIdToken={async () => "id-token"} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    fireEvent.change(screen.getByLabelText("What were you trying to do?"), {
      target: { value: "Upload an image" },
    });
    fireEvent.change(screen.getByLabelText("Tell us what happened"), {
      target: { value: "The response was lost" },
    });
    fireEvent.change(screen.getByLabelText("What did you expect?"), {
      target: { value: "The report should finish" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The response was lost.");
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByText("Report received")).toBeVisible();
    expect(mocks.cmsSubmitBugReport).toHaveBeenCalledTimes(2);
    expect(mocks.cmsSubmitBugReport.mock.calls[1][2]).toBe(
      mocks.cmsSubmitBugReport.mock.calls[0][2],
    );
  });

  it("does not attach a submitted screenshot to the next report", async () => {
    render(
      <MemoryRouter>
        <ReportProblemDialog currentPath="/media" getIdToken={async () => "id-token"} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    fireEvent.change(screen.getByLabelText("What were you trying to do?"), {
      target: { value: "Upload an image" },
    });
    fireEvent.change(screen.getByLabelText("Tell us what happened"), {
      target: { value: "The upload stopped" },
    });
    fireEvent.change(screen.getByLabelText("What did you expect?"), {
      target: { value: "The image should upload" },
    });
    const screenshot = new File(["image"], "screen.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Screenshot/), {
      target: { files: [screenshot] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Report received")).toBeVisible();
    expect(mocks.cmsSubmitBugReport.mock.calls[0][3]).toBe(screenshot);

    fireEvent.click(screen.getByRole("button", { name: "Close problem report" }));
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    fireEvent.change(await screen.findByLabelText("What were you trying to do?"), {
      target: { value: "Upload another image" },
    });
    fireEvent.change(screen.getByLabelText("Tell us what happened"), {
      target: { value: "The second upload stopped" },
    });
    fireEvent.change(screen.getByLabelText("What did you expect?"), {
      target: { value: "The second image should upload" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() => expect(mocks.cmsSubmitBugReport).toHaveBeenCalledTimes(2));
    expect(mocks.cmsSubmitBugReport.mock.calls[1][3]).toBeNull();
  });
});


it("submits the public-style staff form with diagnostics and a screenshot", async () => {
  render(<MemoryRouter><ReportProblemDialog currentPath="/content/post/post-7/edit" getIdToken={async () => "id-token"} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
  fireEvent.click(screen.getByLabelText("Suggestion"));
  fireEvent.change(screen.getByLabelText("Tell us what happened"), { target: { value: "Make the editor controls easier to find." } });
  const screenshot = new File(["image fixture"], "screen.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText(/Screenshot/), { target: { files: [screenshot] } });
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  await waitFor(() => expect(mocks.cmsSubmitBugReport).toHaveBeenCalled());
  const [token, report, requestId, upload] = mocks.cmsSubmitBugReport.mock.calls[0];
  expect(token).toBe("id-token");
  expect(report).toMatchObject({ category: "suggestion", happened: "Make the editor controls easier to find.", tryingToDo: "", expected: "" });
  expect(report.clientContext.diagnostics).toHaveProperty("recentRequests");
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(upload).toBe(screenshot);
});


it("resets the category when reopening a canceled report", () => {
  render(<MemoryRouter><ReportProblemDialog currentPath="/media" /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
  fireEvent.click(screen.getByLabelText("Question"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
  expect(screen.getByLabelText("Bug or error")).toBeChecked();
});

it("returns a limited-staff receipt outside the router without an inaccessible detail link", async () => {
  render(<ReportProblemDialog currentPath="/reports" getIdToken={async () => "id-token"} canOpenReport={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
  fireEvent.change(screen.getByLabelText("Tell us what happened"), { target: { value: "The staff account cannot open its workspace." } });
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  expect(await screen.findByText("Report received")).toBeVisible();
  expect(screen.getByText(`br_${"a".repeat(32)}`)).toBeVisible();
  expect(screen.queryByRole("link", { name: "Open this report" })).not.toBeInTheDocument();
});
