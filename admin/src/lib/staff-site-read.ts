import { openStaffSiteSession } from "./staff-site";
import { publicSiteOrigin } from "./dev-origins";

let pendingSession: Promise<void> | undefined;

async function openDevSession(): Promise<void> {
  const { auth } = await import("./firebase");
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to read the development site.");
  const result = await openStaffSiteSession(publicSiteOrigin, user.getIdToken(true).then(token => {
    if (auth.currentUser !== user) throw new Error("The CMS session changed.");
    return token;
  }));
  if (auth.currentUser !== user) throw new Error("The CMS session changed.");
  if (!result.ok) throw new Error("The development site could not be opened.");
}

async function waitForSession(session: Promise<void>, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return session;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([session, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// Production forwards the exact original request options. Dev renews only on
// a 401 and shares an in-flight exchange across simultaneous receipt reads.
export async function fetchStaffSiteRead(url: string, options: RequestInit): Promise<Response> {
  if (import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT !== "development") return fetch(url, options);
  if (window.location.origin !== "https://dev-admin.example.org" || new URL(url).origin !== publicSiteOrigin) {
    throw new Error("The development site origin was refused.");
  }
  const devOptions: RequestInit = { ...options, credentials: "include", redirect: "error" };
  const result = await fetch(url, devOptions);
  if (result.status !== 401) return result;
  await result.body?.cancel();
  options.signal?.throwIfAborted();
  pendingSession ??= openDevSession().finally(() => { pendingSession = undefined; });
  await waitForSession(pendingSession, options.signal);
  options.signal?.throwIfAborted();
  return fetch(url, devOptions);
}
