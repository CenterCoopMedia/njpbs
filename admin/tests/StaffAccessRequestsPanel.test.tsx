import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffAccessRequestsPanel } from "../src/components/StaffAccessRequestsPanel";

const authMocks = vi.hoisted(() => ({ getIdToken: vi.fn() }));
const functionMocks = vi.hoisted(() => ({
  listStaffAccessRequests: vi.fn(),
  decideStaffAccessRequest: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ getIdToken: authMocks.getIdToken }),
}));

vi.mock("../src/lib/functions", () => ({
  listStaffAccessRequests: functionMocks.listStaffAccessRequests,
  decideStaffAccessRequest: functionMocks.decideStaffAccessRequest,
}));

const request = {
  uid: "requester-1",
  email: "person@example.org",
  displayName: "Person Example",
  reason: "I edit the program schedule.",
  requestVersion: 3,
  reference: "NJPBS-USER-3",
  requestedAt: "2026-08-18T18:00:00.000Z",
  state: "pending" as const,
};

describe("StaffAccessRequestsPanel", () => {
  afterEach(() => {
    vi.clearAllMocks();
    authMocks.getIdToken.mockReset();
    functionMocks.listStaffAccessRequests.mockReset();
    functionMocks.decideStaffAccessRequest.mockReset();
  });

  it("defaults to staff guide access and offers no admin role", async () => {
    authMocks.getIdToken.mockResolvedValue("joe-token");
    functionMocks.listStaffAccessRequests.mockResolvedValue({
      success: true,
      requests: [request],
    });

    render(<StaffAccessRequestsPanel />);

    expect(await screen.findByText("person@example.org")).toBeVisible();
    const role = screen.getByLabelText("Approved role");
    expect(role).toHaveValue("staff");
    expect(screen.getByRole("option", { name: /Viewer/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /Writer/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /Editor/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /Manager|Site owner/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Person Example", level: 3 })).toBeVisible();
    fireEvent.click(screen.getByText("Can and cannot"));
    const explanation = screen.getByRole("heading", { name: "Viewer", level: 4 }).parentElement!;
    expect(explanation.tagName).toBe("DIV");
    expect(screen.queryByRole("region", { name: "Viewer permissions" })).not.toBeInTheDocument();
    expect(within(explanation).getByRole("heading", { name: "Can", level: 5 })).toBeVisible();
    expect(within(explanation).getByRole("heading", { name: "Cannot", level: 5 })).toBeVisible();
  });

  it("does not report zero requests when the initial queue load fails", async () => {
    authMocks.getIdToken.mockResolvedValue("joe-token");
    functionMocks.listStaffAccessRequests.mockRejectedValue(
      new Error("Queue read failed"),
    );

    render(<StaffAccessRequestsPanel />);

    expect(await screen.findByText("Queue unavailable")).toBeVisible();
    expect(screen.queryByText("0 pending")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No account requests need a decision."),
    ).not.toBeInTheDocument();
  });

  it("requires confirmation and sends the selected editor role", async () => {
    authMocks.getIdToken.mockResolvedValue("joe-token");
    functionMocks.listStaffAccessRequests.mockResolvedValue({
      success: true,
      requests: [request],
    });
    functionMocks.decideStaffAccessRequest.mockResolvedValue({ success: true });

    render(<StaffAccessRequestsPanel />);
    fireEvent.change(await screen.findByLabelText("Approved role"), {
      target: { value: "editor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review approval" }));

    expect(functionMocks.decideStaffAccessRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve account" }));

    await waitFor(() =>
      expect(functionMocks.decideStaffAccessRequest).toHaveBeenCalledWith(
        "joe-token",
        {
          targetUid: "requester-1",
          requestVersion: 3,
          decision: "approve",
          role: "editor",
        },
      ),
    );
    expect(
      await screen.findByText("person@example.org now has Editor access."),
    ).toBeVisible();
  });

  it("rejects without sending a role", async () => {
    authMocks.getIdToken.mockResolvedValue("joe-token");
    functionMocks.listStaffAccessRequests.mockResolvedValue({
      success: true,
      requests: [request],
    });
    functionMocks.decideStaffAccessRequest.mockResolvedValue({ success: true });

    render(<StaffAccessRequestsPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Review rejection" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reject account" }));

    await waitFor(() =>
      expect(functionMocks.decideStaffAccessRequest).toHaveBeenCalledWith(
        "joe-token",
        {
          targetUid: "requester-1",
          requestVersion: 3,
          decision: "deny",
        },
      ),
    );
  });
});
