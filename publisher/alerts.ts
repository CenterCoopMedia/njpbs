const HEALTH_CHECK_ALERT_TYPE = "health_check_status_notification";
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_INTAKE_RESPONSE_BYTES = 32 * 1024;
const MAX_TEXT_CHARACTERS = 3_500;
const INTAKE_TIMEOUT_MS = 10_000;
const HEALTH_URL = "https://publisher-health.njpbs.org/health";

export interface AlertsEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  ALERT_INTAKE_URL: string;
  ALERT_WEBHOOK_SECRET: string;
  ALERT_TRANSITION_CUTOVER?: string;
  INTAKE_SECRET: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
}

class SizeLimitError extends Error {}

function emptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function configured(env: AlertsEnv): boolean {
  try {
    const url = new URL(env.ALERT_INTAKE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
  } catch { return false; }
  return (
    /^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") &&
    typeof env.ALERT_WEBHOOK_SECRET === "string" &&
    env.ALERT_WEBHOOK_SECRET.length >= 32 &&
    env.ALERT_WEBHOOK_SECRET.length <= 1_024 &&
    !/[\u0000-\u001f\u007f]/.test(env.ALERT_WEBHOOK_SECRET) &&
    [
      env.INTAKE_SECRET,
      env.CF_ACCESS_CLIENT_ID,
      env.CF_ACCESS_CLIENT_SECRET,
    ].every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 1_024 &&
        !/[\u0000-\u0020\u007f]/.test(value),
    )
  );
}

async function authenticated(
  provided: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= providedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

function declaredLength(
  headers: Headers,
  limit: number,
): "ok" | "invalid" | "large" {
  const value = headers.get("Content-Length");
  if (value === null) return "ok";
  if (!/^(0|[1-9]\d*)$/.test(value)) return "invalid";
  const length = Number(value);
  if (!Number.isSafeInteger(length)) return "large";
  return length > limit ? "large" : "ok";
}

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new SizeLimitError();
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The result remains invalid if its stream could not be read or cancelled.
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readPayload(request: Request): Promise<Record<string, unknown>> {
  const length = declaredLength(request.headers, MAX_REQUEST_BYTES);
  if (length === "large") throw new SizeLimitError();
  if (length === "invalid") throw new Error("invalid length");
  const bytes = await readBounded(request.body, MAX_REQUEST_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("invalid JSON");
  }
  const payload = object(parsed);
  if (!payload) throw new Error("invalid payload");
  return payload;
}

function validatedText(payload: Record<string, unknown>, accountId: string): string | null {
  if (typeof payload.text !== "string" || payload.text.trim().length === 0)
    return null;
  if (Array.from(payload.text).length > MAX_TEXT_CHARACTERS) return null;
  if (
    Object.hasOwn(payload, "account_id") &&
    payload.account_id !== accountId
  )
    return null;
  if (
    Object.hasOwn(payload, "alert_type") &&
    payload.alert_type !== HEALTH_CHECK_ALERT_TYPE
  )
    return null;
  return payload.text;
}

type PublisherEvent = "failure" | "recovery" | "test";

// Cloudflare health-check timestamps are UTC RFC 3339. Date.parse alone also
// accepts invalid calendar dates and non-standard formats, so check both.
function transitionTimestamp(value: unknown, maxFractionalDigits = 9): number | null {
  if (typeof value !== "string") return null;
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match || (match[1]?.length ?? 0) > maxFractionalDigits)
    return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19))
    return null;
  return timestamp;
}

