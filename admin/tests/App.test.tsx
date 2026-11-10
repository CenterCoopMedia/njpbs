import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

// App owns the pre-admission auth-state gating (loading, signed-out, email verification,
// request status, and errors). Past admission it mounts the router, so the signed-in shell — sidebar nav,
// capability gating, the save lock, and the leave guard — is exercised against the route tree in
// routing.test.tsx with a memory router, not here.

const authMocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  createAccount: vi.fn(),
  requestAccess: vi.fn(),
  resetPassword: vi.fn(),
  signIn: vi.fn(),
  signInWithEmail: vi.fn(),
  signOut: vi.fn(),
  state: {
    status: "signed-in",
    user: {
      uid: "first-admin",
      email: "first@example.com",
      displayName: "First admin",
    },
    principal: { id: "first-admin", grants: [] },
    userDoc: null,
  },
}));

const functionMocks = vi.hoisted(() => ({
  getStaffAccessStatus: vi.fn(),
  cmsSaveContent: vi.fn(),
}));

// Firestore reads made by the shell's tabs (the overview billing banner, page hydration in
// the content studio). Defaults are safe for every test: an absent doc hydrates the page
// editor empty and hides the billing banner. The default implementations are passed to
// vi.fn() so clearAllMocks cannot strip them.
const firestoreMocks = vi.hoisted(() => ({
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
}));

vi.mock("firebase/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase/firestore")>()),
  doc: firestoreMocks.doc,
  getDoc: firestoreMocks.getDoc,
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    state: authMocks.state,
    createAccount: authMocks.createAccount,
    requestAccess: authMocks.requestAccess,
    resetPassword: authMocks.resetPassword,
    signIn: authMocks.signIn,
    signInWithEmail: authMocks.signInWithEmail,
    signOut: authMocks.signOut,
    getIdToken: authMocks.getIdToken,
  }),
}));

// Partial, like the firestore mock above: BlockEditor also imports isConflictError and reads
// it when a save rejects. A factory naming only these two makes that read throw
// "No isConflictError export is defined" instead of running the conflict path.
vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  getStaffAccessStatus: functionMocks.getStaffAccessStatus,
  cmsSaveContent: functionMocks.cmsSaveContent,
}));

