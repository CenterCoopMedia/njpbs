import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { AuthFrame, BootstrapView } from "../src/components/BootstrapView";

const entry = vi.hoisted(() => ({ state: { status: "signed-out" } as { status: string; sessionEnded?: boolean } }));
const actions = vi.hoisted(() => ({
  createAccount: vi.fn(), resetPassword: vi.fn(), signIn: vi.fn(),
  signInWithEmail: vi.fn(), signOut: vi.fn(), getIdToken: vi.fn(), requestAccess: vi.fn(),
}));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ ...actions, state: entry.state }),
}));
// These tests exercise the entry views, not the admitted router or network clients.
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  createBrowserRouter: () => ({ state: { initialized: true }, subscribe: () => () => {} }),
  RouterProvider: () => null,
}));
vi.mock("../src/routes/buildRoutes", () => ({ buildRoutes: () => [] }));
vi.mock("../src/routes/routeModules", () => ({ preloadInitialRoute: async () => {} }));

describe("auth entry presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    entry.state = { status: "signed-out" };
    actions.signIn.mockResolvedValue(undefined);
    actions.signInWithEmail.mockResolvedValue(undefined);
    actions.resetPassword.mockResolvedValue(undefined);
    actions.createAccount.mockResolvedValue({ success: true });
  });

  it("says why the sign-in screen appeared only after a session ended", () => {
    const { unmount } = render(<App />);
    expect(screen.queryByText("Your session ended. Sign in again.")).not.toBeInTheDocument();
    unmount();
    entry.state = { status: "signed-out", sessionEnded: true };
    render(<App />);
    expect(screen.getByText("Your session ended. Sign in again.")).toBeInTheDocument();
  });

  it("keeps decoration out of the accessibility tree and retains the official logo", () => {
    const { container } = render(<AuthFrame><h1>Account</h1></AuthFrame>);
    expect(container.querySelector(".auth-scene")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".auth-brand-caption")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("img", { name: "NJ PBS" })).toHaveAttribute("src", "/brand/njpbs-horizontal-white.svg");
  });

  it("renders a local Google mark without changing the Google sign-in action", async () => {
    render(<App />);
    const button = screen.getByRole("button", { name: "Choose a test Google account" });
    expect(button.querySelector("img")).toHaveAttribute("src", "/brand/google-g.svg");
    expect(button.querySelector("img")).toHaveAttribute("alt", "");
    fireEvent.click(button);
    await waitFor(() => expect(actions.signIn).toHaveBeenCalledTimes(1));
    expect(actions.signInWithEmail).not.toHaveBeenCalled();
  });

  it("toggles password visibility without submitting and hides it again on submit", async () => {
    render(<App />);
    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    expect(email).toHaveAttribute("placeholder", "you@example.org");
    expect(password).toHaveAttribute("type", "password");
    fireEvent.change(email, { target: { value: "staff@example.org" } });
    fireEvent.change(password, { target: { value: "example-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
    expect(actions.signInWithEmail).not.toHaveBeenCalled();
    fireEvent.submit(password.closest("form")!);
    await waitFor(() => expect(actions.signInWithEmail).toHaveBeenCalledWith("staff@example.org", "example-password"));
    expect(password).toHaveAttribute("type", "password");
  });

  it("keeps password recovery wired to the entered email", async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "staff@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    await waitFor(() => expect(actions.resetPassword).toHaveBeenCalledWith("staff@example.org"));
    expect(await screen.findByText(/if an account uses this email/i)).toBeInTheDocument();
  });

  it("identifies local sign-in without implying automatic access", () => {
    render(<App />);
    expect(screen.getByText("Use a local test account to try Boardwalk.")).toBeInTheDocument();
    expect(screen.getByText(/an administrator approves new accounts/i)).toBeInTheDocument();
  });

  it("retains live Google sign-in and staff guidance outside local test mode", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_USE_EMULATORS", "false");
    vi.stubEnv("VITE_FIREBASE_API_KEY", "test-api-key");
    vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "example.test");
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "demo-njpbs");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "test-app-id");
    vi.resetModules();
    try {
      const { default: ProductionApp } = await import("../src/App");
      render(<ProductionApp />);
      expect(screen.getByText("Staff: use Google with your montclair.edu account.")).toBeInTheDocument();
      expect(screen.queryByText(/Local test mode/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Choose a test Google account" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
      await waitFor(() => expect(actions.signIn).toHaveBeenCalledTimes(1));
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("keeps verified-email registration routed through the existing account action", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Outside collaborator" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "outside@example.org" } });
    const password = screen.getByLabelText("Password");
    fireEvent.change(password, { target: { value: "example-password" } });
    fireEvent.change(screen.getByLabelText("Why do you need access?"), { target: { value: "I edit program pages." } });
    fireEvent.submit(password.closest("form")!);
    await waitFor(() => expect(actions.createAccount).toHaveBeenCalledWith({
      displayName: "Outside collaborator", email: "outside@example.org",
      password: "example-password", reason: "I edit program pages.",
    }));
    expect(actions.signInWithEmail).not.toHaveBeenCalled();
  });

  it("masks the password again when switching account modes", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  });

  it("offers sign-in after duplicate registration and keeps the email for password recovery", async () => {
    actions.createAccount.mockRejectedValueOnce(Object.assign(
      new Error("Firebase: Error (auth/email-already-in-use)."),
      { code: "auth/email-already-in-use" },
    ));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test collaborator" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "collaborator@example.invalid" } });
    fireEvent.change(screen.getByLabelText("Why do you need access?"), { target: { value: "Election coverage." } });
    const password = screen.getByLabelText("Password");
    fireEvent.change(password, { target: { value: "example-password" } });
    fireEvent.submit(password.closest("form")!);
    expect(await screen.findByText(/An account already exists for this email/)).toBeInTheDocument();
    expect(screen.queryByText(/Firebase:|auth\/email-already-in-use/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to sign in" }));
    expect(screen.getByRole("heading", { name: "Sign in to Boardwalk" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("collaborator@example.invalid");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Sign in", pressed: true })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Go to sign in" })).not.toBeInTheDocument();
    expect(actions.signInWithEmail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    await waitFor(() => expect(actions.resetPassword).toHaveBeenCalledWith("collaborator@example.invalid"));
    expect(await screen.findByText(/If an account uses this email/)).toBeInTheDocument();
  });

  it.each([
    ["auth/wrong-password", /Check your email and password/],
    ["auth/user-not-found", /Check your email and password/],
    ["auth/invalid-credential", /Check your email and password/],
    ["auth/user-disabled", /This account is turned off\. Ask a CMS administrator to turn it back on\./],
    ["auth/too-many-requests", /Too many attempts/],
    ["auth/weak-password", /Choose a stronger password/],
    ["auth/invalid-email", /Enter a valid email address/],
    ["auth/network-request-failed", /Check your internet connection/],
    ["auth/popup-closed-by-user", /Sign-in was interrupted/],
    ["auth/cancelled-popup-request", /Sign-in was interrupted/],
    ["auth/popup-blocked", /Allow pop-ups for Boardwalk/],
    ["auth/email-already-in-use", /We couldn't complete this account action/],
    ["auth/unrecognized-code", /We couldn't complete this account action/],
  ])("shows plain feedback for %s without exposing provider details", async (code, message) => {
    actions.signInWithEmail.mockRejectedValueOnce(Object.assign(
      new Error(`Firebase: Error (${code}).`), { code },
    ));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "staff@example.invalid" } });
    const password = screen.getByLabelText("Password");
    fireEvent.change(password, { target: { value: "example-password" } });
    fireEvent.submit(password.closest("form")!);
    expect(await screen.findByText(message)).toBeInTheDocument();
    if (code === "auth/user-disabled") {
      expect(screen.getByRole("alert")).toHaveTextContent("Account turned off");
      expect(screen.queryByText("Account action failed")).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/Firebase:|auth\//)).not.toBeInTheDocument();
    expect(screen.queryByText(/An account already exists/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to sign in" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in", pressed: true })).toBeEnabled();
  });

  it("explains a turned-off account when Google sign-in is refused", async () => {
    actions.signIn.mockRejectedValueOnce(Object.assign(
      new Error("Firebase: Error (auth/user-disabled)."), { code: "auth/user-disabled" },
    ));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a test Google account" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Account turned off");
    expect(alert).toHaveTextContent("This account is turned off. Ask a CMS administrator to turn it back on.");
    expect(screen.queryByText(/Firebase:|auth\/user-disabled|Account action failed/)).not.toBeInTheDocument();
  });

  it("does not confirm an account exists when password recovery fails", async () => {
    actions.resetPassword.mockRejectedValueOnce(Object.assign(
      new Error("Firebase: Error (auth/user-not-found)."), { code: "auth/user-not-found" },
    ));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "staff@example.invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(await screen.findByText(/Check your email and password/)).toBeInTheDocument();
    expect(screen.queryByText(/Firebase:|auth\/|No account|not found/i)).not.toBeInTheDocument();
  });

  it("keeps malformed-email guidance for the password-reset server's error shape", async () => {
    actions.resetPassword.mockRejectedValueOnce(Object.assign(
      new Error("Enter a valid email address"),
      { status: 400, data: { code: "email_invalid" } },
    ));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "mistyped-address" } });
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(await screen.findByText("Enter a valid email address, then try again.")).toBeInTheDocument();
    expect(screen.queryByText(/email_invalid|We couldn't complete/)).not.toBeInTheDocument();
  });

  it.each([
    [429, "Too many requests. Try again later.", /Too many attempts. Wait a few minutes/],
    [503, "Request limit service is unavailable", /Account actions are temporarily unavailable. Try again later/],
  ])("preserves waiting guidance for a password-reset HTTP %s response without a code", async (status, rawMessage, message) => {
    actions.resetPassword.mockRejectedValueOnce(Object.assign(
      new Error(rawMessage), { status, data: { error: rawMessage, retryAfterSeconds: 180 } },
    ));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "staff@example.invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/We couldn't complete|Request limit service|Too many requests/)).not.toBeInTheDocument();
    expect(actions.resetPassword).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate actions and mode changes while Google sign-in is pending", async () => {
    let finish!: () => void;
    actions.signIn.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a test Google account" }));
    expect(screen.getByRole("button", { name: "Choose a test Google account" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show password" })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled());
  });

  it("uses a generic recovery message for unknown errors instead of raw provider details", async () => {
    actions.signIn.mockRejectedValueOnce(new Error("Firebase: unexpected provider details"));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a test Google account" }));
    expect(await screen.findByText(/We couldn't complete this account action/)).toBeInTheDocument();
    expect(screen.queryByText(/Firebase:|unexpected provider details/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a test Google account" })).toBeEnabled();
  });

  it.each(["session", "admission", "profile", "workspace"] as const)(
    "keeps the %s checklist driven by real stages, including the secondary detail",
    (stage) => {
      render(<BootstrapView stage={stage} />);
      const index = ["session", "admission", "profile", "workspace"].indexOf(stage);
      const steps = screen.getAllByRole("listitem");
      expect(steps.map((step) => step.getAttribute("data-state"))).toEqual(
        steps.map((_, i) => i < index ? "done" : i === index ? "active" : "pending"),
      );
      expect(steps[index]).toHaveAttribute("aria-current", "step");
      expect(steps[index].querySelector(".bootstrap-phase-detail")?.textContent).toBeTruthy();
      expect(steps[index].querySelector(".bootstrap-phase-mark .icon")).toBeNull();
      expect(screen.queryByText("Workspace ready")).not.toBeInTheDocument();
    },
  );

  it("ships the decorative artwork locally, with the actual multicolor G", () => {
    const brand = resolve(process.cwd(), "public/brand");
    const art = readFileSync(resolve(brand, "auth-newsroom-art.webp"));
    expect(art.subarray(0, 4).toString()).toBe("RIFF");
    expect(art.subarray(8, 12).toString()).toBe("WEBP");
    expect(art.length).toBeLessThan(20_000);
    const google = readFileSync(resolve(brand, "google-g.svg"), "utf8").toLowerCase();
    for (const color of ["#4285f4", "#34a853", "#fbbc05", "#ea4335"]) expect(google).toContain(color);
    expect(readFileSync(resolve(brand, "auth-pbs-mark.svg"), "utf8")).toContain("<path");
  });
});
