const TOKEN = /^[A-Za-z0-9._-]{1,3500}$/;

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "guide-video-protocol" && event.data.version === 2) {
    event.source?.postMessage({ type: "guide-video-protocol", version: 2 });
  }
});

function guideVideoRequest(url, method) {
  return url.origin === self.location.origin
    && url.pathname.startsWith("/guide-content/videos/")
    && (method === "GET" || method === "HEAD");
}

function tokenFromClient(client) {
  if (!client) return Promise.resolve("");
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      resolve("");
    }, 1500);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      const token = event.data?.token;
      resolve(typeof token === "string" && TOKEN.test(token) ? token : "");
    };
    client.postMessage({ type: "guide-video-token-needed" }, [channel.port2]);
  });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!guideVideoRequest(url, event.request.method)) return;
  event.respondWith((async () => {
    const client = event.clientId ? await self.clients.get(event.clientId) : null;
    const token = await tokenFromClient(client);
    if (!token) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "cache-control": "private, no-store" },
      });
    }
    const headers = new Headers();
    const range = event.request.headers.get("range");
    if (range) headers.set("range", range);
    const ifRange = event.request.headers.get("if-range");
    if (ifRange) headers.set("if-range", ifRange);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(url.toString(), {
      method: event.request.method,
      headers,
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      redirect: "manual",
    });
  })());
});
