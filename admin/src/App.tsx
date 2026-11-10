import { InfoTooltip } from "./components/ui/InfoTooltip";
import { Icon } from "./components/ui/Icon";
import { applyActionCode } from "firebase/auth";
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { createBrowserRouter, RouterProvider } from "react-router";
import { StaffSiteHandoff } from "./components/StaffSiteHandoff";
import { LoadingIndicator } from "./components/ui/LoadingIndicator";
import { AuthFrame, BootstrapView } from "./components/BootstrapView";
import {
  Button,
  InlineMessage,
  Textarea,
  TextInput,
} from "./components/ui/Primitives";
import { useAuth } from "./context/AuthContext";
import type { AuthUser } from "./context/authReducer";
import { ControlPresentationProvider } from "./context/ControlPresentationContext";
import { LiveProductionProvider } from "./context/LiveProductionContext";
import { canAccessAdmin, canSubmitProblemReport } from "./lib/access";
import { SESSION_ENDED_MESSAGE } from "./lib/session-ended";
import { readControlPresentation } from "./lib/control-presentation";
import { useMediaQuery } from "./components/ui/floating";
import { auth, emulatorMode } from "./lib/firebase";
import {
  getStaffAccessStatus,
  type StaffAccessMailState,
  type StaffAccessResponse,
  type StaffAccessStatus,
} from "./lib/functions";
import { buildRoutes } from "./routes/buildRoutes";
import { preloadInitialRoute } from "./routes/routeModules";
import { ShellProvider } from "./routes/ShellContext";

function verificationSenderPhrase(): string {
  const sender = import.meta.env.VITE_VERIFICATION_EMAIL_SENDER?.trim();
  return sender && sender !== "REPLACE_ME@example.org" ? ` from ${sender}` : "";
}

void preloadInitialRoute(window.location.pathname).catch(() => undefined);

const AccessScreenReportProblemDialog = lazy(() => import("./components/ReportProblemDialog")
  .then((module) => ({ default: module.ReportProblemDialog })));

// A missing secondary chunk must leave account status, requests and sign out usable.
class AccessScreenReportBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const selfServiceAuthEnabled = import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT !== "development";

const appRouter = createBrowserRouter(buildRoutes());

// True once the router has resolved the addressed route's code. createBrowserRouter starts that
// work at module load, alongside the route preload above, so on a normal visit it is already
// true by the time admission finishes and the bootstrap screen never has to show it.
function useRouterReady(): boolean {
  return useSyncExternalStore(
    (onChange) => appRouter.subscribe(onChange),
    () => appRouter.state.initialized,
  );
}

interface SignedOutViewProps {
  sessionEnded: boolean;
  createAccount: (input: {
    displayName: string;
    email: string;
    password: string;
    reason: string;
  }) => Promise<StaffAccessResponse>;
  resetPassword: (email: string) => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
}

function accountActionError(actionError: unknown, creatingAccount: boolean) {
  const detail = typeof actionError === "object" && actionError !== null
    ? actionError as { code?: unknown; data?: unknown; status?: unknown } : null;
  const data = typeof detail?.data === "object" && detail.data !== null
    ? detail.data as { code?: unknown } : null;
  const code = detail?.status === 429 ? "auth/too-many-requests" : detail?.code ?? data?.code;
  const fallback = detail?.status === 503
    ? "Account actions are temporarily unavailable. Try again later."
    : "We couldn't complete this account action. Try again. If it keeps failing, use Report a problem.";
  let message = fallback;
  let title = "Account action failed";
  let canSignIn = false;
  switch (code) {
    case "auth/email-already-in-use":
      if (creatingAccount) {
        message = "An account already exists for this email. Sign in instead, or use Forgot password? on the sign-in form to reset your password.";
        canSignIn = true;
      }
      break;
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-credential":
      message = "We couldn't sign you in. Check your email and password, or use Forgot password? on the sign-in form.";
      break;
    case "auth/user-disabled":
      title = "Account turned off";
      message = "This account is turned off. Ask a CMS administrator to turn it back on.";
      break;
    case "auth/too-many-requests":
      message = "Too many attempts. Wait a few minutes, then try again.";
      break;
    case "auth/weak-password":
      message = "Choose a stronger password with at least eight characters.";
      break;
    case "auth/invalid-email":
    case "email_invalid":
      message = "Enter a valid email address, then try again.";
      break;
    case "auth/network-request-failed":
      message = "Check your internet connection, then try again.";
      break;
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      message = "Sign-in was interrupted. Try again.";
      break;
    case "auth/popup-blocked":
      message = "Allow pop-ups for Boardwalk, then try signing in again.";
      break;
  }
  return { message, title, canSignIn };
}

