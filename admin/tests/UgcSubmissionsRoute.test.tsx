import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UgcSubmissionsRoute } from "../src/routes/UgcSubmissionsRoute";
import type { UgcSubmission } from "../src/lib/ugc-submissions";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), preview: vi.fn(), reject: vi.fn(), importSubmission: vi.fn(),
  getIdToken: vi.fn(async () => "token"),
  categoriesReady: true,
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ getIdToken: mocks.getIdToken }),
}));
vi.mock("../src/routes/ShellContext", () => ({
  useShell: () => ({ principal: { id: "reviewer", grants: [{ role: "admin" }] } }),
}));
vi.mock("../src/routes/RequireCapability", () => ({
  RequireCapability: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../src/lib/access", () => ({ canReviewUgcSubmissions: () => true }));
vi.mock("../src/lib/use-media-categories", async () => {
  const { useEffect, useState } = await import("react");
  return { useMediaCategories: () => {
    const [ready, setReady] = useState(mocks.categoriesReady);
    useEffect(() => {
      if (ready) return;
      const timer = setTimeout(() => setReady(true), 20);
      return () => clearTimeout(timer);
    }, [ready]);
    return { state: ready ? { status: "ready", categories: [
      { id: "general", label: "General", active: true, canUpload: true },
      { id: "news", label: "News", active: true, canUpload: true },
    ] } : { status: "loading", categories: [] } };
  } };
});
vi.mock("../src/lib/ugc-submissions", () => ({
  listUgcSubmissions: mocks.list,
  getUgcSubmissionPreview: mocks.preview,
  rejectUgcSubmission: mocks.reject,
  importUgcSubmission: mocks.importSubmission,
}));

const submission: UgcSubmission = {
  id: "11111111-1111-4111-8111-111111111111", name: "Submitter",
  message: "A public submission from the station.", consentVersion: "ugc-release-1",
  consentedAt: "2026-09-28T12:00:00Z", scopes: { broadcast: true, web: true, social: true },
  file: { name: "photo.png", type: "image/png", size: 100 }, status: "importing",
  staleDecision: true, decisionCategory: "general", createdAt: "2026-09-28T12:00:00Z",
};

function renderRoute() {
  return render(<MemoryRouter><UgcSubmissionsRoute /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.categoriesReady = true;
  mocks.list.mockResolvedValue({ success: true, records: [submission], nextCursor: null });
  mocks.reject.mockRejectedValue(new Error("Quarantine delete failed"));
  mocks.importSubmission.mockResolvedValue({ success: true, status: "imported",
    asset: { kind: "image", id: submission.id } });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

describe("UGC submissions route", () => {
  it("keeps the review warning and lets staff filter and refresh from one control group", async () => {
    mocks.list.mockImplementation(async (_token: string, status: string) => ({
      success: true, records: status === "pending" ? [] : [submission], nextCursor: null,
    }));
    renderRoute();
    expect(screen.getByText(/Check the release and file before adding it/)).toBeVisible();
    expect(await screen.findByText("No submissions")).toBeVisible();
    const controls = screen.getByRole("group", { name: "Submission controls" });
    fireEvent.change(within(controls).getByRole("combobox", { name: "Status" }), { target: { value: "imported" } });
    expect(await screen.findByRole("button", { name: /Submitter/ })).toBeVisible();
    const callsBeforeRefresh = mocks.list.mock.calls.length;
    fireEvent.click(within(controls).getByRole("button", { name: "Refresh submissions" }));
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(callsBeforeRefresh));
    expect(mocks.list).toHaveBeenLastCalledWith("token", "imported");
  });

  it("keeps a failed rejection error in the open dialog and focuses it", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /^Reject$/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject submission" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Quarantine delete failed");
    expect(dialog).toHaveProperty("open", true);
    expect(alert.parentElement).toHaveFocus();
  });

  it("allows a stale import to select another category", async () => {
    renderRoute();
    fireEvent.change(await screen.findByLabelText("Import category"), {
      target: { value: "news" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resume import" }));
    await waitFor(() => expect(mocks.importSubmission)
      .toHaveBeenCalledWith("token", submission.id, "news"));
  });

  it("shows the category when a stale rejection can be changed to import", async () => {
    mocks.list.mockResolvedValue({ success: true, records: [{ ...submission,
      status: "rejecting" }], nextCursor: null });
    renderRoute();
    expect(await screen.findByLabelText("Import category")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
  });

  it("preselects the recorded category for a stale video import", async () => {
    mocks.categoriesReady = false;
    mocks.list.mockResolvedValue({ success: true, records: [{ ...submission,
      file: { name: "clip.mp4", type: "video/mp4", size: 100 },
      decisionCategory: "news" }], nextCursor: null });
    renderRoute();
    await waitFor(() => expect(screen.getByLabelText("Import category"))
      .toHaveValue("news"));
    fireEvent.click(screen.getByRole("button", { name: "Resume import" }));
    await waitFor(() => expect(mocks.importSubmission)
      .toHaveBeenCalledWith("token", submission.id, "news"));
  });
});
