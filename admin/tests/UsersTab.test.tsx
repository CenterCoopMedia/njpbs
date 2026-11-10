import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsersTab } from "../src/components/UsersTab";

const firestoreMocks = vi.hoisted(() => ({
  collection: vi.fn((database: unknown, path: string) => ({ database, path })),
  onSnapshot: vi.fn(),
  unsubscribe: vi.fn(),
  testDb: { name: "test-db" },
}));

const authMocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
}));

const functionMocks = vi.hoisted(() => ({
  deactivateStaff: vi.fn(),
  grantRole: vi.fn(),
  revokeRole: vi.fn(),
  setStaffAccessLevel: vi.fn(),
}));

const activationMocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/lib/access-tier-activation", () => ({ accessTierReadsActive: activationMocks.read }));

vi.mock("firebase/firestore", () => ({
  collection: firestoreMocks.collection,
  query: (ref: object, ...constraints: unknown[]) => ({ ...ref, constraints }),
  limit: (count: number) => ({ limit: count }),
  onSnapshot: firestoreMocks.onSnapshot,
}));

vi.mock("../src/lib/firebase", () => ({
  db: firestoreMocks.testDb,
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    getIdToken: authMocks.getIdToken,
    state: {
      status: "signed-in",
      user: { uid: "current-user" },
    },
  }),
}));

vi.mock("../src/lib/functions", () => ({
  deactivateStaff: functionMocks.deactivateStaff,
  grantRole: functionMocks.grantRole,
  revokeRole: functionMocks.revokeRole,
  setStaffAccessLevel: functionMocks.setStaffAccessLevel,
}));

function userSnapshot() {
  return {
    docs: [
      {
        id: "staff-1",
        data: () => ({
          email: "staff@example.com",
          displayName: "Staff Member",
          role: "admin",
          grants: [],
        }),
      },
    ],
  };
}

function emptyUserSnapshot() {
  return { docs: [] };
}

function sectionSnapshot(
  entries = [{ id: "watch", label: "Watch", description: "Watch pages.", order: 1 }],
) {
  return {
    docs: entries.map(({ id, ...data }) => ({ id, data: () => data })),
  };
}

// The tab holds two independent subscriptions now: the staff roster and the section
// registry. Route each one by collection path so a roster assertion cannot be satisfied
// by a registry call, and vice versa.
function subscribeByPath(handlers: {
  users?: (next: (value: unknown) => void, error: (value: Error) => void) => void;
  sections?: (next: (value: unknown) => void, error: (value: Error) => void) => void;
}) {
  firestoreMocks.onSnapshot.mockImplementation(
    (ref: { path: string }, next: (value: unknown) => void, error: (value: Error) => void) => {
      const handler = ref.path === "sections" ? handlers.sections : handlers.users;
      handler?.(next, error);
      return firestoreMocks.unsubscribe;
    },
  );
}

function userSubscriptionCount() {
  return firestoreMocks.onSnapshot.mock.calls.filter(
    (call) => (call[0] as { path: string }).path === "users",
  ).length;
}

