export const SESSION_ENDED_MESSAGE = "Your session ended. Sign in again.";

export const SESSION_ENDED_EVENT = "boardwalk-session-ended";

const SESSION_ENDED_KEY = "njpbs-admin:session-ended";
const DELIBERATE_SIGN_OUT_KEY = "njpbs-admin:deliberate-sign-out";

type TokenClaims = { sub?: unknown; auth_time?: unknown };

// One object per signed-in session, so a session ends once. It holds the claims of the token
// that admitted the session. They stay the same across a refresh and change at each sign-in,
// so a late refusal of an earlier session's token cannot end the session that replaced it.
let session: TokenClaims | null = null;
let currentToken: string | null = null;
let endedInThisTab = false;
let deliberateInThisTab = false;

export function beginSessionScope(signedIn: boolean): void {
  session = signedIn ? {} : null;
  currentToken = null;
}

export function sessionScope(): object | null {
  return session;
}

export function bindSessionToken(idToken: string): void {
  if (session) {
    const claims = tokenClaims(idToken);
    Object.assign(session, { sub: claims?.sub, auth_time: claims?.auth_time });
    currentToken = idToken;
  }
}

export function isSessionRejection(status: unknown, data: unknown): boolean {
  return status === 401 && typeof data === "object" && data !== null &&
    (data as { code?: unknown }).code === "session_expired";
}

export function isSessionExpiredError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { sessionContinues?: unknown }).sessionContinues !== true &&
    isSessionRejection((error as { status?: unknown }).status, (error as { data?: unknown }).data);
}

export function reportSessionExpired(scope: object | null): void {
  if (!scope || scope !== session) return;
  session = null;
  currentToken = null;
  window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
}

function tokenClaims(idToken: string | null): TokenClaims | null {
  try {
    const payload = (idToken ?? "").split(".")[1] ?? "";
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as TokenClaims;
  } catch {
    return null;
  }
}

// A caller can hold a token across other waits, so only the token shows its session.
export function reportRefusedToken(idToken: string | null, data?: unknown): "obsolete_token" | undefined {
  const refused = tokenClaims(idToken);
  if (!session?.sub || refused?.sub !== session.sub || refused.auth_time !== session.auth_time) return;
  // The request still fails. Only an explicit expiry of a token Firebase already replaced may
  // leave the session in place. The current token ends it, so a browser clock that keeps Firebase
  // holding an expired token signs out once rather than failing every request.
  if ((data as { reason?: unknown } | undefined)?.reason === "token_expired" && idToken !== currentToken) {
    return "obsolete_token";
  }
  reportSessionExpired(session);
}

// Browser-wide, because a sign-out reaches every tab. Another tab must also keep the
// recovered work and show the same notice.
export function markSessionEnded(): void {
  endedInThisTab = true;
  try {
    localStorage.setItem(SESSION_ENDED_KEY, "1");
  } catch {
    // Blocked site storage holds no recovered work to keep.
  }
}

export function sessionEnded(): boolean {
  if (endedInThisTab) return true;
  try {
    return localStorage.getItem(SESSION_ENDED_KEY) !== null;
  } catch {
    return false;
  }
}

export function clearSessionEnded(): void {
  endedInThisTab = false;
  deliberateInThisTab = false;
  try {
    localStorage.removeItem(SESSION_ENDED_KEY);
    localStorage.removeItem(DELIBERATE_SIGN_OUT_KEY);
  } catch {
    // Nothing to clear when site storage is blocked.
  }
}

// Boardwalk marks each sign-out it starts, browser-wide, so every tab can tell it from the one
// Firebase starts itself when a token refresh is refused. No other signal exists: the SDK signs
// out before it rejects, and a proactive refresh never reaches Boardwalk at all.
export function markDeliberateSignOut(): void {
  deliberateInThisTab = true;
  try {
    localStorage.setItem(DELIBERATE_SIGN_OUT_KEY, "1");
  } catch {
    // Unreadable storage counts as deliberate below.
  }
}

export function deliberateSignOut(): boolean {
  if (deliberateInThisTab) return true;
  try {
    return localStorage.getItem(DELIBERATE_SIGN_OUT_KEY) !== null;
  } catch {
    return true;
  }
}
