import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ currentUser: { uid: "staff" } }));
// Only the SDK and HTTP boundaries are replaced; the request, reader and
// session-refusal modules run together with installed-reader adoption enabled.
vi.mock("firebase/auth", async (original) => ({
  ...await original<typeof import("firebase/auth")>(),
  getAuth: () => auth,
}));

let postFunction: typeof import("../src/lib/functions").postFunction;
let scope: typeof import("../src/lib/session-ended");
const ended = vi.fn();
const token = (authTime: number, expiresAt: number) =>
  `header.${btoa(JSON.stringify({ sub: "staff", auth_time: authTime, exp: expiresAt }))}.signature`;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_USE_EMULATORS", "false");
  vi.stubEnv("VITE_FIREBASE_API_KEY", "synthetic-api-key");
  vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "example.invalid");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "demo-njpbs");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "synthetic-app-id");
  vi.stubEnv("VITE_FUNCTIONS_BASE_URL", "https://dev-api.example.org");
  vi.stubEnv("VITE_CMS_READER_BRIDGE_ENABLED", "true");
  vi.stubEnv("VITE_CMS_READER_BRIDGE_MANIFEST", JSON.stringify({
    schemaVersion: 2, version: 1, functionsReader: "a".repeat(64), cmsApiReader: "b".repeat(64),
  }));
  sessionStorage.clear();
  ended.mockReset();
  ({ postFunction } = await import("../src/lib/functions"));
  scope = await import("../src/lib/session-ended");
  scope.beginSessionScope(true);
  window.addEventListener(scope.SESSION_ENDED_EVENT, ended);
});

afterEach(() => {
  scope.beginSessionScope(false);
  window.removeEventListener(scope.SESSION_ENDED_EVENT, ended);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([
  { name: "replacement sign-in", newSignIn: true, refresh: true, cancel: "none", reason: undefined, events: 0 },
  { name: "replacement with canceled opener", newSignIn: true, refresh: true, cancel: "first", reason: undefined, events: 0 },
  { name: "obsolete expired JWT after ordinary refresh", newSignIn: false, refresh: true, cancel: "none", reason: "token_expired", events: 0 },
  { name: "revoked session after ordinary refresh", newSignIn: false, refresh: true, cancel: "none", reason: undefined, events: 1 },
  { name: "current-token refusal", newSignIn: false, refresh: false, cancel: "none", reason: "token_expired", events: 1 },
  { name: "current-token refusal with canceled joining waiter", newSignIn: false, refresh: false, cancel: "second", reason: undefined, events: 1 },
])("attributes a shared open to its sent token: $name", async ({ newSignIn, refresh, cancel, reason, events }) => {
  const now = Math.floor(Date.now() / 1000);
  const firstToken = token(100, now - 10);
  const secondToken = refresh ? token(newSignIn ? 200 : 100, now + 3600) : firstToken;
  let release!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const fetchMock = vi.fn<typeof fetch>(async () => {
    const response = new Promise<Response>(resolve => { release = resolve; });
    started();
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  scope.bindSessionToken(firstToken);
  const first = postFunction("cmsPreviewStatus", firstToken, {}, {}, { signal: firstAbort.signal });
  const firstResult = first.catch(error => error);
  await ready;
  if (newSignIn) scope.beginSessionScope(true);
  scope.bindSessionToken(secondToken);
  const second = postFunction("cmsPreviewStatus", secondToken, {}, {}, { signal: secondAbort.signal });
  const secondResult = second.catch(error => error);
  if (cancel === "first") firstAbort.abort();
  if (cancel === "second") secondAbort.abort();
  release(Response.json({ error: "Invalid or expired authentication token", code: "session_expired",
    ...(reason ? { reason } : {}) }, { status: 401 }));
  const results = await Promise.all([firstResult, secondResult]);
  for (const [index, result] of results.entries()) {
    if (cancel === (index === 0 ? "first" : "second")) expect(result).toMatchObject({ name: "AbortError" });
    else expect(result).toMatchObject({ status: 401, data: { code: "session_expired" } });
  }
  expect(ended).toHaveBeenCalledTimes(events);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://dev-api.example.org/api/cms/v1/reader");
  expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${firstToken}`);
  expect(JSON.parse(String(init?.body)).action).toBe("open");
  expect(init?.signal).toBeUndefined();
});

it("uses each endpoint request's token after a shared successful open", async () => {
  const now = Math.floor(Date.now() / 1000);
  const oldToken = token(100, now - 10), currentToken = token(200, now + 3600);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let refuseCurrent = false;
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.action === "open") {
      await new Promise<void>(resolve => { release = resolve; started(); });
      const issuedAt = Date.now();
      return Response.json({ schemaVersion: 2, version: 1,
        identities: { functions: "a".repeat(64), cmsApi: "b".repeat(64) },
        leases: Object.fromEntries(Object.entries(body.sessionIds).map(([component, sessionId]) => [component,
          { sessionId, readerDigest: (component === "functions" ? "a" : "b").repeat(64),
            issuedAt, expiresAt: issuedAt + 24 * 60 * 60_000 }])) });
    }
    return refuseCurrent || new Headers(init?.headers).get("authorization") === `Bearer ${oldToken}`
      ? Response.json({ code: "session_expired" }, { status: 401 })
      : Response.json({ status: "pending" });
  });
  vi.stubGlobal("fetch", fetchMock);
  scope.bindSessionToken(oldToken);
  const first = postFunction("cmsPreviewStatus", oldToken, {}).catch(error => error);
  await ready;
  scope.beginSessionScope(true);
  scope.bindSessionToken(currentToken);
  const second = postFunction("cmsPreviewStatus", currentToken, {});
  release();
  expect(await first).toMatchObject({ status: 401 });
  expect(await second).toEqual({ status: "pending" });
  expect(ended).not.toHaveBeenCalled();
  refuseCurrent = true;
  await expect(postFunction("cmsPreviewStatus", currentToken, {})).rejects.toMatchObject({ status: 401 });
  expect(ended).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.map(([, init]) => [JSON.parse(String(init?.body)).action,
    new Headers(init?.headers).get("authorization")])).toEqual([
    ["open", `Bearer ${oldToken}`], ["request", `Bearer ${oldToken}`],
    ["request", `Bearer ${currentToken}`], ["request", `Bearer ${currentToken}`],
  ]);
});