describe("UsersTab", () => {
  it("projects server offboarding progress through the existing roster", async () => {
    activationMocks.read.mockResolvedValue(true);
    subscribeByPath({ users: (next) => next({ docs: [{ id: "staff-1", data: () => ({
      email: "staff@example.test", displayName: "Staff Member", active: false,
      offboarding: { id: "operation", step: "sign_in_and_sessions" },
    }) }] }), sections: (next) => next(sectionSnapshot()) });
    render(<UsersTab canManage />);
    expect(await screen.findByRole("button", { name: "Retry offboarding for Staff Member" })).toBeVisible();
    expect(screen.getByText("Finish disabling sign-in and revoking sessions.")).toBeVisible();
    expect(userSubscriptionCount()).toBe(1);
  });
  beforeEach(() => { activationMocks.read.mockReset().mockResolvedValue(false); });
  it("shows whole-site controls to a legacy Owner after a server-confirmed activation", async () => {
    activationMocks.read.mockResolvedValue(true);
    subscribeByPath({ users: (next) => next(userSnapshot()), sections: (next) => next(sectionSnapshot()) });
    authMocks.getIdToken.mockResolvedValue("synthetic-token");
    functionMocks.setStaffAccessLevel.mockResolvedValue({ success: true });
    render(<UsersTab canManage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit access level for Staff Member" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Access level for Staff Member" }), { target: { value: "publisher" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm level for Staff Member" }));
    await waitFor(() => expect(functionMocks.setStaffAccessLevel).toHaveBeenCalledWith("synthetic-token", {
      targetUid: "staff-1", accessTier: "publisher", expectedAccess: JSON.stringify({ tierPresent: false, accessTier: null, role: "admin", grants: [], active: true }),
    }));
  });
  it("hides all access controls if activation verification fails, and can retry", async () => {
    activationMocks.read.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(false);
    subscribeByPath({ users: (next) => next(userSnapshot()), sections: (next) => next(sectionSnapshot()) });
    render(<UsersTab canManage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Staff access could not be verified");
    expect(screen.queryByRole("table", { name: "Staff access" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try loading staff accounts again" }));
    expect(await screen.findByRole("button", { name: "Manage access for staff@example.com" })).toBeVisible();
  });
  it("reports an oversized staff directory without presenting partial accounts", async () => {
    subscribeByPath({ users: (next) => next({ docs: Array.from({ length: 501 }, (_, index) =>
      ({ id: `staff-${index}`, data: () => ({ email: `staff-${index}@example.test` }) })) }),
      sections: (next) => next(sectionSnapshot()) });
    const view = render(<UsersTab canManage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("exceeds its read limit");
    expect(screen.queryByText("staff-0@example.test")).not.toBeInTheDocument();
    view.unmount();
  });
  afterEach(() => {
    vi.clearAllMocks();
    firestoreMocks.onSnapshot.mockReset();
    authMocks.getIdToken.mockReset();
    functionMocks.deactivateStaff.mockReset();
    functionMocks.grantRole.mockReset();
    functionMocks.revokeRole.mockReset();
  });

  it("retries a staff-list failure without presenting an empty directory", async () => {
    let userAttempts = 0;
    subscribeByPath({
      users: (next, error) => {
        userAttempts += 1;
        if (userAttempts === 1) error(new Error("offline"));
        else next(userSnapshot());
      },
      sections: (next) => next(sectionSnapshot()),
    });

    render(<UsersTab canManage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Staff directory could not be loaded",
    );
    expect(screen.queryByText("No staff accounts found")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Try loading staff accounts again" }),
    );

    await waitFor(() => expect(userSubscriptionCount()).toBe(2));
    expect(await screen.findByText("staff@example.com")).toBeVisible();
    expect(firestoreMocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps a role-update error distinct while leaving the directory visible", async () => {
    firestoreMocks.onSnapshot.mockImplementation((_ref, next) => {
      next(userSnapshot());
      return firestoreMocks.unsubscribe;
    });
    authMocks.getIdToken.mockResolvedValue("token");
    functionMocks.grantRole.mockRejectedValue(new Error("Role service unavailable"));

    render(<UsersTab canManage />);
    expect(await screen.findByText("staff@example.com")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Manage access for staff@example.com" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Grant Site owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm grant" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Access for staff@example.com could not be updated",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Role service unavailable");
    expect(screen.getByText("staff@example.com")).toBeVisible();
  });

  it("authenticates a confirmed deactivation", async () => {
    firestoreMocks.onSnapshot.mockImplementation((_ref, next) => {
      next(userSnapshot());
      return firestoreMocks.unsubscribe;
    });
    authMocks.getIdToken.mockResolvedValue("token");
    functionMocks.deactivateStaff.mockResolvedValue({
      success: true,
      uid: "staff-1",
      alreadyInactive: false,
      authUserMissing: false,
    });

    render(<UsersTab canManage />);

    expect(await screen.findByText("staff@example.com")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Manage access for staff@example.com" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Deactivate account" }));
    fireEvent.click(screen.getByRole("button", { name: "Deactivate staff account" }));

    await waitFor(() =>
      expect(functionMocks.deactivateStaff).toHaveBeenCalledWith("token", "staff-1"),
    );
  });

  it("does not contain the removed manual account setup form", async () => {
    firestoreMocks.onSnapshot.mockImplementation((_ref, next) => {
      next(emptyUserSnapshot());
      return firestoreMocks.unsubscribe;
    });

    render(<UsersTab canManage />);

    expect(await screen.findByText("No staff accounts found")).toBeVisible();
    expect(screen.queryByLabelText("Staff Google email")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Review admin access" }),
    ).not.toBeInTheDocument();
  });
  it("offers the registry sections as the scoped-grant picker", async () => {
    subscribeByPath({
      users: (next) => next(userSnapshot()),
      sections: (next) =>
        next(
          sectionSnapshot([
            { id: "support", label: "Support", description: "Giving pages.", order: 2 },
            { id: "watch", label: "Watch", description: "Watch pages.", order: 1 },
          ]),
        ),
    });

    render(<UsersTab canManage />);

    expect(await screen.findByText("staff@example.com")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Manage access for staff@example.com" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Named areas" }));

    const offered = screen
      .getAllByRole("checkbox")
      .map((input) => (input as HTMLInputElement).value);
    expect(offered).toEqual(["watch", "support"]);
    // The free-text list the picker replaced is gone, so an unregistered desk cannot be
    // typed into a grant at all.
    expect(screen.queryByPlaceholderText("watch, support")).not.toBeInTheDocument();
  });

  it("falls back to the seeded sections when the registry cannot be read", async () => {
    subscribeByPath({
      users: (next) => next(userSnapshot()),
      sections: (_next, error) => error(new Error("offline")),
    });

    render(<UsersTab canManage />);

    expect(await screen.findByText("staff@example.com")).toBeVisible();
    // A registry read failure must not take the staff directory down with it.
    expect(
      screen.queryByText("Staff directory could not be loaded"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Manage access for staff@example.com" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Named areas" }));

    const offered = screen
      .getAllByRole("checkbox")
      .map((input) => (input as HTMLInputElement).value);
    expect(offered).toEqual(["watch", "support", "station", "compliance", "news"]);
  });
});