function SignedOutView({
  createAccount,
  resetPassword,
  sessionEnded,
  signInWithEmail,
  signInWithGoogle,
}: SignedOutViewProps) {
  const [mode, setMode] = useState<"sign-in" | "create">("sign-in");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<ReturnType<typeof accountActionError> | null>(null);
  const signInModeButton = useRef<HTMLButtonElement>(null);

  async function run(action: () => Promise<unknown>, successMessage?: string) {
    setError(null);
    setMessage(null);
    setPending(true);
    setShowPassword(false);
    try {
      await action();
      if (successMessage) setMessage(successMessage);
    } catch (actionError) {
      setError(accountActionError(actionError, mode === "create"));
    } finally {
      setPending(false);
    }
  }

  function submitEmailSignIn(event: FormEvent) {
    event.preventDefault();
    void run(() => signInWithEmail(email, password));
  }

  function submitCreateAccount(event: FormEvent) {
    event.preventDefault();
    void run(() => createAccount({ displayName, email, password, reason }));
  }

  function sendReset() {
    if (!email.trim()) {
      setMessage(null);
      setError({ message: "Enter your email address first.", title: "Account action failed", canSignIn: false });
      return;
    }
    void run(
      () => resetPassword(email),
      `If an account uses this email, a reset link was sent${verificationSenderPhrase()}.`,
    );
  }

  return (
    <AuthFrame>
      <div className="auth-copy">
        <h1>{mode === "sign-in" ? "Sign in to Boardwalk" : "Create an account"}</h1>
        <p>
          {emulatorMode ? "Use a local test account to try Boardwalk." : mode === "sign-in"
            ? "Staff: use Google with your montclair.edu account."
            : "Verify your email, then an administrator will approve or reject your request."}
        </p>
      </div>

      {sessionEnded && <InlineMessage tone="warning">{SESSION_ENDED_MESSAGE}</InlineMessage>}

      {emulatorMode && <InlineMessage tone="info">
        Local test mode. Google opens a simulated account chooser. Use a test account;
        this session does not sign in to Google or the live Boardwalk library.
      </InlineMessage>}

      {selfServiceAuthEnabled && <div className="auth-mode-switch" aria-label="Account options">
        <Button
          ref={signInModeButton}
          aria-pressed={mode === "sign-in"}
          disabled={pending}
          onClick={() => {
            setMode("sign-in");
            setShowPassword(false);
            setError(null);
            setMessage(null);
          }}
          variant="secondary"
        >
          Sign in
        </Button>
        <Button
          aria-pressed={mode === "create"}
          disabled={pending}
          onClick={() => {
            setMode("create");
            setShowPassword(false);
            setError(null);
            setMessage(null);
          }}
          variant="secondary"
        >
          Create account
        </Button>
      </div>}

      {mode === "sign-in" ? (
        <form className="auth-form" onSubmit={submitEmailSignIn}>
          <Button
            className="auth-google-action"
            disabled={pending}
            onClick={() => void run(signInWithGoogle)}
            type="button"
            variant="primary"
          >
            <img
              className="auth-google-logo"
              src="/brand/google-g.svg"
              alt=""
              aria-hidden="true"
              width={24}
              height={24}
            />
            {emulatorMode ? "Choose a test Google account" : "Continue with Google"}
          </Button>
          <div className="auth-divider" aria-hidden="true">
            <span>or sign in with email</span>
          </div>
          <label htmlFor="auth-email">Email</label>
          <div className="auth-input-wrap">
            <svg
              className="auth-input-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m3 5 9 7 9-7" />
            </svg>
            <TextInput
              autoComplete="email"
              disabled={pending}
              id="auth-email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.org"
              required
              type="email"
              value={email}
            />
          </div>
          <label htmlFor="auth-password">Password</label>
          <div className="auth-input-wrap auth-password-wrap">
            <Icon name="lock" className="auth-input-icon" />
            <TextInput
              autoComplete="current-password"
              disabled={pending}
              id="auth-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              required
              type={showPassword ? "text" : "password"}
              value={password}
            />
            <Button
              className="auth-password-toggle"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-controls="auth-password"
              aria-pressed={showPassword}
              disabled={pending}
              onClick={() => setShowPassword((visible) => !visible)}
              type="button"
              variant="ghost"
            >
              <Icon name={showPassword ? "eye" : "eye-off"} />
            </Button>
          </div>
          <Button disabled={pending} type="submit" variant="secondary">
            {pending ? "Signing in" : "Sign in"}
          </Button>
          {selfServiceAuthEnabled && <Button disabled={pending} onClick={sendReset} type="button" variant="ghost">
            Forgot password?
          </Button>}
        </form>
      ) : (
        <form className="auth-form" onSubmit={submitCreateAccount}>
          <label htmlFor="create-name">Name</label>
          <TextInput
            autoComplete="name"
            disabled={pending}
            id="create-name"
            maxLength={120}
            onChange={(event) => setDisplayName(event.target.value)}
            required
            value={displayName}
          />
          <label htmlFor="create-email">Email</label>
          <TextInput
            autoComplete="email"
            disabled={pending}
            id="create-email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
          <div className="editor-field-label-row"><label htmlFor="create-password">Password</label><InfoTooltip label="Password" content="Use at least eight characters." /></div>
          <TextInput
            aria-describedby="create-password-hint"
            autoComplete="new-password"
            disabled={pending}
            id="create-password"
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <span className="sr-only" id="create-password-hint">
            Use at least eight characters.
          </span>
          <label htmlFor="create-reason">Why do you need access?</label>
          <Textarea
            disabled={pending}
            id="create-reason"
            maxLength={500}
            minLength={5}
            onChange={(event) => setReason(event.target.value)}
            required
            rows={3}
            value={reason}
          />
          <Button disabled={pending} type="submit" variant="primary">
            {pending ? "Creating account" : "Create account"}
          </Button>
        </form>
      )}

      <p className="auth-domain-note">
        An administrator approves new accounts, including outside collaborators.
      </p>
      <a
        aria-label="Report a problem (opens in a new tab)"
        className="button button-ghost"
        href="https://njpbs.org/contact/#report-a-problem"
        rel="noopener noreferrer"
        target="_blank"
      >
        Report a problem<span className="sr-only"> (opens in a new tab)</span>
      </a>
      {error ? (
        <InlineMessage className="auth-account-error" tone="error" title={error.title}>
          <span>{error.message}</span>
          {error.canSignIn && <Button
            disabled={pending}
            onClick={() => {
              setMode("sign-in");
              setPassword("");
              setShowPassword(false);
              setError(null);
              setMessage(null);
              signInModeButton.current?.focus();
            }}
            variant="secondary"
          >
            Go to sign in
          </Button>}
        </InlineMessage>
      ) : null}
      {message ? <InlineMessage tone="success">{message}</InlineMessage> : null}
    </AuthFrame>
  );
}

