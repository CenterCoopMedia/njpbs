import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import github from "../../functions/bug-report-github.js";

const SECRET = "test-github-webhook-secret";
const BODY_LIMIT = 1024 * 1024;
let server;
let url;

beforeAll(async () => {
  vi.stubEnv("CMS_BUG_REPORT_GITHUB_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("CMS_BUG_REPORT_GITHUB_REPOSITORY", "example-owner/private-reports");
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    req.rawBody = Buffer.concat(chunks);
    req.body = JSON.parse(req.rawBody.toString("utf8"));
    res.status = (status) => { res.statusCode = status; return res; };
    res.json = (body) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
      return res;
    };
    res.send = (body) => { res.end(body); return res; };
    await github.githubBugReportWebhook(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  vi.unstubAllEnvs();
});

function bodyWithBytes(size) {
  const overhead = Buffer.byteLength(JSON.stringify({ padding: "" }));
  return Buffer.from(JSON.stringify({ padding: "x".repeat(size - overhead) }));
}

function deliver(rawBody, { signed = true, chunked = false } = {}) {
  const signature = `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`;
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-hub-signature-256": signed ? signature : `sha256=${"0".repeat(64)}`,
    },
    body: chunked ? Readable.from([rawBody]) : rawBody,
    ...(chunked ? { duplex: "half" } : {}),
  });
}

describe("GitHub webhook resource boundary", () => {
  it("caps the deployed webhook at five instances", () => {
    expect(github.githubBugReportWebhook.__endpoint).toMatchObject({ maxInstances: 5 });
  });

  it.each([BODY_LIMIT - 1, BODY_LIMIT])("accepts a signed ping of %i bytes", async (size) => {
    const response = await deliver(bodyWithBytes(size));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it.each([
    ["signed", { signed: true }],
    ["unsigned", { signed: false }],
    ["chunked", { chunked: true }],
  ])("rejects %s bodies above 1 MiB before authentication", async (_name, options) => {
    const response = await deliver(bodyWithBytes(BODY_LIMIT + 1), options);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Webhook request is too large" });
  });

  it("counts UTF-8 bytes when refusing an oversized signed body", async () => {
    const text = JSON.stringify({ padding: "é".repeat(600_000) });
    expect(text.length).toBeLessThan(BODY_LIMIT);
    const response = await deliver(Buffer.from(text));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Webhook request is too large" });
  });

  it("still refuses an invalid signature within the body limit", async () => {
    const response = await deliver(Buffer.from("{}"), { signed: false });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Webhook authentication failed" });
  });
});
