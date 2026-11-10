import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../src/App";

const mocks = vi.hoisted(() => ({
  loadDialog: vi.fn(),
  requestAccess: vi.fn(async () => ({ request: { state: "pending" } })),
  signOut: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    state: {
      status: "signed-in",
      user: { uid: "limited-editor", email: "editor@example.org" },
      principal: { id: "limited-editor", grants: [{ role: "editor", sections: [] }] },
    },
    getIdToken: async () => "fixture-token",
    requestAccess: mocks.requestAccess,
    signOut: mocks.signOut,
  }),
}));

vi.mock("../src/lib/functions", () => ({
  getStaffAccessStatus: async () => ({ request: { state: "not_requested" } }),
}));

// Isolate the access screen's dynamic import from the shell's static consumer.
vi.mock("../src/routes/buildRoutes", () => ({ buildRoutes: () => [{ path: "/", element: null }] }));
vi.mock("../src/routes/routeModules", () => ({ preloadInitialRoute: async () => undefined }));
vi.mock("../src/components/ReportProblemDialog", () => {
  mocks.loadDialog();
  throw new Error("Failed to fetch dynamically imported module: report-dialog.js");
});

describe("limited staff access screen", () => {
  it("keeps access requests and sign out working after the report dialog chunk rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<App />);
      await waitFor(() => expect(mocks.loadDialog).toHaveBeenCalled());
      expect(await screen.findByRole("heading", { name: "Request staff access" })).toBeVisible();
      fireEvent.change(screen.getByLabelText("Why do you need access?"), {
        target: { value: "Please restore my Station editing access." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Request access" }));
      await waitFor(() => expect(mocks.requestAccess).toHaveBeenCalledWith("Please restore my Station editing access."));
      expect(await screen.findByRole("heading", { name: "Your request is waiting for an administrator" })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      expect(mocks.signOut).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });
});
