import { createServer } from "node:http";
import { once } from "node:events";
import { CRC32C } from "@google-cloud/storage";
import { afterAll, beforeAll, expect, it } from "vitest";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import storage from "../../functions/lib/post-background-storage.js";

const bucket = "background-fixture";
const key = "post-background-v1/listings/fixture/path";
const bytes = Buffer.from("Published Post listing");
const crc = new CRC32C();
crc.update(bytes);
const checksum = crc.toString();
const originalHost = process.env.STORAGE_EMULATOR_HOST;
let server;
let requests;
let stored;

beforeAll(async () => {
  // Exercise the real Admin and GCS SDKs against the JSON API boundary.
  // The publisher identity has create/get only; uploads must stay create-only.
  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push({ method: request.method, path: url.pathname });
    if (request.method === "POST" && url.pathname === `/upload/storage/v1/b/${bucket}/o`) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const metadata = JSON.parse(body.slice(body.indexOf("{"), body.indexOf("}\r\n") + 1));
      if (url.searchParams.get("ifGenerationMatch") !== "0" || url.searchParams.get("name") !== key ||
          metadata.cacheControl !== "private, no-store" || !body.includes(bytes.toString())) {
        response.writeHead(400).end();
        return;
      }
      if (stored) {
        response.writeHead(412, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { code: 412, message: "Precondition failed" } }));
        return;
      }
      stored = true;
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ name: key, bucket, size: String(bytes.length), crc32c: checksum }));
      return;
    }
    if (request.method === "GET" && decodeURIComponent(url.pathname) === `/b/${bucket}/o/${key}` && stored) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-goog-hash": `crc32c=${checksum}` }).end(bytes);
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.STORAGE_EMULATOR_HOST = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (originalHost === undefined) delete process.env.STORAGE_EMULATOR_HOST;
  else process.env.STORAGE_EMULATOR_HOST = originalHost;
  if (server) await new Promise(resolve => server.close(resolve));
});

it.each(["cms-publication-serializer-operator", undefined])(
  "writes and reads immutable background bytes with Firebase app %s", async name => {
    requests = [];
    stored = false;
    const app = firebaseAdminRuntime.initializeApp({ projectId: "demo-njpbs" }, name);
    try {
      const artifacts = storage.createPostBackgroundStorage(bucket, name ? app : undefined);
      const options = { contentType: "text/html; charset=utf-8", signal: AbortSignal.timeout(5000) };
      await artifacts.put(key, bytes, options);
      expect(await artifacts.get(key, options)).toEqual(bytes);
      await artifacts.put(key, bytes, options);
      expect(await artifacts.get(key, options)).toEqual(bytes);
      expect(requests.map(request => request.method)).toEqual(["POST", "GET", "POST", "GET"]);
    } finally {
      await firebaseAdminRuntime.deleteApp(app);
    }
  },
);
