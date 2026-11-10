import { describe, expect, it } from "vitest";
import {
  buildEventPayload,
  decideServerEvent,
  parseConsentCookie,
  parseGaClientId,
} from "../src/lib/measurement-protocol";

const CLIENT_ID = "1234567890.1234567890";
const GA_COOKIE = `_ga=GA1.1.${CLIENT_ID}`;
const GRANTED =
  "njpbs-consent=v4:analytics=granted,mailchimp=granted,activecampaign=granted,wisepops=granted,ads=denied";
const SESSION_PARAMS = { session_id: 1712345678, engagement_time_msec: 1 };

describe("parseGaClientId", () => {
  it("reads the client id out of the _ga cookie", () => {
    expect(parseGaClientId(GA_COOKIE)).toBe(CLIENT_ID);
  });

  it.each(["GA1.1", "GA1.2", "GA1.3"])(
    "reads it whatever domain-component count GA wrote (%s)",
    (prefix) => {
      // The digit after GA1 is how many domain components the tag scoped the cookie
      // to; it varies with the host and is not part of the client id.
      expect(parseGaClientId(`_ga=${prefix}.${CLIENT_ID}`)).toBe(CLIENT_ID);
    },
  );

  it("finds _ga among other cookies, in any position", () => {
    expect(parseGaClientId(`foo=bar; ${GA_COOKIE}; baz=qux`)).toBe(CLIENT_ID);
    expect(parseGaClientId(`${GA_COOKIE}; foo=bar`)).toBe(CLIENT_ID);
  });

  it("tolerates the spacing browsers actually send", () => {
    expect(parseGaClientId(`foo=bar;_ga=GA1.1.${CLIENT_ID}`)).toBe(CLIENT_ID);
    expect(parseGaClientId(`  _ga=GA1.1.${CLIENT_ID}  `)).toBe(CLIENT_ID);
  });

  it("does not mistake the _ga_<container> session cookie for the client id", () => {
    // GA sets both. _ga_G-ABC123 holds session state in a GS... format that has itself
    // changed shape over time, and a prefix match would read it as a client id and
    // stitch the event to a session that does not exist. The name comparison is exact,
    // so the value here can be any vintage.
    expect(parseGaClientId("_ga_G-ABC123=GS1.1.1712345678.1.0.1712345680.0.0.0")).toBeNull();
  });

  it("still finds the real _ga when the session cookie sits in front of it", () => {
    expect(parseGaClientId(`_ga_G-ABC123=GS1.1.9.9.9; ${GA_COOKIE}`)).toBe(CLIENT_ID);
  });

  it.each([
    ["", "empty header"],
    ["foo=bar", "no _ga at all"],
    ["_ga=", "empty value"],
    ["_ga=GA1.1.", "prefix but no client id"],
    ["_ga=GA1.1.notanid", "client id is not the <random>.<timestamp> shape"],
    ["_ga=GA1.1.123", "client id missing its timestamp half"],
    ["_ga=GA2.1.1.2", "unknown cookie version"],
    ["_ga=1234567890.1234567890", "bare client id with no GA1 prefix"],
  ])("returns null for %j (%s)", (cookie) => {
    expect(parseGaClientId(cookie)).toBeNull();
  });

  it.each([[null], [undefined], [42]])("returns null for the non-string header %j", (header) => {
    expect(parseGaClientId(header as unknown as string)).toBeNull();
  });

  it("survives a percent-encoded _ga value", () => {
    // A GA client id has nothing encodeURIComponent would escape, so this is the
    // no-op case. It is pinned because the decode lives in the shared cookie reader,
    // and a change made for the consent cookie must not break this one.
    expect(parseGaClientId(`_ga=GA1.1.${CLIENT_ID}`)).toBe(CLIENT_ID);
  });

  it("fails closed on an undecodable _ga value rather than throwing", () => {
    expect(parseGaClientId("_ga=GA1.1.%ZZ")).toBeNull();
  });

  it("fails closed when the header contains duplicate _ga cookies", () => {
    expect(parseGaClientId(`${GA_COOKIE}; ${GA_COOKIE}`)).toBeNull();
  });
});