describe("App account-request state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getIdToken.mockResolvedValue("id-token");
    authMocks.resetPassword.mockResolvedValue(undefined);
    functionMocks.getStaffAccessStatus.mockResolvedValue({
      success: true,
      request: {
        state: "pending",
        requestVersion: 1,
        reference: "NJPBS-FIRSTADM-1",
        role: null,
        requestedAt: "2026-08-18T12:00:00.000Z",
        decidedAt: null,
        emailVerified: true,
      },
      mailState: "sent",
    });
  });

  it("shows the pending request and never exposes bootstrap", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Your request is waiting for an administrator" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/You will receive an email\./i)).toBeInTheDocument();
    expect(screen.queryByText(/REPLACE_ME/)).not.toBeInTheDocument();
    expect(screen.queryByText(/claim super admin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/bootstrap allowlist/i)).not.toBeInTheDocument();
  });

  it("offers a request form when no request exists", async () => {
    functionMocks.getStaffAccessStatus.mockResolvedValueOnce({
      success: true,
      request: {
        state: "not_requested",
        requestVersion: null,
        reference: null,
        role: null,
        requestedAt: null,
        decidedAt: null,
        emailVerified: true,
      },
      mailState: "not_queued",
    });
    render(<App />);

    expect(
      await screen.findByRole("button", { name: "Request access" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Why do you need access?")).toBeInTheDocument();
  });
});

describe("App unverifiable-account state", () => {
  it("explains when the supplied email is not approved", () => {
    const previous = authMocks.state;
    authMocks.state = {
      status: "access-denied",
      email: "account-23@example.org",
    } as unknown as typeof authMocks.state;

    try {
      render(<App />);
      expect(
        screen.getByText(/account-23@example\.org no longer matches the approved account identity/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Sign out" }),
      ).toBeInTheDocument();
    } finally {
      authMocks.state = previous;
    }
  });

  it("explains when Google did not provide an email that can be checked", () => {
    const previous = authMocks.state;
    authMocks.state = {
      status: "access-denied",
      email: null,
    } as unknown as typeof authMocks.state;

    try {
      render(<App />);
      expect(
        screen.getByText(/did not provide an email address that can be verified/i),
      ).toBeInTheDocument();
    } finally {
      authMocks.state = previous;
    }
  });
});

describe("App auth-state routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a designed loading state that tracks the admission phase", () => {
    const previous = authMocks.state;
    authMocks.state = {
      status: "loading",
      stage: "profile",
    } as unknown as typeof authMocks.state;

    try {
      render(<App />);
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent("Loading your profile and permissions");
      expect(status.querySelector(".spinner")).not.toBeNull();
      // The real phase is announced; the tip is readable but outside any announcing region.
      const tip = status.querySelector(".boardwalk-tip");
      expect(tip).toHaveTextContent(/Boardwalk tip no\. \d+/i);
      expect(tip).not.toHaveAttribute("aria-hidden");
      expect(tip?.closest('[aria-live="polite"]')).toBeNull();
      const steps = screen.getAllByRole("listitem");
      expect(steps.map((step) => step.getAttribute("data-state"))).toEqual([
        "done",
        "done",
        "active",
        "pending",
      ]);
      expect(steps[2]).toHaveAttribute("aria-current", "step");
      expect(steps[2]).toHaveTextContent("Loading your profile and permissions");
      // The old indeterminate bar is gone.
      expect(document.querySelector(".loading-track")).toBeNull();
    } finally {
      authMocks.state = previous;
    }
  });

  it("renders the staff sign-in welcome state", () => {
    const previous = authMocks.state;
    authMocks.state = { status: "signed-out" } as unknown as typeof authMocks.state;

    try {
      render(<App />);
      expect(screen.getByRole("heading", { name: "Sign in to Boardwalk" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Choose a test Google account" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    } finally {
      authMocks.state = previous;
    }
  });

  it.each(["", "REPLACE_ME@example.org", "notices@example.org"])("offers password recovery with sender %s without revealing whether the account exists", async (sender) => {
    const previous = authMocks.state;
    const previousSender = import.meta.env.VITE_VERIFICATION_EMAIL_SENDER;
    vi.stubEnv("VITE_VERIFICATION_EMAIL_SENDER", sender);
    authMocks.state = { status: "signed-out" } as unknown as typeof authMocks.state;

    try {
      render(<App />);
      fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "person@example.org" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));

      await waitFor(() => {
        expect(authMocks.resetPassword).toHaveBeenCalledWith("person@example.org");
      });
      expect(
        await screen.findByText(/if an account uses this email/i),
      ).toHaveTextContent(sender === "notices@example.org"
        ? "a reset link was sent from notices@example.org."
        : "a reset link was sent.");
      expect(screen.queryByText(/REPLACE_ME/)).not.toBeInTheDocument();
    } finally {
      authMocks.state = previous;
      vi.stubEnv("VITE_VERIFICATION_EMAIL_SENDER", previousSender);
    }
  });

  it("offers a fixed public reporting route without sending sign-in fields", () => {
    const previous = authMocks.state;
    authMocks.state = { status: "signed-out" } as unknown as typeof authMocks.state;
    try {
      render(<App />);
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "staff@example.test" } });
      const link = screen.getByRole("link", { name: "Report a problem (opens in a new tab)" });
      expect(link).toHaveAttribute("href", "https://njpbs.org/contact/#report-a-problem");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(screen.getByLabelText("Email")).toHaveValue("staff@example.test");
      expect(screen.getByLabelText("Password")).toBeInTheDocument();
    } finally {
      authMocks.state = previous;
    }
  });

  it("does not claim a failed verification email was sent", async () => {
    const previous = authMocks.state;
    authMocks.state = {
      status: "email-unverified",
      user: {
        uid: "new-user",
        email: "new@example.org",
        displayName: "New user",
      },
    } as unknown as typeof authMocks.state;
    authMocks.requestAccess.mockResolvedValueOnce({
      success: true,
      request: { state: "email_verification" },
      mailState: "failed",
    });

    try {
      render(<App />);
      fireEvent.click(
        screen.getByRole("button", { name: "Send another verification email" }),
      );

      expect(
        await screen.findByText(/verification email could not be sent/i),
      ).toHaveTextContent("email njpbs@montclair.edu");
      expect(screen.queryByText(/verification email was sent/i)).not.toBeInTheDocument();
    } finally {
      authMocks.state = previous;
    }
  });

  it.each([
    [
      "suppressed",
      /no new email was sent because one was sent recently/i,
      false,
    ],
    [
      "preparing",
      /a verification link is being prepared/i,
      false,
    ],
    [
      "pending",
      /email delivery is delayed/i,
      true,
    ],
  ] as const)("explains the %s verification state", async (mailState, copy, retries) => {
    const previous = authMocks.state;
    authMocks.state = {
      status: "email-unverified",
      user: {
        uid: "new-user",
        email: "new@example.org",
        displayName: "New user",
      },
    } as unknown as typeof authMocks.state;
    authMocks.requestAccess.mockResolvedValueOnce({
      success: true,
      request: { state: "email_verification" },
      mailState,
    });

    try {
      render(<App />);
      fireEvent.click(
        screen.getByRole("button", { name: "Send another verification email" }),
      );

      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(copy);
      if (!retries) {
        expect(status).not.toHaveTextContent(/we will retry automatically/i);
      }
      expect(screen.queryByText(/a verification email was sent to/i)).not.toBeInTheDocument();
    } finally {
      authMocks.state = previous;
    }
  });

  it("keeps an initial create-account provider error on the verification screen", () => {
    const previous = authMocks.state;
    authMocks.state = {
      status: "email-unverified",
      user: {
        uid: "new-user",
        email: "new@example.org",
        displayName: "New user",
      },
      verification: {
        error:
          "Email verification is temporarily limited. Check your first email, wait 15 minutes, then try again.",
      },
    } as unknown as typeof authMocks.state;

    try {
      render(<App />);
      expect(
        screen.getByText(/email verification is temporarily limited/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/check your inbox for a verification message/i)).toBeInTheDocument();
      expect(screen.queryByText(/use the link sent/i)).not.toBeInTheDocument();
    } finally {
      authMocks.state = previous;
    }
  });

  it("reuses the account reason when an unverified person requests another email", async () => {
    const previous = authMocks.state;
    authMocks.state = {
      status: "email-unverified",
      user: {
        uid: "new-user",
        email: "new@example.org",
        displayName: "New user",
      },
    } as unknown as typeof authMocks.state;
    authMocks.requestAccess.mockResolvedValueOnce({
      success: true,
      request: { state: "email_verification" },
      mailState: "sent",
    });

    try {
      render(<App />);
      expect(
        screen.queryByLabelText("Why do you need access?"),
      ).not.toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "Send another verification email" }),
      );

      await waitFor(() => {
        expect(authMocks.requestAccess).toHaveBeenCalledWith("");
      });
      expect(
        await screen.findByText(/verification email was sent/i),
      ).toHaveTextContent("new@example.org");
    } finally {
      authMocks.state = previous;
    }
  });

  it("asks for a reason only when a legacy unverified account has no request", async () => {
    const previous = authMocks.state;
    authMocks.state = {
      status: "email-unverified",
      user: {
        uid: "legacy-user",
        email: "legacy@example.org",
        displayName: "Legacy user",
      },
    } as unknown as typeof authMocks.state;
    authMocks.requestAccess
      .mockRejectedValueOnce(
        Object.assign(new Error("Tell an administrator why you need access"), {
          data: { code: "reason_invalid" },
        }),
      )
      .mockResolvedValueOnce({
        success: true,
        request: { state: "email_verification" },
        mailState: "sent",
      });

    try {
      render(<App />);
      fireEvent.click(
        screen.getByRole("button", { name: "Send another verification email" }),
      );

      const reason = await screen.findByLabelText("Why do you need access?");
      expect(reason).toBeRequired();
      expect(authMocks.requestAccess).toHaveBeenNthCalledWith(1, "");
      fireEvent.change(reason, { target: { value: "I edit program pages." } });
      fireEvent.click(
        screen.getByRole("button", { name: "Send another verification email" }),
      );

      await waitFor(() => {
        expect(authMocks.requestAccess).toHaveBeenNthCalledWith(
          2,
          "I edit program pages.",
        );
      });
      expect(await screen.findByText(/verification email was sent/i)).toBeInTheDocument();
      expect(screen.queryByLabelText("Why do you need access?")).not.toBeInTheDocument();
    } finally {
      authMocks.state = previous;
    }
  });

  it("keeps retry and sign-out actions in the error state", () => {
    const previous = authMocks.state;
    authMocks.state = {
      status: "error",
      error: new Error("Profile load failed"),
    } as unknown as typeof authMocks.state;

    try {
      render(<App />);
      expect(
        screen.getByRole("heading", { name: "We couldn't open the CMS" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    } finally {
      authMocks.state = previous;
    }
  });
});

describe("App admitted", () => {
  it("mounts the routed shell for an admitted principal", async () => {
    const previous = authMocks.state;
    authMocks.state = {
      status: "signed-in",
      user: {
        uid: "admin",
        email: "account-1@example.org",
        displayName: "Alex Admin",
      },
      principal: { id: "admin", grants: [{ role: "admin" }] },
      userDoc: {
        email: "account-1@example.org",
        role: "admin",
        grants: [],
        displayName: "Alex Admin",
      },
    } as unknown as typeof authMocks.state;

    try {
      render(<App />);
      // The router lands on newsroom home: the shell nav and work heading are present. The
      // shell appears once the router has the route's code; until then App holds the bootstrap
      // screen at its last phase rather than mounting an empty shell.
      expect(
        await screen.findByRole("navigation", { name: "Primary" }),
      ).toBeInTheDocument();
      expect(
        await screen.findByRole("heading", { level: 1, name: "Home" }),
      ).toBeInTheDocument();
    } finally {
      authMocks.state = previous;
    }
  });

  it("applies the stored icon preference to registered shell controls", async () => {
    const previous = authMocks.state;
    authMocks.state = {
      status: "signed-in",
      user: {
        uid: "admin",
        email: "account-1@example.org",
        displayName: "Alex Admin",
      },
      principal: { id: "admin", grants: [{ role: "admin" }] },
      userDoc: {
        email: "account-1@example.org",
        role: "admin",
        grants: [],
        displayName: "Alex Admin",
        preferences: { display: { controlPresentation: "icons" } },
      },
    } as unknown as typeof authMocks.state;

    try {
      render(<App />);
      const collapse = await screen.findByRole("button", {
        name: "Collapse primary navigation",
      });
      expect(collapse).not.toHaveTextContent("Collapse primary navigation");
      expect(collapse.querySelector(".icon")).toBeInTheDocument();
    } finally {
      authMocks.state = previous;
    }
  });
});
