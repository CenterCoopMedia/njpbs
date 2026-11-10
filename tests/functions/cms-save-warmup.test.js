import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import express from "express";
import save from "../../functions/save.js";
import warmup from "../../functions/save-warmup.js";
import { db } from "../../functions/lib/firebase.js";

const secret = "local-cms-edge-only";
let server;
let url;

async function inventory() {
  const collections = await db.listCollections();
  return Object.fromEntries(await Promise.all(collections.map(async collection => [collection.id,
    (await collection.get()).docs.map(row => ({ id: row.id, data: row.data() })),
  ])));
}

function request(body, edgeSecret = secret) {
  return fetch(url, { method: "POST", headers: {
    "Content-Type": "application/json", "x-njpbs-cms-edge": edgeSecret,
  }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || db.projectId !== "demo-njpbs") {
    throw new Error("Use the local demo Firestore emulator");
  }
  // This loopback server runs in Vitest, outside the Functions emulator process.
  vi.stubEnv("CMS_EDGE_ORIGIN_SECRET", secret);
  const app = express();
  app.use(express.json());
  app.use(save.cmsSaveContent);
  server = createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("cmsPosts/warm-fixture").set({ status: "approved", version: 1 });
});

afterAll(async () => {
  try {
    if (server) await new Promise(resolve => server.close(resolve));
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("scheduled save warmup", () => {
  it("warms the real save endpoint over HTTP without a staff token or stored effects", async () => {
    const before = await inventory();
    const failures = [];
    await warmup.createCmsSaveWarmupHandler({
      readEdgeSecret: () => secret,
      fetchImpl: (_url, options) => fetch(url, options),
      log: { warn: message => failures.push(message) },
    })();
    expect(failures).toEqual([]);
    expect(await inventory()).toEqual(before);
    const response = await request({ mode: "warm" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ success: true, warmed: true });
  });

  it("refuses warmup without the origin secret", async () => {
    const before = await inventory();
    expect((await request({ mode: "warm" }, "wrong-fixture-secret")).status).toBe(403);
    expect(await inventory()).toEqual(before);
  });

  it("refuses a mixed warmup and save payload without changing content", async () => {
    const before = await inventory();
    expect((await request({ mode: "warm", collection: "cmsPosts", id: "warm-fixture", publish: true })).status).toBe(400);
    expect(await inventory()).toEqual(before);
  });

  it("keeps ordinary save authentication", async () => {
    expect((await request({ collection: "cmsPosts", id: "warm-fixture", baseVersion: 1, document: {} })).status).toBe(401);
  });

  it("does not retry or disclose credentials or a provider error on failure", async () => {
    let attempts = 0;
    const failures = [];
    await warmup.createCmsSaveWarmupHandler({
      readEdgeSecret: () => "synthetic-secret-must-not-be-logged",
      fetchImpl: async () => { attempts++; throw new Error("synthetic-secret-must-not-be-logged"); },
      log: { warn: (...values) => failures.push(values) },
    })();
    expect(attempts).toBe(1);
    expect(failures).toEqual([["cmsSaveContent warmup failed"]]);
  });

  it("declares the approved daily Eastern schedule with no warm reservation or retry", () => {
    expect(warmup.onCmsSaveWarmup.__endpoint).toMatchObject({ minInstances: 0, timeoutSeconds: 15,
      scheduleTrigger: { schedule: "*/5 9-20 * * *", timeZone: "America/New_York", retryConfig: { retryCount: 0, maxRetrySeconds: 0 } },
      secretEnvironmentVariables: [{ key: "CMS_EDGE_ORIGIN_SECRET" }],
    });
  });
});
