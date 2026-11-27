// A refused or throttled App Check token almost always means the browser kept reCAPTCHA from
// running: strict tracking protection, an ad or privacy blocker, or a network filter. Staff can
// fix that themselves, so say how. A network failure keeps its own message.
export const BLOCKED_SECURITY_CHECK_MESSAGE =
  "Your browser blocked Boardwalk's security check. Allow it for admin.njpbs.org in your browser's " +
  "tracking protection or ad blocker, then reload Boardwalk.";

export function appCheckFailure(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "appCheck/fetch-network-error") return error;
  return new Error(BLOCKED_SECURITY_CHECK_MESSAGE, { cause: error });
}