describe("parseConsentCookie", () => {
  it("reads a granted analytics decision", () => {
    expect(parseConsentCookie(GRANTED)).toBe("granted");
  });

  it("reads an explicit denial", () => {
    expect(parseConsentCookie("njpbs-consent=v4:analytics=denied")).toBe("denied");
  });

  it("distinguishes an explicit denial from no legible decision at all", () => {
    // Both suppress. Only the second can mean the banner and this reader disagree
    // about the format, which is the failure a working deployment never shows.
    expect(parseConsentCookie("njpbs-consent=v4:analytics=denied")).toBe("denied");
    expect(parseConsentCookie("")).toBe("absent");
  });

  it("ignores other keys in the cookie and other cookies around it", () => {
    expect(parseConsentCookie("a=b; njpbs-consent=v4:ads=denied,analytics=granted; c=d")).toBe("granted");
  });

  it("reads a value a standard cookie serializer percent-encoded", () => {
    // encodeURIComponent escapes both ":" and "=", so a banner using an ordinary
    // serializer writes v4%3Aanalytics%3Dgranted. Reading that literally would find
    // no version separator and silently report every consenting visitor as denied.
    expect(parseConsentCookie("njpbs-consent=v4%3Aanalytics%3Dgranted")).toBe("granted");
  });

  it("fails closed when the value cannot be decoded at all", () => {
    expect(parseConsentCookie("njpbs-consent=v4%3Aanalytics%3Dgranted%ZZ")).toBe("absent");
  });

  it.each([
    ["", "no cookie"],
    ["njpbs-consent=", "empty value"],
    ["njpbs-consent=v4:ads=granted", "no analytics key"],
    ["njpbs-consent=v1:analytics=granted", "an expired consent version"],
    ["njpbs-consent=v2:analytics=granted,mailchimp=granted,ads=denied", "a grant before ActiveCampaign was disclosed"],
    ["njpbs-consent=v3:analytics=granted,mailchimp=granted,activecampaign=granted,ads=denied", "a grant before Wisepops was disclosed"],
    ["njpbs-consent=granted", "unversioned legacy value"],
  ])("reports no legible decision for %j (%s)", (cookie) => {
    // Nobody has recorded a yes here, and nobody has recorded a no either. This is
    // the shape a format disagreement takes.
    expect(parseConsentCookie(cookie)).toBe("absent");
  });

  it.each([
    ["njpbs-consent=v4:analytics=maybe", "unrecognized value"],
    ["njpbs-consent=v4:analytics=GRANTED", "wrong case"],
  ])("reads a legible-but-not-granted analytics value as denied (%j, %s)", (cookie) => {
    // The cookie parsed and the key is there; the value just is not the one word
    // that means yes. That is a refusal, not a missing decision.
    expect(parseConsentCookie(cookie)).toBe("denied");
  });

  it.each([
    [`${GRANTED}; njpbs-consent=v4:analytics=denied`, "conflicting decisions"],
    [`${GRANTED}; ${GRANTED}`, "duplicate matching decisions"],
  ])("fails closed on duplicate consent cookies (%s: %s)", (cookie) => {
    expect(parseConsentCookie(cookie)).toBe("absent");
  });
});

