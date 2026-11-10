import { createServer } from "node:http";
import { previewDiagnostics, type PreviewStartup } from "./preview-diagnostics.ts";

type Listener = { stop(): void; closed: Promise<unknown> };
/** Private Container HTTP only. A health request never opens the serializer or
 * its claim journal. Wake starts it once, after a fresh retained-pair check. */
export async function servePreviewPairStandby({ identity, readAuthority, checkContext, startListener,
  signal, port = 8080, startup }: {
  identity: { pairId: string; rendererSha: string; serializerId: string; workerVersion: string };
  readAuthority(): Promise<{ mode: "candidate" | "retained" }>;
  checkContext(): Promise<unknown>; startListener(): Promise<Listener>;
  signal: AbortSignal; port?: number;
  startup?: () => PreviewStartup;
}) {
  signal.throwIfAborted();
  let listener: Listener | undefined, starting: Promise<void> | undefined, stopped = false;
  let finish!: () => void, fail!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  // The runtime observes closed immediately after construction; also prevent a
  // failure during listen from becoming an unhandled rejection.
  void closed.catch(() => undefined);
  const stop = () => { stopped = true; listener?.stop(); server.close(() => finish()); };
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      if (request.method !== "POST" || request.url !== "/wake") { response.writeHead(404).end(); return; }
    }
    const trace = request.headers["x-njpbs-preview-request-id"];
    const measure = previewDiagnostics({ ...identity, ...startup?.(),
      requestId: typeof trace === "string" ? trace : undefined });
    try {
      await measure(request.url === "/wake" ? "wake" : "health", async () => {
        signal.throwIfAborted();
        if (stopped) throw new Error("stopped");
        const authority = await measure("pair-authority", readAuthority);
        await measure("pair-context", checkContext);
        if (request.url === "/wake") {
          if (authority.mode !== "retained") throw new Error("candidate");
          starting ??= (async () => {
            // Another authority read after the potentially slow CODE check.
            if ((await measure("pair-authority", readAuthority)).mode !== "retained" || stopped || signal.aborted) throw new Error("retired");
            listener = await startListener();
            if (stopped || signal.aborted) listener.stop();
            void listener.closed.then(() => { if (!stopped) stop(); }, () => {
              stop(); fail(new Error("Private preview listener stopped without a verified result"));
            });
          })().catch(() => {
            // Startup may already have opened a journal or resumed a retained
            // claim. End this process, preserving that original durable attempt;
            // do not advertise health with a permanently rejected start promise.
            stop(); fail(new Error("Private preview listener startup was not confirmed"));
            throw new Error("Private preview listener startup was not confirmed");
          });
          await starting;
        }
        // Health cannot report a stale candidate after a selector change.
        await measure("pair-authority", readAuthority);
        signal.throwIfAborted();
        if (stopped) throw new Error("stopped");
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ status: "ready", ...identity, mode: authority.mode,
          ...(startup ? { startup: startup() } : {}) }));
      });
    } catch {
      response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "unavailable" }));
    }
  });
  signal.addEventListener("abort", stop, { once: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(port, "0.0.0.0", resolve);
  });
  if (signal.aborted) stop();
  const completion = closed.finally(async () => {
    signal.removeEventListener("abort", stop);
    await starting?.catch(() => undefined); listener?.stop();
    await listener?.closed.catch(() => undefined);
  });
  void completion.catch(() => undefined);
  return { closed: completion, stop, address: server.address() };
}
