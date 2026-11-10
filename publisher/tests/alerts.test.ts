import { describe, expect, it, vi } from "vitest";
import worker, { handleAlert, type AlertsEnv } from "../alerts";

const ACCOUNT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET = "fixed-webhook-secret-with-at-least-32-characters";
const INTAKE_SECRET = "dummy-intake-key";
const CORRELATION = "00000000000000000000000000000000";
const EVENT = {
  account_id: ACCOUNT_ID,
  alert_type: "health_check_status_notification",
  alert_correlation_id: CORRELATION,
  alert_event: "ALERT_STATE_EVENT_START",
  data: {
    health_check_id: "publisher-check",
    status_change_time: "2026-10-12T12:00:00Z",
  },
};

function environment(overrides: Partial<AlertsEnv> = {}): AlertsEnv {
  return {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    ALERT_INTAKE_URL: "https://reports.example.org/intake",
    ALERT_WEBHOOK_SECRET: SECRET,
    INTAKE_SECRET,
    CF_ACCESS_CLIENT_ID: "dummy-access-id",
    CF_ACCESS_CLIENT_SECRET: "dummy-access-secret",
    ...overrides,
  };
}

function alertRequest(
  body: unknown,
  init: { auth?: string; headers?: HeadersInit } = {},
): Request {
  return new Request("https://publisher-alerts.njpbs.org/healthcheck", {
    method: "POST",
    headers: {
      "cf-webhook-auth": init.auth ?? SECRET,
      ...init.headers,
    },
    body:
      typeof body === "string"
        ? body
        : JSON.stringify(
            body && typeof body === "object" && !Array.isArray(body)
              ? { ...EVENT, ...body }
              : body,
          ),
  });
}

function mockedFetch(response?: Response) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return (
      response ??
      new Response(
        JSON.stringify({
          success: true,
          id: `publisher-${body.event[0]}-${body.incidentId}`,
        }),
      )
    );
  });
}

