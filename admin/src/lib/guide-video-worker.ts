const TOKEN = /^[A-Za-z0-9._-]{1,3500}$/;
const WORKER_URL = "/guide-video-sw.js";

function matchingGuideWorker(worker: ServiceWorker | null): boolean {
  try {
    return new URL(worker?.scriptURL ?? "").pathname === "/guide-video-sw.js";
  } catch {
    return false;
  }
}

export async function ensureGuideVideoWorker(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    await navigator.serviceWorker.register(WORKER_URL, { scope: "/guide" });
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1_500)),
    ]);
    if (!ready) return false;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 1_500);
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          window.clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    const controller = navigator.serviceWorker.controller;
    if (!matchingGuideWorker(controller) || !controller) return false;
    return confirmGuideVideoProtocol(controller);
  } catch {
    return false;
  }
}

function confirmGuideVideoProtocol(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(false);
    }, 500);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "guide-video-protocol" || event.data.version !== 2) return;
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(true);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    worker.postMessage({ type: "guide-video-protocol", version: 2 });
  });
}

export function listenForGuideVideoToken(getIdToken: () => Promise<string>): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => undefined;
  let active = true;
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type !== "guide-video-token-needed") return;
    const port = event.ports?.[0];
    if (!port) return;
    void getIdToken()
      .then((token) => {
        port.postMessage({ token: active && TOKEN.test(token) ? token : "" });
      })
      .catch(() => {
        port.postMessage({ token: "" });
      });
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => {
    active = false;
    navigator.serviceWorker.removeEventListener("message", onMessage);
  };
}
