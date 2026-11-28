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
  setStaffAccessLevel: vi.fn(),
}));

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
          accessTier: "admin",
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

// Route each subscription by collection path so a roster assertion counts only roster reads.
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
    subscribeByPath({ users: (next) => next({ docs: [{ id: "staff-1", data: () => ({
      email: "staff@example.test", displayName: "Staff Member", active: false,
      offboarding: { id: "operation", step: "sign_in_and_sessions" },
    }) }] }), sections: (next) => next(sectionSnapshot()) });
    render(<UsersTab canManage />);
    expect(await screen.findByRole("button", { name: "Retry offboarding for Staff Member" })).toBeVisible();
    expect(screen.getByText("Finish disabling sign-in and revoking sessions.")).toBeVisible();
    expect(userSubscriptionCount()).toBe(1);
  });
  it("lets an Owner set a whole-site level with the reviewed access state", async () => {
    subscribeByPath({ users: (next) => next(userSnapshot()), sections: (next) => next(sectionSnapshot()) });
    authMocks.getIdToken.mockResolvedValue("synthetic-token");
    functionMocks.setStaffAccessLevel.mockResolvedValue({ success: true });
    render(<UsersTab canManage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit access level for Staff Member" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Access level for Staff Member" }), { target: { value: "publisher" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm level for Staff Member" }));
    await waitFor(() => expect(functionMocks.setStaffAccessLevel).toHaveBeenCalledWith("synthetic-token", {
      targetUid: "staff-1", accessTier: "publisher", expectedAccess: JSON.stringify({ tierPresent: true, accessTier: "admin", active: true }),
    }));
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
    functionMocks.setStaffAccessLevel.mockReset();
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

  it("keeps an access-level error distinct while leaving the directory visible", async () => {
    firestoreMocks.onSnapshot.mockImplementation((_ref, next) => {
      next(userSnapshot());
      return firestoreMocks.unsubscribe;
    });
    authMocks.getIdToken.mockResolvedValue("token");
    functionMocks.setStaffAccessLevel.mockRejectedValue(new Error("Access service unavailable"));

    render(<UsersTab canManage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit access level for Staff Member" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Access level for Staff Member" }), { target: { value: "publisher" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm level for Staff Member" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Access service unavailable");
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

    fireEvent.click(await screen.findByRole("button", { name: "Deactivate Staff Member" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm deactivation for Staff Member" }));

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
});
