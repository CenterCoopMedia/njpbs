import { describe, expect, it } from "vitest";
import { appCheckFailure, BLOCKED_SECURITY_CHECK_MESSAGE } from "../src/lib/app-check-failure";
import { RequestNotDispatchedError } from "../src/lib/functions";

describe("App Check failure message", () => {
  it("names the browser fix for a refused or throttled token", () => {
    for (const code of ["appCheck/fetch-status-error", "appCheck/throttled", "appCheck/initial-throttle", "appCheck/recaptcha-error"]) {
      const failure = appCheckFailure(Object.assign(new Error("AppCheck: 401 error."), { code }));
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(BLOCKED_SECURITY_CHECK_MESSAGE);
      // The request wrapper copies this message, so every refused upload or edit shows it.
      expect(new RequestNotDispatchedError(failure).message).toBe(BLOCKED_SECURITY_CHECK_MESSAGE);
    }
  });

  it("keeps a network failure as it is", () => {
    const offline = Object.assign(new Error("network"), { code: "appCheck/fetch-network-error" });
    expect(appCheckFailure(offline)).toBe(offline);
  });
});
