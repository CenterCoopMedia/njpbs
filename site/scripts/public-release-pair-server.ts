import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import work from "../../functions/lib/public-release-pair-work.js";
import { runPublicReleasePairWorkOnce } from "./public-release-pair-runtime";
import { PAIR_READER_PATH } from "../../packages/content-core/src/private-pair-http.mjs";

type Executor = Parameters<typeof runPublicReleasePairWorkOnce>[0]["execute"];

/** Container-private control plane. An installed executor is code, never an
 * environment flag. Preflight reports executor availability; no task is claimed
 * without an installed executor.
 */
export async function startPublicReleasePairServer({ firestore, pair, execute, stage, recover, retryQuarantined, beforePoll,
  privateReader, readerInstallation, port = 8080, host = "0.0.0.0" }: {
  firestore: Firestore; pair: PublicReleasePair; execute?: Executor;
  stage?: Parameters<typeof runPublicReleasePairWorkOnce>[0]["stage"];
  beforePoll?: Parameters<typeof runPublicReleasePairWorkOnce>[0]["beforePoll"];
  recover?(signal?: AbortSignal): Promise<void>;
  retryQuarantined?(taskId: string, signal?: AbortSignal): Promise<void>; port?: number; host?: string;
  privateReader?(request: Request): Promise<Response>;
  readerInstallation?(): unknown;
}) {
  await work.readPublicReleasePairWork({ firestore, pair });
  let busy: Promise<void> | null = null;
  let stopping = false;
  let wakePending = false;
  let failureCode: string | null = null;
  const stoppingSignal = new AbortController();
  const kick = () => {
    wakePending = true;
    if (!execute || busy || stopping) return;
    failureCode = null;
    busy = (async () => {
      await recover?.(stoppingSignal.signal);
      // This drains real queued work, never an idle polling or load loop.
      do {
        wakePending = false;
        const outcome = await runPublicReleasePairWorkOnce({ firestore, pair, execute, stage, beforePoll, signal: stoppingSignal.signal });
        if (outcome === "retry-recorded") break;
        if (outcome === "complete") wakePending = true;
      } while (wakePending && !stopping);
      failureCode = null;
    })().catch(error => {
      failureCode = error instanceof work.PairExecutionError ? error.code : "pair-authority-unavailable";
    }).finally(() => {
      busy = null;
      // A concurrent real wake may arrive after the last idle read.
      if (wakePending && !stopping && failureCode === null) kick();
    });
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "POST" && request.url === PAIR_READER_PATH && privateReader) {
        const abort = new AbortController();
        request.once("aborted", () => abort.abort());
        response.once("close", () => abort.abort());
        const result = await privateReader(new Request(`http://container${PAIR_READER_PATH}`, {
          method: "POST", headers: { "content-type": String(request.headers["content-type"] ?? "") },
          body: Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: "half",
          signal: AbortSignal.any([abort.signal, stoppingSignal.signal]),
        } as RequestInit & { duplex: string }));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.body) await pipeline(Readable.fromWeb(result.body as import("node:stream/web").ReadableStream<Uint8Array>), response);
        else response.end();
        return;
      }
      if (request.method === "GET" && request.url === "/private-pair-reader/v2/installation" && readerInstallation) {
        await work.readPublicReleasePairWork({ firestore, pair });
        response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
        response.end(JSON.stringify(readerInstallation())); return;
      }
      if (!((request.method === "GET" && request.url === "/health") ||
          (request.method === "POST" && ["/wake", "/retry-staging"].includes(request.url ?? "")))) {
        response.writeHead(404).end(); return;
      }
      // Re-read authority even for a warm health request. A retired pair or
      // unavailable authority must not retain a green health response.
      await work.readPublicReleasePairWork({ firestore, pair });
      if (request.url === "/retry-staging") {
        if (!retryQuarantined || stopping) { response.writeHead(503).end(); return; }
        if (busy) { response.writeHead(409).end(); return; }
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 1024) throw new Error("Invalid private repair request");
          chunks.push(chunk);
        }
        const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!input || Object.keys(input).join(",") !== "taskId" || typeof input.taskId !== "string" || !/^[a-f0-9]{64}$/.test(input.taskId)) {
          response.writeHead(400).end(); return;
        }
        // Recheck after reading the body; another wake may have started work.
        if (busy || stopping) { response.writeHead(409).end(); return; }
        failureCode = null;
        const repair = retryQuarantined(input.taskId, stoppingSignal.signal);
        busy = repair.then(() => {}, error => {
          failureCode = error instanceof work.PairExecutionError ? error.code : "pair-authority-unavailable";
        }).finally(() => { busy = null; if (wakePending && !stopping) kick(); });
        await repair;
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ status: "staged", taskId: input.taskId }));
        return;
      }
      if (request.method === "POST") kick();
      const ready = Boolean(execute) && !stopping && failureCode === null;
      response.writeHead(ready ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ status: ready ? "ready" : !execute ? "waiting-for-executor" : "unavailable",
        pairId: pair.pairId, commitSha: pair.commitSha, journalNamespace: pair.publisher.journalNamespace,
        executorInstalled: Boolean(execute), busy: busy !== null, failureCode }));
    })().catch(() => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ status: "unavailable" }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  return {
    address: server.address(),
    async waitForCurrentWork() { await busy; },
    async close() {
      stopping = true;
      stoppingSignal.abort();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await busy;
    },
  };
}
