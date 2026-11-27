import { describe, expect, it, vi } from "vitest";
import {
  appCheckFailure,
  BLOCKED_SECURITY_CHECK_MESSAGE,
  securityCheckMessage,
  UNAVAILABLE_SECURITY_CHECK_MESSAGE,
  withSecurityCheckTimeout,
} from "../src/lib/app-check-failure";
import { RequestNotDispatchedError } from "../src/lib/functions";

const firebaseError = (code: string, httpStatus?: number) =>
  Object.assign(new Error(`AppCheck: ${code}`), { code, customData: httpStatus === undefined ? {} : { httpStatus } });

describe("App Check failure message", () => {
  it("names the browser fix when the check is refused or reCAPTCHA fails", () => {
    for (const error of [
      firebaseError("appCheck/initial-throttle", 401),
      firebaseError("appCheck/throttled", 401),
      firebaseError("appCheck/fetch-status-error", 403),
      firebaseError("appCheck/recaptcha-error"),
    ]) {
      const failure = appCheckFailure(error);
      expect((failure as Error).message).toBe(BLOCKED_SECURITY_CHECK_MESSAGE);
      // The request wrapper copies this message, so handlers can recognize it.
      expect(securityCheckMessage(new RequestNotDispatchedError(failure))).toBe(BLOCKED_SECURITY_CHECK_MESSAGE);
    }
  });

  it("does not blame the browser for a service failure", () => {
    const failure = appCheckFailure(firebaseError("appCheck/initial-throttle", 503));
    expect((failure as Error).message).toBe(UNAVAILABLE_SECURITY_CHECK_MESSAGE);
  });

  it("keeps a network failure as it is", () => {
    const offline = firebaseError("appCheck/fetch-network-error");
    expect(appCheckFailure(offline)).toBe(offline);
    expect(securityCheckMessage(offline)).toBeNull();
  });

  it("treats a check that never finishes as blocked", async () => {
    vi.useFakeTimers();
    try {
      const pending = withSecurityCheckTimeout(new Promise<never>(() => undefined), 1_000);
      const outcome = expect(pending).rejects.toThrow(BLOCKED_SECURITY_CHECK_MESSAGE);
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a token that arrives in time", async () => {
    await expect(withSecurityCheckTimeout(Promise.resolve({ token: "t" }), 1_000)).resolves.toEqual({ token: "t" });
  });
});
