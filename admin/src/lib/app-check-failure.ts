// A refused App Check token (401 or 403), a reCAPTCHA error, or a check that never finishes loading
// almost always means the browser kept reCAPTCHA from running: strict tracking protection, an ad or
// privacy blocker, or a network filter. Staff can fix that themselves, so say how. Other statuses
// are a service problem, and a network failure keeps its own message.
export const BLOCKED_SECURITY_CHECK_MESSAGE =
  "Your browser blocked Boardwalk's security check. Allow it for admin.njpbs.org in your browser's " +
  "tracking protection or ad blocker, then reload Boardwalk.";
export const UNAVAILABLE_SECURITY_CHECK_MESSAGE =
  "Boardwalk's security check is not responding. Try again in a few minutes.";

// The reCAPTCHA script can be blocked without any error: the token request then never settles.
// A stalled service looks the same from here, so the message covers both.
export const SECURITY_CHECK_TIMEOUT_MS = 20_000;
export const STALLED_SECURITY_CHECK_MESSAGE =
  "Boardwalk's security check did not finish. If your browser's tracking protection or ad blocker " +
  "is on for admin.njpbs.org, allow the check there and reload Boardwalk. Otherwise try again in a few minutes.";

export function appCheckFailure(error: unknown): unknown {
  const { code, customData } = (error ?? {}) as { code?: unknown; customData?: { httpStatus?: unknown } };
  if (code === "appCheck/fetch-network-error") return error;
  const status = customData?.httpStatus;
  const blocked = code === "appCheck/recaptcha-error" || status === 401 || status === 403;
  return new Error(blocked ? BLOCKED_SECURITY_CHECK_MESSAGE : UNAVAILABLE_SECURITY_CHECK_MESSAGE, { cause: error });
}

export async function withSecurityCheckTimeout<T>(pending: Promise<T>, ms = SECURITY_CHECK_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(STALLED_SECURITY_CHECK_MESSAGE)), ms);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// The actionable text for a request the security check stopped, for handlers that otherwise show
// a generic failure. The request wrapper copies the message, so the text identifies the case.
export function securityCheckMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : null;
  return message === BLOCKED_SECURITY_CHECK_MESSAGE || message === UNAVAILABLE_SECURITY_CHECK_MESSAGE ||
    message === STALLED_SECURITY_CHECK_MESSAGE ? message : null;
}
