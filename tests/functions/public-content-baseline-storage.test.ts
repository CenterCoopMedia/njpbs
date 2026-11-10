import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { createContentBaselineStorage } from "../../site/scripts/public-content-baseline-storage";
import { baselineObjectKey } from "../../packages/content-core/src/public-content-baseline";
import { publicationTarget } from "../../functions/lib/publication-target";

const target = publicationTarget("production"), bytes = Buffer.from("Independent immutable fixture bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const checksum = Buffer.from(digest, "hex").toString("base64");
const key = baselineObjectKey(target, digest);
const objects = new Map<string, { bytes: Buffer; checksum: string; metadata: Record<string, string> }>();
let server: Server, client: S3Client, mode: string;

beforeAll(async () => {
  // Actual SDK and HTTP: the fixture owns only the remote S3 storage boundary.
  server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url!, "http://127.0.0.1").pathname);
    if (request.method === "PUT") {
      if (request.headers["if-none-match"] === "*" && objects.has(path)) {
        response.writeHead(412, { "content-type": "application/xml" });
        response.end("<Error><Code>PreconditionFailed</Code><Message>Existing fixture object</Message></Error>");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks), actual = createHash("sha256").update(body).digest("base64");
      if (request.headers["x-amz-checksum-sha256"] !== actual) {
        response.writeHead(400, { "content-type": "application/xml" });
        response.end("<Error><Code>BadDigest</Code></Error>"); return;
      }
      const metadata = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.startsWith("x-amz-meta-"))
        .map(([name, value]) => [name, String(value)]));
      objects.set(path, { bytes: body, checksum: actual, metadata });
      response.writeHead(200, { etag: '"immutable-fixture"', "x-amz-checksum-sha256": actual }); response.end(); return;
    }
    const stored = objects.get(path);
    if (!stored) { response.writeHead(404); response.end(); return; }
    const body = Buffer.from(stored.bytes);
    if (mode === "corrupt body") body[0] ^= 1;
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length,
      ...stored.metadata, ...(mode === "missing checksum" ? {} : { "x-amz-checksum-sha256":
        mode === "wrong checksum" ? Buffer.alloc(32).toString("base64") : stored.checksum }) });
    response.end(body);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local storage fixture failed");
  client = new S3Client({ endpoint: `http://127.0.0.1:${address.port}`, region: "auto", forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", maxAttempts: 1,
    credentials: { accessKeyId: "synthetic-fixture", secretAccessKey: "synthetic-fixture" } });
});
beforeEach(() => { mode = "valid"; objects.clear(); });
afterAll(async () => { client?.destroy(); await new Promise<void>(resolve => server?.close(() => resolve())); });

it("uploads with an intrinsic checksum and proves an immutable retry without replacing bytes", async () => {
  const storage = createContentBaselineStorage({ target, client });
  await storage.writeAndVerify(key, bytes);
  await storage.writeAndVerify(key, bytes);
  expect(objects.size).toBe(1);
  const stored = [...objects.values()][0];
  expect(stored.bytes).toEqual(bytes);
  expect(stored.checksum).toBe(checksum);
  expect(stored.metadata["x-amz-meta-sha256"]).toBe(digest);
  storage.close();
});

it.each(["missing checksum", "wrong checksum", "corrupt body"])("refuses the storage %s before a baseline can be sealed", async value => {
  mode = value;
  await expect(createContentBaselineStorage({ target, client }).writeAndVerify(key, bytes)).rejects.toThrow();
});

it("refuses a foreign namespace or a key that mislabels its bytes", async () => {
  const storage = createContentBaselineStorage({ target, client });
  await expect(storage.writeAndVerify("post-withdrawals/fixture", bytes)).rejects.toThrow("key or size");
  await expect(storage.writeAndVerify(baselineObjectKey(target, "f".repeat(64)), bytes)).rejects.toThrow("differs from its bytes");
  expect(objects.size).toBe(0);
});