describe("Cloudflare health-check report relay", () => {
  it("exposes only the exact POST route and makes every response non-cacheable", async () => {
    const requestFn = mockedFetch();
    for (const request of [
      new Request("https://publisher-alerts.njpbs.org/healthcheck"),
      new Request("https://publisher-alerts.njpbs.org/healthcheck", {
        method: "HEAD",
      }),
      new Request("https://publisher-alerts.njpbs.org/"),
      new Request("https://publisher-alerts.njpbs.org/other", {
        method: "POST",
      }),
      new Request("https://publisher-alerts.njpbs.org/healthcheck?test=1", {
        method: "POST",
      }),
    ]) {
      const response = await handleAlert(request, environment(), requestFn);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(requestFn).not.toHaveBeenCalled();
  });

  it("returns 503 for invalid webhook, intake, or Access configuration", async () => {
    for (const env of [
      environment({ CLOUDFLARE_ACCOUNT_ID: "" }),
      environment({ CLOUDFLARE_ACCOUNT_ID: "invalid/account" }),
      environment({ ALERT_INTAKE_URL: "" }),
      environment({ ALERT_INTAKE_URL: "http://reports.example.org/intake" }),
      environment({ ALERT_INTAKE_URL: "https://user:password@reports.example.org/intake" }),
      environment({ ALERT_WEBHOOK_SECRET: "short" }),
      environment({ INTAKE_SECRET: "" }),
      environment({ CF_ACCESS_CLIENT_SECRET: "" }),
    ]) {
      const response = await handleAlert(alertRequest({ text: "test" }), env);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("rejects an invalid webhook secret before reading the body or calling intake", async () => {
    const request = alertRequest(
      { text: "must remain unread" },
      { auth: "wrong" },
    );
    let bodyRead = false;
    Object.defineProperty(request, "body", {
      get() {
        bodyRead = true;
        throw new Error("body must not be read");
      },
    });
    const requestFn = mockedFetch();

    const response = await handleAlert(request, environment(), requestFn);

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(bodyRead).toBe(false);
    expect(requestFn).not.toHaveBeenCalled();
  });

  it("forwards a failure through the fixed Bearer and Access intake contract", async () => {
    const requestFn = mockedFetch();
    const response = await handleAlert(
      alertRequest({
        text: "Origin unhealthy",
        url: "https://attacker.example/",
        chat_id: "other",
      }),
      environment(),
      requestFn,
    );
    expect(response.status).toBe(204);
    expect(requestFn).toHaveBeenCalledOnce();
    const [url, init] = requestFn.mock.calls[0];
    expect(url).toBe("https://reports.example.org/intake");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTAKE_SECRET}`,
        "CF-Access-Client-Id": "dummy-access-id",
        "CF-Access-Client-Secret": "dummy-access-secret",
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      source: "publisher",
      event: "failure",
      description:
        "[publisher] Publisher health check failed\n\nOrigin unhealthy",
      url: "https://publisher-health.njpbs.org/health",
    });
    expect(body.incidentId).toMatch(/^[a-f0-9]{32}$/);
    expect(Object.keys(body).sort()).toEqual([
      "description",
      "event",
      "incidentId",
      "source",
      "url",
    ]);
  });

  it("deduplicates retries by incident identity despite changed text and keeps recovery separate", async () => {
    const requestFn = mockedFetch();
    for (const body of [
      { text: "First notification" },
      { text: "Updated failure notification" },
      { text: "Recovered now", alert_event: "ALERT_STATE_EVENT_END" },
    ]) {
      expect(
        (await handleAlert(alertRequest(body), environment(), requestFn))
          .status,
      ).toBe(204);
    }
    const bodies = requestFn.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(new Set(bodies.map((b) => b.incidentId)).size).toBe(1);
    expect(bodies.map((b) => b.event)).toEqual([
      "failure",
      "failure",
      "recovery",
    ]);
    await handleAlert(
      alertRequest({
        text: "New outage",
        alert_correlation_id: "new-incident",
      }),
      environment(),
      requestFn,
    );
    expect(
      JSON.parse(String(requestFn.mock.calls[3][1]?.body)).incidentId,
    ).not.toBe(bodies[0].incidentId);
  });

  it("keeps same-transition retries stable and delivers later recurrence after cutover", async () => {
    const requestFn = mockedFetch();
    const env = environment({ ALERT_TRANSITION_CUTOVER: "2026-10-12T12:00:00Z" });
    for (const [time, text, event] of [
      ["2026-10-12T12:00:00Z", "First failure", "START"],
      ["2026-10-12T12:00:00Z", "Retry with changed text", "START"],
      ["2026-10-12T12:01:00Z", "Recovery", "END"],
      ["2026-10-12T12:02:00Z", "Next failure", "START"],
      ["2026-10-12T12:00:00Z", "Delayed first retry", "START"],
    ]) {
      expect((await handleAlert(alertRequest({ text,
        alert_event: `ALERT_STATE_EVENT_${event}`,
        data: { ...EVENT.data, status_change_time: time },
      }), env, requestFn)).status).toBe(204);
    }
    const ids = requestFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).incidentId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[4]).toBe(ids[0]);
    expect(new Set([ids[0], ids[2], ids[3]]).size).toBe(3);
  });

  it("preserves pre-cutover keys for late delivery and missing configuration", async () => {
    const requestFn = mockedFetch();
    for (const env of [environment(), environment({ ALERT_TRANSITION_CUTOVER: "2026-10-12T12:00:01Z" })])
      await handleAlert(alertRequest({text: "Pre-cutover failure"}), env, requestFn);
    const reports = requestFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(reports[0].incidentId).toBe(reports[1].incidentId);
  });

  it("retains legacy identities for a cutover finer than milliseconds", async () => {
    const requestFn = mockedFetch();
    for (const cutover of [undefined, "2026-10-13T19:00:00.000900000Z",
      "2026-10-13T19:00:00.0009Z", "2026-10-13T19:00:00.000Z"]) {
      expect((await handleAlert(alertRequest({ text: "Delayed transition",
        data: { ...EVENT.data, status_change_time: "2026-10-13T19:00:00.000100000Z" },
      }), environment({ ALERT_TRANSITION_CUTOVER: cutover }), requestFn)).status).toBe(204);
    }
    const ids = requestFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).incidentId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
    expect(ids[3]).not.toBe(ids[0]);
  });

  it.each([undefined, "", "2026-02-30T12:00:00Z", "2026-10-12T24:00:00Z",
    "2026-10-12T12:00:60Z", "2026-10-12", "2026-10-12T12:00:00", "not-a-date"])(
    "keeps the legacy key for invalid transition or cutover %s", async (time) => {
      const requestFn = mockedFetch();
      await handleAlert(alertRequest({text: "Legacy"}), environment(), requestFn);
      await handleAlert(alertRequest({text: "Invalid transition", data: {...EVENT.data, status_change_time: time}}),
        environment({ALERT_TRANSITION_CUTOVER: "2026-10-12T00:00:00Z"}), requestFn);
      await handleAlert(alertRequest({text: "Invalid cutover"}),
        environment({ALERT_TRANSITION_CUTOVER: time}), requestFn);
      const ids = requestFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).incidentId);
      expect(new Set(ids).size).toBe(1);
    });

  it("uses a stable transition timestamp for older payloads without a correlation", async () => {
    const requestFn = mockedFetch();
    for (const text of ["First notification", "Repeated notification"]) {
      expect(
        (
          await handleAlert(
            alertRequest({ text, alert_correlation_id: null }),
            environment(),
            requestFn,
          )
        ).status,
      ).toBe(204);
    }
    expect(
      JSON.parse(String(requestFn.mock.calls[0][1]?.body)).incidentId,
    ).toBe(JSON.parse(String(requestFn.mock.calls[1][1]?.body)).incidentId);
  });

  it("accepts Cloudflare's text-only test as an informational report", async () => {
    const requestFn = mockedFetch();
    const response = await handleAlert(
      alertRequest(
        JSON.stringify({ text: "Hello World! This is a test message." }),
      ),
      environment(),
      requestFn,
    );
    expect(response.status).toBe(204);
    expect(JSON.parse(String(requestFn.mock.calls[0][1]?.body)).event).toBe(
      "test",
    );
  });

  it("gives repeated webhook tests distinct report IDs for card delivery", async () => {
    const requestFn = mockedFetch();
    const raw = JSON.stringify({ text: "Hello World! This is a test message." });
    for (let run = 0; run < 2; run++) {
      expect(
        (await handleAlert(alertRequest(raw), environment(), requestFn)).status,
      ).toBe(204);
    }
    const reports = requestFn.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    for (const report of reports) {
      expect(report.event).toBe("test");
      expect(report.incidentId).toMatch(/^[a-f0-9]{32}$/);
    }
    expect(reports[1].incidentId).not.toBe(reports[0].incidentId);
  });

  it.each([
    { text: "Legacy state notification", alert_event: "unknown" },
    { text: "Legacy notification", data: {} },
    {
      text: "No identity available",
      data: { health_check_id: "check" },
      alert_correlation_id: null,
    },
  ])(
    "retains authenticated legacy notifications for triage: %s",
    async (body) => {
      const requestFn = mockedFetch();
      expect(
        (await handleAlert(alertRequest(body), environment(), requestFn))
          .status,
      ).toBe(204);
      expect(JSON.parse(String(requestFn.mock.calls[0][1]?.body)).event).toBe(
        "failure",
      );
    },
  );

  it.each(["new_health_status", "new_status", "status"])(
    "uses legacy %s and retains unclassified text-only alerts",
    async (field) => {
      const requestFn = mockedFetch();
      for (const status of ["Healthy", "Unhealthy"]) {
        await handleAlert(
          alertRequest({
            text: "Legacy status changed",
            alert_event: null,
            data: { ...EVENT.data, [field]: status },
          }),
          environment(),
          requestFn,
        );
      }
      await handleAlert(
        alertRequest(JSON.stringify({ text: "Unspecified health notification" })),
        environment(),
        requestFn,
      );
      const bodies = requestFn.mock.calls.map(([, init]) =>
        JSON.parse(String(init?.body)),
      );
      expect(bodies.map((body) => body.event)).toEqual([
        "recovery",
        "failure",
        "failure",
      ]);
      expect(bodies[0].description).toBe(
        "[publisher] Publisher health check recovered\n\nLegacy status changed",
      );
      expect(bodies[2].description).toContain("Unclassified health notification");
    },
  );

  it("deduplicates identical no-identity notifications without inventing a timestamp", async () => {
    const requestFn = mockedFetch();
    const raw = JSON.stringify({ text: "Legacy health notification" });
    for (let retry = 0; retry < 2; retry++)
      await handleAlert(alertRequest(raw), environment(), requestFn);
    expect(
      JSON.parse(String(requestFn.mock.calls[0][1]?.body)).incidentId,
    ).toBe(JSON.parse(String(requestFn.mock.calls[1][1]?.body)).incidentId);
  });

  it.each([
    [{ text: "valid", account_id: "another-account" }, "wrong account"],
    [{ text: "valid", alert_type: "workers_alert" }, "wrong alert type"],
    [{ text: "   " }, "blank text"],
    [{ text: 12 }, "non-string text"],
    [["not", "an", "object"], "array body"],
  ])("rejects %s (%s) without sending", async (body) => {
    const requestFn = mockedFetch();
    const response = await handleAlert(
      alertRequest(body),
      environment(),
      requestFn,
    );

    expect(response.status).toBe(400);
    expect(requestFn).not.toHaveBeenCalled();
  });

  it("counts Unicode characters and bounds the stored description", async () => {
    const accepted = mockedFetch();
    await expect(
      handleAlert(
        alertRequest({ text: "😀".repeat(3_500) }),
        environment(),
        accepted,
      ),
    ).resolves.toMatchObject({ status: 204 });
    expect(accepted).toHaveBeenCalledOnce();
    expect(
      Array.from(
        JSON.parse(String(accepted.mock.calls[0][1]?.body)).description,
      ).length,
    ).toBe(2000);

    const refused = mockedFetch();
    await expect(
      handleAlert(
        alertRequest({ text: "😀".repeat(3_501) }),
        environment(),
        refused,
      ),
    ).resolves.toMatchObject({ status: 400 });
    expect(refused).not.toHaveBeenCalled();
  });

  it("enforces the request limit with an absent or false Content-Length", async () => {
    const body = JSON.stringify({ text: "x".repeat(32 * 1_024) });
    for (const headers of [
      { "cf-webhook-auth": SECRET },
      { "cf-webhook-auth": SECRET, "Content-Length": "2" },
    ]) {
      const requestFn = mockedFetch();
      const response = await handleAlert(
        new Request("https://publisher-alerts.njpbs.org/healthcheck", {
          method: "POST",
          headers,
          body,
        }),
        environment(),
        requestFn,
      );
      expect(response.status).toBe(413);
      expect(requestFn).not.toHaveBeenCalled();
    }
  });

  it("uses declared oversize and malformed lengths without reading the request", async () => {
    for (const [length, status] of [
      [String(32 * 1_024 + 1), 413],
      ["not-a-number", 400],
    ] as const) {
      const requestFn = mockedFetch();
      const response = await handleAlert(
        alertRequest(
          { text: "valid" },
          { headers: { "Content-Length": length } },
        ),
        environment(),
        requestFn,
      );
      expect(response.status).toBe(status);
      expect(requestFn).not.toHaveBeenCalled();
    }
  });

  it("maps request stream errors to 400 without sending", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("read failed"));
      },
    });
    const request = new Request(
      "https://publisher-alerts.njpbs.org/healthcheck",
      {
        method: "POST",
        headers: { "cf-webhook-auth": SECRET },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    const requestFn = mockedFetch();

    const response = await handleAlert(request, environment(), requestFn);

    expect(response.status).toBe(400);
    expect(requestFn).not.toHaveBeenCalled();
  });

  it.each([
    ["network failure", () => Promise.reject(new Error("network failed"))],
    [
      "timeout",
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    ],
    [
      "HTTP refusal",
      () => Promise.resolve(new Response(null, { status: 429 })),
    ],
    [
      "intake refusal",
      () => Promise.resolve(new Response(JSON.stringify({ success: false }))),
    ],
    [
      "missing receipt",
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true, id: "another-report" })),
        ),
    ],
    [
      "oversize receipt",
      () => Promise.resolve(new Response("x".repeat(32 * 1_024 + 1))),
    ],
  ])("returns a generic 502 for %s", async (_name, implementation) => {
    const requestFn = vi.fn<typeof fetch>(implementation);
    const response = await handleAlert(
      alertRequest({ text: "provider error" }),
      environment(),
      requestFn,
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("binds the default Worker export to the same handler", async () => {
    const requestFn = mockedFetch();
    vi.stubGlobal("fetch", requestFn);
    try {
      const response = await worker.fetch(
        alertRequest({ text: "export path" }),
        environment(),
        {} as ExecutionContext,
      );
      expect(response.status).toBe(204);
      expect(requestFn).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