function verificationMailFeedback(
  mailState: StaffAccessMailState,
  email: string | null,
): { error?: string; message?: string; tone?: "info" | "success" } {
  switch (mailState) {
    case "sent":
      return {
        message: `A verification email was sent to ${email}.`,
        tone: "success",
      };
    case "suppressed":
      return {
        message:
          "No new email was sent because one was sent recently. Check your inbox, or try again after 15 minutes.",
        tone: "info",
      };
    case "preparing":
      return {
        message:
          "A verification link is being prepared. Check your inbox, then try again in a few minutes if it does not arrive.",
        tone: "info",
      };
    case "pending":
      return {
        message: "Email delivery is delayed. We will retry automatically.",
        tone: "info",
      };
    case "unknown":
      return {
        error:
          "We could not confirm delivery. Check your inbox before you send another email.",
      };
    case "failed":
      return {
        error:
          "The verification email could not be sent. Try again or email njpbs@montclair.edu.",
      };
    default:
      return { error: "The verification email was not queued. Try again." };
  }
}

function EmailVerificationView({
  initialError,
  initialMailState,
  requestAccess,
  signOut,
  user,
}: {
  initialError?: string;
  initialMailState?: StaffAccessMailState;
  requestAccess: (reason: string) => Promise<StaffAccessResponse>;
  signOut: () => Promise<void>;
  user: AuthUser;
}) {
  const [needsReason, setNeedsReason] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"info" | "success">("success");
  const [error, setError] = useState<string | null>(null);

  const showMailState = useCallback((mailState: StaffAccessMailState) => {
    const feedback = verificationMailFeedback(mailState, user.email);
    setMessage(feedback.message ?? null);
    setMessageTone(feedback.tone ?? "success");
    setError(feedback.error ?? null);
  }, [user.email]);

  useEffect(() => {
    if (initialError) {
      setMessage(null);
      setError(initialError);
      return;
    }
    if (initialMailState) showMailState(initialMailState);
  }, [initialError, initialMailState, showMailState]);

  function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedReason = needsReason ? reason : "";
    setPending(true);
    setError(null);
    setMessage(null);
    void requestAccess(submittedReason)
      .then((response) => {
        setNeedsReason(false);
        setReason("");
        showMailState(response.mailState);
      })
      .catch((requestError: unknown) => {
        const data =
          typeof requestError === "object" && requestError !== null
            ? (requestError as { data?: unknown }).data
            : null;
        const code =
          typeof data === "object" && data !== null
            ? (data as { code?: unknown }).code
            : null;
        if (code === "reason_invalid" || code === "reason_required") {
          setNeedsReason(true);
          setError("Enter why you need access, then send the email again.");
          return;
        }
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Email could not be sent",
        );
      })
      .finally(() => setPending(false));
  }

  return (
    <AuthFrame>
      <div className="auth-copy">
        <h1>Verify your email</h1>
        <p>
          Check your inbox for a verification message{verificationSenderPhrase()}. Your request enters the administrator’s
          queue only after verification.
        </p>
      </div>
      <form className="auth-form" onSubmit={resend}>
        {needsReason ? (
          <>
            <label htmlFor="verification-reason">Why do you need access?</label>
            <Textarea
              disabled={pending}
              id="verification-reason"
              maxLength={500}
              minLength={5}
              name="reason"
              onChange={(event) => setReason(event.target.value)}
              required
              rows={3}
              value={reason}
            />
          </>
        ) : null}
        <Button
          disabled={pending}
          type="submit"
          variant="primary"
        >
          {pending ? "Sending email" : "Send another verification email"}
        </Button>
      </form>
      {message ? (
        <InlineMessage role="status" tone={messageTone}>{message}</InlineMessage>
      ) : null}
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      <Button onClick={signOut}>Sign out</Button>
    </AuthFrame>
  );
}

