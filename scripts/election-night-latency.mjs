import { channel } from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";

// Passive observation only: this module never makes or changes a request.
const outputPath = process.env.ELECTION_LATENCY_REPORT;
const requests = new WeakMap();
const observations = [];
const endpoint = request => {
  if (request.origin !== "https://njpbs.org" || !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:\?live-blog=updates)?$/.test(request.path)) return null;
  return request.path.endsWith("?live-blog=updates") ? "feed" : "page";
};
if (outputPath) {
  channel("undici:request:create").subscribe(({ request }) => {
    const kind = endpoint(request);
    if (kind) requests.set(request, { endpoint: kind, started: performance.now() });
  });
  channel("undici:request:headers").subscribe(({ request, response }) => {
    const record = requests.get(request);
    if (record) { record.headersMs = performance.now() - record.started; record.status = response.statusCode; }
  });
  const finish = (request, failed) => {
    const record = requests.get(request);
    if (!record) return;
    observations.push({ endpoint: record.endpoint, status: record.status ?? null,
      headersMs: record.headersMs ?? null, bodyMs: performance.now() - record.started, failed });
    requests.delete(request);
  };
  channel("undici:request:trailers").subscribe(({ request }) => finish(request, false));
  channel("undici:request:error").subscribe(({ request }) => finish(request, true));
  process.once("exit", () => writeFileSync(outputPath, `${JSON.stringify({ observations }, null, 2)}\n`, { mode: 0o600 }));
}
