import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CRC32C } = require("@google-cloud/storage");

/** A local JSON API boundary, using the real named-app Storage SDK. */
export async function backgroundStorageFixture(bucket: string) {
  const objects = new Map<string, Buffer>();
  const writes: string[] = [];
  const reads: string[] = [];
  let rejectReads = false;
  let beforeRead: ((key: string) => Promise<void>) | null = null;
  const previousHost = process.env.STORAGE_EMULATOR_HOST;
  let rejectKey: ((key: string) => boolean) | null = null;
  const server = createServer(async (request, response) => {
    // SDK sockets can otherwise outlive a test and race the server's idle timeout.
    response.setHeader("connection", "close");
    const url = new URL(request.url!, "http://localhost");
    if (request.method === "POST" && url.pathname === `/upload/storage/v1/b/${bucket}/o`) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const key = url.searchParams.get("name")!;
      const delimiter = Buffer.from(`--${request.headers["content-type"]!.split("boundary=")[1]}`);
      const firstHeaderEnd = body.indexOf("\r\n\r\n");
      const metadataEnd = body.indexOf(delimiter, firstHeaderEnd);
      const metadata = JSON.parse(body.subarray(firstHeaderEnd + 4, metadataEnd - 2).toString());
      const payloadStart = body.indexOf("\r\n\r\n", metadataEnd) + 4;
      const bytes = body.subarray(payloadStart, body.indexOf(delimiter, payloadStart) - 2);
      if (!key || url.searchParams.get("ifGenerationMatch") !== "0" || metadata.cacheControl !== "private, no-store") {
        response.writeHead(400).end(); return;
      }
      if (rejectKey?.(key)) { response.writeHead(403).end(); return; }
      if (objects.has(key)) {
        response.writeHead(412, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 412 } })); return;
      }
      objects.set(key, Buffer.from(bytes)); writes.push(key);
      const crc = new CRC32C(); crc.update(bytes);
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ name: key, bucket, size: String(bytes.length), crc32c: crc.toString() }));
      return;
    }
    const prefix = `/b/${bucket}/o/`;
    if (request.method === "GET" && url.pathname.startsWith(prefix)) {
      const key = decodeURIComponent(url.pathname.slice(prefix.length));
      reads.push(key);
      await beforeRead?.(key);
      if (rejectReads) { response.writeHead(403).end(); return; }
      const bytes = objects.get(key);
      if (bytes) {
        const crc = new CRC32C(); crc.update(bytes);
        response.writeHead(200, { "content-type": "application/octet-stream", "x-goog-hash": `crc32c=${crc.toString()}` }).end(bytes);
        return;
      }
    }
    response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 404 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.STORAGE_EMULATOR_HOST = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { objects, writes, reads, onRead: (hook: typeof beforeRead) => { beforeRead = hook; }, refuseReads: (refuse: boolean) => { rejectReads = refuse; }, reject: (predicate: typeof rejectKey) => { rejectKey = predicate; },
    close: async () => {
      if (previousHost === undefined) delete process.env.STORAGE_EMULATOR_HOST;
      else process.env.STORAGE_EMULATOR_HOST = previousHost;
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}