function EmailActionView({ signOut }: { signOut: () => Promise<void> }) {
  const [state, setState] = useState<"working" | "success" | "error">("working");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const code = parameters.get("oobCode");
    if (!code) {
      setState("error");
      setError("The verification link is incomplete.");
      return;
    }
    void applyActionCode(auth, code)
      .then(async () => {
        if (auth.currentUser) {
          await auth.currentUser.reload();
          await auth.currentUser.getIdToken(true);
        }
        setState("success");
      })
      .catch((actionError: unknown) => {
        setState("error");
        setError(
          actionError instanceof Error
            ? actionError.message
            : "The verification link could not be used.",
        );
      });
  }, []);

  return (
    <AuthFrame>
      <div className="auth-copy">
        <h1>
          {state === "working"
            ? "Verifying your email"
            : state === "success"
              ? "Email verified"
              : "Verification did not finish"}
        </h1>
        <p>
          {state === "success"
            ? "Continue to Admin. Your request will move into the administrator’s review queue."
            : state === "working"
              ? "Keep this page open for a moment."
              : "Request another verification email from the account page."}
        </p>
      </div>
      {state === "working" ? (
        <LoadingIndicator
          label="Checking the verification link"
          stages={["Sending the code to Firebase Authentication", "Marking your email as verified"]}
        />
      ) : null}
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      {state !== "working" ? (
        <div className="button-row">
          <Button
            onClick={() => window.location.replace("/")}
            variant="primary"
          >
            Continue
          </Button>
          <Button onClick={signOut}>Sign out</Button>
        </div>
      ) : null}
    </AuthFrame>
  );
}