describe("decideServerEvent", () => {
  it("sends when consent is granted, GPC is absent, and a client id is present", () => {
    const decision = decideServerEvent({ cookieHeader: `${GA_COOKIE}; ${GRANTED}` });
    expect(decision).toEqual({ send: true, clientId: CLIENT_ID });
  });

  it("suppresses with consent-denied when the visitor said no", () => {
    const decision = decideServerEvent({
      cookieHeader: `${GA_COOKIE}; njpbs-consent=v4:analytics=denied`,
    });
    expect(decision).toEqual({ send: false, reason: "consent-denied" });
  });

  it("suppresses with no-consent-cookie when there is no legible decision", () => {
    // This covers both an undecided visitor and a broken banner/reader contract.
    // A sustained unexpected rate can expose the latter once the banner ships.
    const decision = decideServerEvent({ cookieHeader: GA_COOKIE });
    expect(decision).toEqual({ send: false, reason: "no-consent-cookie" });
  });

  it("reports no-consent-cookie when the banner shipped a format this cannot read", () => {
    const decision = decideServerEvent({ cookieHeader: `${GA_COOKIE}; njpbs-consent=granted` });
    expect(decision).toEqual({ send: false, reason: "no-consent-cookie" });
  });

  it("reports no-consent-cookie instead of trusting either duplicate consent value", () => {
    const decision = decideServerEvent({
      cookieHeader: `${GA_COOKIE}; ${GRANTED}; njpbs-consent=v4:analytics=denied`,
    });
    expect(decision).toEqual({ send: false, reason: "no-consent-cookie" });
  });

  it("reports no-client-id instead of trusting either duplicate _ga value", () => {
    const decision = decideServerEvent({
      cookieHeader: `${GA_COOKIE}; ${GA_COOKIE}; ${GRANTED}`,
    });
    expect(decision).toEqual({ send: false, reason: "no-client-id" });
  });

  it("suppresses when GPC is set, even with consent granted", () => {
    // NJDPA's universal opt-out duty has been live since 2025-07-15. A stored
    // yes does not survive the browser saying no on this request.
    const decision = decideServerEvent({
      cookieHeader: `${GA_COOKIE}; ${GRANTED}`,
      gpcHeader: "1",
    });
    expect(decision).toEqual({ send: false, reason: "gpc" });
  });

  it.each(["1", " 1 "])("treats Sec-GPC: %j as an opt-out", (gpcHeader) => {
    expect(decideServerEvent({ cookieHeader: `${GA_COOKIE}; ${GRANTED}`, gpcHeader }).send).toBe(false);
  });

  it.each(["0", "", "true", "yes"])(
    "does not treat Sec-GPC: %j as an opt-out, since only \"1\" carries the signal",
    (gpcHeader) => {
      expect(decideServerEvent({ cookieHeader: `${GA_COOKIE}; ${GRANTED}`, gpcHeader }).send).toBe(true);
    },
  );

  it("reports GPC ahead of a missing client id, so the log says the user opted out", () => {
    // Both suppress. Which reason gets recorded decides whether a later audit can
    // tell "we honored an opt-out" from "we lost the cookie".
    const decision = decideServerEvent({ cookieHeader: GRANTED, gpcHeader: "1" });
    expect(decision).toEqual({ send: false, reason: "gpc" });
  });

  it("suppresses rather than sending anonymously when the client id is missing", () => {
    // A conversion with no client id stitches to nothing, and inventing one would
    // create a phantom session. There is nothing worth sending here.
    const decision = decideServerEvent({ cookieHeader: GRANTED });
    expect(decision).toEqual({ send: false, reason: "no-client-id" });
  });

  it("suppresses on a missing cookie header entirely", () => {
    expect(decideServerEvent({}).send).toBe(false);
  });
});