async function publisherReport(
  payload: Record<string, unknown>, text: string, cutover: string | undefined,
) {
  const data = object(payload.data);
  let event: PublisherEvent;
  let identity: string;
  let unclassified = false;
  if (
    !data &&
    Object.keys(payload).length === 1 &&
    text.startsWith("Hello World! This is a test message")
  ) {
    event = "test";
    // Each manual test must exercise delivery, even after an earlier test card.
    identity = `cloudflare-webhook-test:${crypto.randomUUID()}`;
  } else {
    // Use structured state, never words in the human-readable notification.
    if (payload.alert_event === "ALERT_STATE_EVENT_START") event = "failure";
    else if (payload.alert_event === "ALERT_STATE_EVENT_END")
      event = "recovery";
    else {
      const status = String(
        data?.new_health_status ?? data?.new_status ?? data?.status ?? "",
      )
        .trim()
        .toLowerCase();
      if (status === "healthy") event = "recovery";
      else {
        // A valid authenticated notification must still reach triage if the
        // provider omits or extends its state fields. Never infer recovery.
        event = "failure";
        unclassified = status !== "unhealthy";
      }
    }
    const rawCheckId = data?.health_check_id;
    const checkId =
      typeof rawCheckId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(rawCheckId)
        ? rawCheckId
        : "publisher-health";
    const correlation = payload.alert_correlation_id;
    if (
      typeof correlation === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(correlation)
    ) {
      const transition = transitionTimestamp(data?.status_change_time);
      // Date.parse preserves milliseconds; the cutover must be exact at that precision.
      const boundary = transitionTimestamp(cutover, 3);
      // Correlation can span several outages. After the fixed cutover,
      // incidentId identifies a transition; failure/recovery are not a pair.
      // Delayed pre-cutover retries retain their original persisted key.
      identity = transition !== null && boundary !== null && transition >= boundary
        ? JSON.stringify([checkId, correlation, data?.status_change_time])
        : JSON.stringify([checkId, correlation]);
    } else {
      const time = data?.status_change_time;
      if (
        typeof time === "string" &&
        time.length > 0 &&
        time.length <= 128 &&
        !/[\u0000-\u001f\u007f]/.test(time)
      ) {
        identity = JSON.stringify([checkId, time]);
      } else {
        // Last resort: repeated identical legacy notifications share a key.
        // Changed evidence can create another card without a provider identity;
        // retaining an alert is preferable to losing the only outage signal.
        identity = JSON.stringify([checkId, event, text]);
      }
    }
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  );
  const incidentId = Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const heading = unclassified
    ? "[publisher] Unclassified health notification — verify publisher health"
    : {
        failure: "[publisher] Publisher health check failed",
        recovery: "[publisher] Publisher health check recovered",
        test: "[publisher] Alert relay test",
      }[event];
  return {
    source: "publisher",
    incidentId,
    event,
    description: Array.from(`${heading}\n\n${text}`).slice(0, 2_000).join(""),
    url: HEALTH_URL,
  };
}

async function intakeReceipt(
  response: Response,
  expectedId: string,
): Promise<boolean> {
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  if (declaredLength(response.headers, MAX_INTAKE_RESPONSE_BYTES) !== "ok") {
    await response.body?.cancel();
    return false;
  }
  let decoded: unknown;
  try {
    const bytes = await readBounded(response.body, MAX_INTAKE_RESPONSE_BYTES);
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return false;
  }
  const receipt = object(decoded);
  return receipt?.success === true && receipt.id === expectedId;
}

async function sendReport(
  report: NonNullable<Awaited<ReturnType<typeof publisherReport>>>,
  env: AlertsEnv,
  request: typeof fetch,
): Promise<boolean> {
  let response: Response;
  try {
    response = await request(env.ALERT_INTAKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.INTAKE_SECRET}`,
        "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
      },
      body: JSON.stringify(report),
      redirect: "manual",
      signal: AbortSignal.timeout(INTAKE_TIMEOUT_MS),
    });
  } catch {
    return false;
  }
  return intakeReceipt(
    response,
    `publisher-${report.event[0]}-${report.incidentId}`,
  );
}

export async function handleAlert(
  request: Request,
  env: AlertsEnv,
  requestFn: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== "/healthcheck" ||
    url.search.length > 0
  )
    return emptyResponse(404);

  if (!configured(env)) return emptyResponse(503);

  const authorized = await authenticated(
    request.headers.get("cf-webhook-auth") ?? "",
    env.ALERT_WEBHOOK_SECRET,
  );
  if (!authorized) return emptyResponse(403);

  let payload: Record<string, unknown>;
  try {
    payload = await readPayload(request);
  } catch (error) {
    return emptyResponse(error instanceof SizeLimitError ? 413 : 400);
  }
  const text = validatedText(payload, env.CLOUDFLARE_ACCOUNT_ID);
  if (text === null) return emptyResponse(400);

  const report = await publisherReport(payload, text, env.ALERT_TRANSITION_CUTOVER);
  if (!(await sendReport(report, env, requestFn))) return emptyResponse(502);
  return emptyResponse(204);
}

export default {
  fetch(request, env) {
    return handleAlert(request, env);
  },
} satisfies ExportedHandler<AlertsEnv>;