function ErrorView({
  message,
  signOut,
}: {
  message: string;
  signOut: () => Promise<void>;
}) {
  return (
    <AuthFrame>
      <div className="auth-copy">
        <h1>We couldn't open the CMS</h1>
        <p>The session stopped while your staff profile was loading.</p>
      </div>
      <InlineMessage tone="error" title="Account error">
        {message}
      </InlineMessage>
      <div className="button-row">
        <Button variant="primary" onClick={() => window.location.reload()}>
          Try again
        </Button>
        <Button onClick={signOut}>Sign out</Button>
      </div>
    </AuthFrame>
  );
}

function UnverifiableAccountView({
  email,
  signOut,
}: {
  email: string | null;
  signOut: () => Promise<void>;
}) {
  return (
    <AuthFrame>
      <div className="auth-copy">
        <h1>This account cannot be used</h1>
        <p>
          {email
            ? `${email} no longer matches the approved account identity.`
            : "The account did not provide an email address that can be verified."}
        </p>
      </div>
      <InlineMessage tone="warning" title="Account check stopped">
        Sign out, then use the address that owns the approved request. If you need help,
        email njpbs@montclair.edu.
      </InlineMessage>
      <Button onClick={signOut}>Sign out</Button>
    </AuthFrame>
  );
}

function RequestAccessForm({
  label,
  requestAccess,
}: {
  label: string;
  requestAccess: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    void requestAccess(reason)
      .catch((requestError: unknown) =>
        setError(requestError instanceof Error ? requestError.message : "Request failed"),
      )
      .finally(() => setPending(false));
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <label htmlFor="access-reason">Why do you need access?</label>
      <Textarea
        disabled={pending}
        id="access-reason"
        maxLength={500}
        minLength={5}
        onChange={(event) => setReason(event.target.value)}
        required
        rows={3}
        value={reason}
      />
      <Button disabled={pending} type="submit" variant="primary">
        {pending ? "Sending request" : label}
      </Button>
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
    </form>
  );
}

function requestCopy(status: StaffAccessStatus): {
  title: string;
  body: string;
} {
  switch (status.state) {
    case "pending":
      return {
        title: "Your request is waiting for an administrator",
        body: `An administrator will approve staff guide access or a CMS authoring role, or reject the request. You will receive an email${verificationSenderPhrase()}.`,
      };
    case "denied":
      return {
        title: "This request was not approved",
        body: "You can send a new request if your access need changed.",
      };
    case "expired":
      return {
        title: "This request expired",
        body: "Send a new request if you still need access.",
      };
    case "ready":
      return {
        title: "Your account is ready",
        body: "Reload Admin to open your approved workspace.",
      };
    default:
      return {
        title: "Request staff access",
        body: "Tell an administrator whether you need staff guide access or CMS access. Creating a request does not grant permissions.",
      };
  }
}