describe("buildEventPayload", () => {
  it("builds the Measurement Protocol body for a member_login", () => {
    expect(buildEventPayload(CLIENT_ID, "member_login", SESSION_PARAMS)).toEqual({
      client_id: CLIENT_ID,
      non_personalized_ads: true,
      events: [{ name: "member_login", params: SESSION_PARAMS }],
    });
  });

  it("carries the ecommerce parameters on a purchase", () => {
    const payload = buildEventPayload(CLIENT_ID, "purchase", {
      ...SESSION_PARAMS,
      transaction_id: "pi_123",
      value: 120,
      currency: "USD",
      recurring: true,
    });
    expect(payload.events[0]).toEqual({
      name: "purchase",
      params: {
        ...SESSION_PARAMS,
        transaction_id: "pi_123",
        value: 120,
        currency: "USD",
        recurring: true,
        items: [
          {
            item_id: "donation_recurring",
            item_name: "Recurring donation",
            price: 120,
            quantity: 1,
          },
        ],
      },
    });
  });

  it.each([
    [{ engagement_time_msec: 1 }, "session_id"],
    [{ session_id: 1712345678 }, "engagement_time_msec"],
    [{ session_id: 0, engagement_time_msec: 1 }, "session_id"],
    [{ session_id: 1712345678, engagement_time_msec: 0 }, "engagement_time_msec"],
    [{ session_id: "1712345678", engagement_time_msec: 1 }, "session_id"],
  ])("rejects an event without valid session attribution (%j: %s)", (params, field) => {
    expect(() => buildEventPayload(CLIENT_ID, "member_login", params)).toThrow(field);
  });

  it.each([
    [{ ...SESSION_PARAMS }, "missing"],
    [{ ...SESSION_PARAMS, transaction_id: "" }, "empty"],
    [{ ...SESSION_PARAMS, transaction_id: "   " }, "blank"],
  ])("rejects a purchase without a stable transaction id (%j: %s)", (params, _case) => {
    expect(() => buildEventPayload(CLIENT_ID, "purchase", params)).toThrow("transaction_id");
  });

  it("rejects a non-Stripe transaction id instead of treating caller text as safe", () => {
    expect(() =>
      buildEventPayload(CLIENT_ID, "purchase", {
        ...SESSION_PARAMS,
        transaction_id: "donor@example.org",
        value: 25,
        currency: "USD",
        recurring: false,
      }),
    ).toThrow("transaction_id");
  });

  it.each([
    [{ ...SESSION_PARAMS, transaction_id: "pi_123", currency: "USD", recurring: true }, "value"],
    [
      { ...SESSION_PARAMS, transaction_id: "pi_123", value: 0, currency: "USD", recurring: true },
      "value",
    ],
    [
      { ...SESSION_PARAMS, transaction_id: "pi_123", value: 25, currency: "usd", recurring: true },
      "currency",
    ],
    [
      { ...SESSION_PARAMS, transaction_id: "pi_123", value: 25, currency: "USD" },
      "recurring",
    ],
  ])("rejects an incomplete donation purchase (%j: %s)", (params, field) => {
    expect(() => buildEventPayload(CLIENT_ID, "purchase", params)).toThrow(field);
  });

  it("rejects event names outside the two server-owned conversions", () => {
    expect(() => buildEventPayload(CLIENT_ID, "sign_up", SESSION_PARAMS)).toThrow("event name");
  });

  it("rejects a client id that did not come from the validated GA cookie path", () => {
    expect(() => buildEventPayload("donor@example.org", "member_login", SESSION_PARAMS)).toThrow(
      "clientId",
    );
  });

  it("drops a top-level api_secret or measurement_id param", () => {
    // The secret belongs in the request URL the proxy builds, never in a body that
    // gets logged or echoed. The realistic accident is a caller spreading a config
    // object into params, and this is what catches it.
    const payload = buildEventPayload(CLIENT_ID, "member_login", {
      ...SESSION_PARAMS,
      api_secret: "shhh",
      measurement_id: "G-ABC123",
    } as Record<string, unknown>);
    expect(payload.events[0].params).toEqual(SESSION_PARAMS);
  });

  it("allowlists member-login params instead of forwarding PII-shaped input", () => {
    const payload = buildEventPayload(CLIENT_ID, "member_login", {
      ...SESSION_PARAMS,
      email: "donor@example.org",
      name: "A Donor",
      customer: { metadata: { source: "stripe" } },
    } as Record<string, unknown>);
    expect(payload.events[0].params).toEqual(SESSION_PARAMS);
  });

  it("builds a fixed donation item instead of forwarding caller-provided item data", () => {
    const payload = buildEventPayload(CLIENT_ID, "purchase", {
      ...SESSION_PARAMS,
      transaction_id: "pi_123",
      value: 25,
      currency: "USD",
      recurring: false,
      items: [{ item_name: "donor@example.org", customer_name: "A Donor" }],
    });
    expect(payload.events[0].params).toEqual({
      ...SESSION_PARAMS,
      transaction_id: "pi_123",
      value: 25,
      currency: "USD",
      recurring: false,
      items: [
        {
          item_id: "donation_one_time",
          item_name: "One-time donation",
          price: 25,
          quantity: 1,
        },
      ],
    });
  });

  it("does not mutate the params object it is given", () => {
    const params = {
      ...SESSION_PARAMS,
      transaction_id: "pi_123",
      value: 25,
      currency: "USD",
      recurring: false,
      api_secret: "shhh",
    };
    const before = { ...params };
    buildEventPayload(CLIENT_ID, "purchase", params as Record<string, unknown>);
    expect(params).toEqual(before);
  });
});
