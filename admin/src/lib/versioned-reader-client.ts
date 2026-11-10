/** Bridge client used by the default-off installed Admin transport. A lost
 * response is retried only by the caller,
 * with the original session IDs and endpoint's original operation identity.
 */
export function createVersionedReaderClient({ origin, version, sessionIds, readToken, readAppCheckToken, request = fetch }: {
  origin: string;
  version: 1 | 2;
  sessionIds: Readonly<{ functions: string; cmsApi: string }>;
  readToken: () => Promise<string>;
  readAppCheckToken?: () => Promise<string>;
  request?: typeof fetch;
}) {
  const url = new URL(origin), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (!["https://api.example.org", "https://dev-api.example.org"].includes(url.origin) ||
      url.href !== `${url.origin}/` || ![1, 2].includes(version) || !uuid.test(sessionIds.functions) ||
      !uuid.test(sessionIds.cmsApi) || sessionIds.functions === sessionIds.cmsApi) throw new Error("CMS reader configuration unavailable");
  const ids = Object.freeze({ ...sessionIds });
  async function send(body: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const token = await readToken();
    if (!token || /[\r\n]/.test(token)) throw new Error("Staff sign-in required");
    const appCheck = await readAppCheckToken?.();
    if (readAppCheckToken && (!appCheck || /[\r\n]/.test(appCheck))) throw new Error("Staff request verification unavailable");
    // One fetch only. Never reopen or renew a session on a refusal or timeout.
    return request(`${url.origin}/api/cms/v${version}/reader`, { method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
        ...(appCheck ? { "x-firebase-appcheck": appCheck } : {}) }, body: JSON.stringify(body) });
  }
  return {
    open: (signal?: AbortSignal) => send({ version, action: "open", sessionIds: ids, ttlMs: 24 * 60 * 60_000 }, signal),
    request: (endpoint: string, body: unknown, signal?: AbortSignal) => send({ version, action: "request", sessionIds: ids, endpoint, body }, signal),
  };
}