function DeniedView({
  showReportProblem,
  getIdToken,
  requestAccess,
  signOut,
  user,
}: {
  getIdToken: () => Promise<string>;
  requestAccess: (reason: string) => Promise<unknown>;
  signOut: () => Promise<void>;
  user: AuthUser;
  showReportProblem: boolean;
}) {
  const [status, setStatus] = useState<StaffAccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getIdToken()
      .then((token) => getStaffAccessStatus(token))
      .then((response) => {
        if (active) setStatus(response.request);
      })
      .catch((statusError: unknown) => {
        if (active) {
          setError(statusError instanceof Error ? statusError.message : "Status is unavailable");
        }
      });
    return () => {
      active = false;
    };
  }, [getIdToken]);

  async function submitAndRefresh(reason: string) {
    const response = (await requestAccess(reason)) as {
      request?: StaffAccessStatus;
    };
    if (response.request) setStatus(response.request);
  }

  const copy = status ? requestCopy(status) : null;
  const canSubmit =
    status?.state === "not_requested" ||
    status?.state === "denied" ||
    status?.state === "expired";

  return (
    <AuthFrame>
      <div className="auth-copy">
        <h1>{copy?.title ?? "Checking your access request"}</h1>
        <p>{copy?.body ?? `Checking the request for ${user.email}.`}</p>
      </div>
      {!status && !error ? (
        <LoadingIndicator
          label="Loading request status"
          stages={["Asking the CMS for your access request", "Reading its decision state"]}
        />
      ) : null}
      {status?.reference ? (
        <p className="auth-domain-note">Reference: {status.reference}</p>
      ) : null}
      {canSubmit ? (
        <RequestAccessForm
          label={status.state === "not_requested" ? "Request access" : "Send a new request"}
          requestAccess={submitAndRefresh}
        />
      ) : null}
      {status?.state === "ready" ? (
        <Button onClick={() => window.location.reload()} variant="primary">
          Open the newsroom
        </Button>
      ) : null}
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      {showReportProblem ? <AccessScreenReportBoundary>
        <Suspense fallback={null}>
          <AccessScreenReportProblemDialog
            currentPath={window.location.pathname}
            getIdToken={getIdToken}
            canOpenReport={false}
          />
        </Suspense>
      </AccessScreenReportBoundary> : null}
      <Button onClick={signOut}>Sign out</Button>
    </AuthFrame>
  );
}

export default function App() {
  // Phones always use icon-only controls; wider screens follow the saved preference.
  const phone = useMediaQuery("(max-width: 48rem)");
  const {
    createAccount,
    getIdToken,
    requestAccess,
    resetPassword,
    signIn,
    signInWithEmail,
    signOut,
    state,
  } = useAuth();

  const routerReady = useRouterReady();

  const parameters = new URLSearchParams(window.location.search);
  if (parameters.get("mode") === "verifyEmail" && parameters.get("oobCode")) {
    return <EmailActionView signOut={signOut} />;
  }
  if (state.status === "loading") return <BootstrapView stage={state.stage} />;
  if (state.status === "signed-out") {
    return (
      <SignedOutView
        createAccount={createAccount}
        resetPassword={resetPassword}
        sessionEnded={state.sessionEnded === true}
        signInWithEmail={signInWithEmail}
        signInWithGoogle={signIn}
      />
    );
  }
  if (state.status === "email-unverified") {
    return (
      <EmailVerificationView
        initialError={state.verification?.error}
        initialMailState={state.verification?.mailState}
        requestAccess={requestAccess}
        signOut={signOut}
        user={state.user}
      />
    );
  }
  if (state.status === "access-denied") {
    return <UnverifiableAccountView email={state.email} signOut={signOut} />;
  }
  if (state.status === "error") {
    return <ErrorView message={state.error.message} signOut={signOut} />;
  }
  if (!canAccessAdmin(state.principal)) {
    return (
      <DeniedView
        showReportProblem={canSubmitProblemReport(state.principal)}
        getIdToken={getIdToken}
        requestAccess={requestAccess}
        signOut={signOut}
        user={state.user}
      />
    );
  }

  const staffSite = parameters.get("staffSite");
  if (staffSite) return <StaffSiteHandoff destination={staffSite} getIdToken={getIdToken} />;

  // Admission is done but the route's code is still arriving: the last bootstrap phase. Holding
  // the same screen here completes the checklist and makes one swap into the shell instead of
  // a shell that mounts empty and then fills.
  if (!routerReady) return <BootstrapView stage="workspace" />;

  return (
    <ControlPresentationProvider value={phone ? "icons" : readControlPresentation(state.userDoc)}>
      <ShellProvider
        value={{
          principal: state.principal,
          user: state.user,
          userDoc: state.userDoc,
          signOut,
          getIdToken,
        }}
      >
        <LiveProductionProvider key={state.user.uid}>
          <RouterProvider router={appRouter} />
        </LiveProductionProvider>
      </ShellProvider>
    </ControlPresentationProvider>
  );
}
