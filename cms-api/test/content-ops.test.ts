import { afterEach, describe, expect, it, vi } from "vitest";
import { createCmsApiHandler, type CmsApiEnv } from "../src/index";
import { handleContentOps } from "../src/content-ops-route";
import { parseContentOpsRequest, planDigest } from "../src/content-ops";
import type { CmsRateLimiter } from "../src/rate-limiter";

// The emulator contract test (tests/functions/content-ops-contract.test.ts) proves stored
// results. These cases cover the edge-only rules: request refusals, refused Pages, and the
// publish order with its uncertain result. Only the network is replaced.
const FUNCTIONS_ORIGIN = "https://functions.invalid";
const REFERENCE = "fixture-content-operation";

afterEach(() => vi.restoreAllMocks());

interface Call { url: string; body: Record<string, unknown> | null; method: string }

function upstream(replies: Record<string, (body: Record<string, unknown>) => [number, unknown]>) {
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, body, method: init?.method ?? "GET" });
    const key = url.startsWith("https://firestore.googleapis.com/")
      ? (url.endsWith(":commit") ? "lease:commit" : "lease:read")
      : url.slice(FUNCTIONS_ORIGIN.length + 1);
    const reply = replies[key];
    if (!reply) return new Response(JSON.stringify({ error: `unexpected ${key}` }), { status: 599 });
    const [status, payload] = reply(body ?? {});
    return new Response(JSON.stringify(payload), { status });
  });
  return { calls, fetcher };
}

function run(request: Record<string, unknown>, fetcher: typeof fetch, leaseRenewMs?: number,
  chargeVideoCopy: () => Promise<Response | null> = async () => null) {
  return handleContentOps({
    leaseRenewMs, chargeVideoCopy,
    body: new TextEncoder().encode(JSON.stringify({ schema: 1, requestReference: REFERENCE, ...request })).buffer,
    token: "agent-token", uid: "agent-1", projectId: "njpbs-site", functionsOrigin: FUNCTIONS_ORIGIN,
    forwardHeaders: new Headers({ "content-type": "application/json" }), fetcher, now: () => Date.parse("2026-11-03T20:00:00Z"),
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
  });
}

// The lease is free at the claim; after that, reads return this request's own lease.
function freeLease() {
  let claimed = false;
  return {
    "lease:read": (): [number, unknown] => (claimed ? [200, { updateTime: "2026-11-03T20:00:01Z", fields: {
      ownerId: { stringValue: "agent-1" }, sessionId: { stringValue: "content-api-00000000-0000-4000-8000-000000000000" },
      acquiredAt: { timestampValue: "2026-11-03T20:00:01Z" }, heartbeatAt: { timestampValue: "2026-11-03T20:00:01Z" } } }] : [404, {}]),
    "lease:commit": (): [number, unknown] => { claimed = true; return [200, {}]; },
  };
}

describe("content operations requests", () => {
  it.each([
    ["an unknown field", { mode: "dry-run", collection: "cmsPages", id: "about", baseVersion: 1, ops: [{ op: "remove", id: "a" }], force: true }, /unknown field/],
    ["publish with operations", { mode: "publish", collection: "cmsPages", id: "about", baseVersion: 1, ops: [{ op: "remove", id: "a" }], expectDigest: "a".repeat(64) }, /no operations/],
    ["apply without a digest", { mode: "apply", collection: "cmsPages", id: "about", baseVersion: 1, ops: [{ op: "remove", id: "a" }] }, /dry-run digest/],
    ["a block operation on a Post", { mode: "dry-run", collection: "cmsPosts", id: "post-1", baseVersion: 1, ops: [{ op: "remove", id: "a" }] }, /only setCredits/],
    ["an unknown operation", { mode: "dry-run", collection: "cmsPages", id: "about", baseVersion: 1, ops: [{ op: "replaceBlock", id: "a" }] }, /not supported/],
    ["too many operations", { mode: "dry-run", collection: "cmsPages", id: "about", baseVersion: 1, ops: Array(101).fill({ op: "remove", id: "a" }) }, /at most 100/],
  ])("refuses %s before any upstream call", async (_label, request, error) => {
    const { calls, fetcher } = upstream({});
    const response = await run(request, fetcher);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toMatch(error);
    expect(calls).toHaveLength(0);
  });

  it("refuses a block type the Page's palette does not offer before any save", async () => {
    const { calls, fetcher } = upstream({ cmsGetContent: () => [200, { found: true, document: { blocks: [], version: 2 } }] });
    const response = await run({ mode: "dry-run", collection: "cmsPages", id: "about", baseVersion: 2,
      ops: [{ op: "insert", type: "content_shelf" }] }, fetcher);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toMatch(/does not take content_shelf/);
    expect(calls.map(call => call.url)).toEqual([`${FUNCTIONS_ORIGIN}/cmsGetContent`]);
  });

  it("clears an optional block field with unset, as the editor does", async () => {
    let saved: Record<string, unknown> = {};
    const { fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: { version: 2, status: "draft", blocks: [
        { id: "embed-1", type: "embed", order: 0, visible: true,
          data: { url: "https://www.youtube.com/watch?v=abc", width: 640, height: 360 } },
      ] } }],
      cmsSaveContent: (body) => { saved = body; return [200, { success: true, dryRun: true, document: {} }]; },
    });
    const response = await run({ mode: "dry-run", collection: "cmsPages", id: "about", baseVersion: 2,
      ops: [{ op: "setData", id: "embed-1", data: {}, unset: ["width", "height"] }] }, fetcher);
    expect(response.status).toBe(200);
    const blocks = (saved.document as { blocks: Array<{ id: string; data: Record<string, unknown> }> }).blocks;
    expect(blocks.find(block => block.id === "embed-1")?.data).toEqual({ url: "https://www.youtube.com/watch?v=abc" });
  });

  it("reports a Post byline change when the stored byline is a legacy author", async () => {
    const { fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: { version: 3, status: "draft", type: "post", author: "Jane Reporter" } }],
      cmsSaveContent: () => [200, { success: true, dryRun: true, document: {} }],
    });
    const response = await run({ mode: "dry-run", collection: "cmsPosts", id: "post-1", baseVersion: 3,
      ops: [{ op: "setCredits", credits: [] }] }, fetcher);
    expect(response.status).toBe(200);
    expect((await response.json() as { changes: unknown[] }).changes).toEqual([{ path: "/credits", change: "credits" }]);
  });

  it("refuses a row width change through setData, which skips the layout rules", async () => {
    const { calls, fetcher } = upstream({ cmsGetContent: () => [200, { found: true, document: { version: 2, blocks: [
      { id: "row-1", type: "row", order: 0, visible: true, data: { columns: [12] } },
    ] } }] });
    const response = await run({ mode: "dry-run", collection: "cmsPages", id: "about", baseVersion: 2,
      ops: [{ op: "setData", id: "row-1", data: { columns: [6, 6] } }] }, fetcher);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toMatch(/with split/);
    expect(calls.map(call => call.url)).toEqual([`${FUNCTIONS_ORIGIN}/cmsGetContent`]);
  });

  it("refuses a coverage list insert, which the editor does not offer", async () => {
    const { calls, fetcher } = upstream({ cmsGetContent: () => [200, { found: true, document: { blocks: [], version: 2 } }] });
    const response = await run({ mode: "dry-run", collection: "cmsPages", id: "contact", baseVersion: 2,
      ops: [{ op: "insert", type: "coverage_list" }] }, fetcher);
    expect(response.status).toBe(400);
    expect(calls.map(call => call.url)).toEqual([`${FUNCTIONS_ORIGIN}/cmsGetContent`]);
  });

  it("refuses Home and composed Pages, which keep their own Boardwalk rules", async () => {
    for (const [id, document] of [["home", { blocks: [] }], ["about", { blocks: [], serviceCompositionVersion: 1 }]] as const) {
      const { calls, fetcher } = upstream({ cmsGetContent: () => [200, { found: true, document: { ...document, version: 2 } }] });
      const response = await run({ mode: "dry-run", collection: "cmsPages", id, baseVersion: 2, ops: [{ op: "remove", id: "a" }] }, fetcher);
      expect(response.status).toBe(409);
      expect(calls.map(call => call.url)).toEqual([`${FUNCTIONS_ORIGIN}/cmsGetContent`]);
    }
  });
});

describe("content operations publish", () => {
  const stored = { version: 5, status: "draft", blocks: [
    { id: "video-1", type: "video", order: 0, visible: true, data: { sourceId: "video-library", assetId: "asset-1", title: "Debate" } },
  ] };

  // The digest publish accepts comes from the publish dry run, as an agent gets it.
  async function digest(document: Record<string, unknown> = stored) {
    const { fetcher } = upstream({ cmsGetContent: () => [200, { found: true, document }] });
    const response = await run({ mode: "publish-dry-run", collection: "cmsPages", id: "about", baseVersion: 5, ops: [] }, fetcher);
    expect(response.status).toBe(200);
    return (await response.json() as { digest: string }).digest;
  }

  it("checks a publish without side effects and returns the digest publish accepts", async () => {
    const { calls, fetcher } = upstream({ cmsGetContent: () => [200, { found: true, document: stored }] });
    const response = await run({ mode: "publish-dry-run", collection: "cmsPages", id: "about", baseVersion: 5, ops: [] }, fetcher);
    expect(await response.json()).toMatchObject({ mode: "publish-dry-run", baseVersion: 5, status: "draft" });
    expect(calls.map(call => call.url)).toEqual([`${FUNCTIONS_ORIGIN}/cmsGetContent`]);
    expect(await digest()).toBe(await planDigest(parseContentOpsRequest({ schema: 1, mode: "publish", collection: "cmsPages",
      id: "about", baseVersion: 5, requestReference: REFERENCE, expectDigest: "0".repeat(64), ops: [] })));
  });

  it("refuses to publish Home before any lease, copy or save", async () => {
    const home = { blocks: [], version: 5 };
    for (const mode of ["publish-dry-run", "publish"]) {
      const { calls, fetcher } = upstream({ cmsGetContent: () => [200, { found: true, document: home }] });
      const response = await run({ mode, collection: "cmsPages", id: "home", baseVersion: 5, ops: [],
        ...(mode === "publish" ? { expectDigest: "a".repeat(64) } : {}) }, fetcher);
      expect(response.status).toBe(409);
      expect(calls.map(call => call.url)).toEqual([`${FUNCTIONS_ORIGIN}/cmsGetContent`]);
    }
  });

  it("copies no video while a person holds the editing lock", async () => {
    const { calls, fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: stored }],
      "lease:read": () => [200, { updateTime: "2026-11-03T19:59:50Z", fields: {
        ownerId: { stringValue: "staff-1" }, ownerName: { stringValue: "Pat" },
        acquiredAt: { timestampValue: "2026-11-03T19:59:00Z" }, heartbeatAt: { timestampValue: "2026-11-03T19:59:50Z" } } }],
    });
    const response = await run({ mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5, ops: [], expectDigest: await digest() }, fetcher);
    expect(response.status).toBe(423);
    expect(calls.some(call => call.url.endsWith("/cmsPublishSourceVideo") || call.url.endsWith("/cmsSaveContent"))).toBe(false);
  });

  it("reports a live lease of another request by the same account and copies nothing", async () => {
    const { calls, fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: stored }],
      "lease:read": () => [200, { updateTime: "2026-11-03T19:59:50Z", fields: {
        ownerId: { stringValue: "agent-1" }, sessionId: { stringValue: "content-api-another-request" },
        ownerName: { stringValue: "NJ PBS agent" },
        acquiredAt: { timestampValue: "2026-11-03T19:59:00Z" }, heartbeatAt: { timestampValue: "2026-11-03T19:59:50Z" } } }],
    });
    const response = await run({ mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5, ops: [], expectDigest: await digest() }, fetcher);
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ lockHeld: true, holder: { ownerName: "NJ PBS agent" } });
    expect(calls.filter(call => call.url.endsWith(":commit"))).toHaveLength(0);
    expect(calls.some(call => call.url.endsWith("/cmsPublishSourceVideo") || call.url.endsWith("/cmsSaveContent"))).toBe(false);
  });

  it("copies no further video once the lease is lost", async () => {
    const twoVideos = { ...stored, blocks: [...stored.blocks,
      { id: "video-2", type: "video", order: 1, visible: true, data: { sourceId: "video-library", assetId: "asset-2", title: "Recap" } }] };
    const own = { ownerId: { stringValue: "agent-1" }, sessionId: { stringValue: "content-api-00000000-0000-4000-8000-000000000000" } };
    const staff = { ownerId: { stringValue: "staff-1" }, sessionId: { stringValue: "session-staff" }, ownerName: { stringValue: "Pat" } };
    let reads = 0;
    const { calls, fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: twoVideos }],
      cmsPublishSourceVideo: () => [200, { success: true }],
      // Free at the claim, still held before the first copy, claimed by a person before the second.
      "lease:read": () => {
        reads++;
        if (reads === 1) return [404, {}];
        const fields = reads === 2 ? own : staff;
        return [200, { updateTime: "2026-11-03T20:02:10Z", fields: { ...fields,
          acquiredAt: { timestampValue: "2026-11-03T20:02:10Z" }, heartbeatAt: { timestampValue: "2026-11-03T20:02:10Z" } } }];
      },
      "lease:commit": () => [200, {}],
    });
    const response = await run({ mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5, ops: [],
      expectDigest: await digest(twoVideos) }, fetcher);
    expect(response.status).toBe(423);
    expect(calls.filter(call => call.url.endsWith("/cmsPublishSourceVideo"))).toHaveLength(1);
    expect(calls.some(call => call.url.endsWith("/cmsSaveContent"))).toBe(false);
  });

  it("renews the lease while a video copy runs", async () => {
    let copying = false;
    let renewalsDuringCopy = 0;
    const { calls, fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: stored }],
      cmsSaveContent: () => [200, { success: true, document: { version: 6 }, publication: { queueId: "queue-1" } }],
      "lease:read": () => [200, { updateTime: "2026-11-03T20:00:01Z", fields: {
        ownerId: { stringValue: "agent-1" }, sessionId: { stringValue: "content-api-00000000-0000-4000-8000-000000000000" },
        acquiredAt: { timestampValue: "2026-11-03T19:50:00Z" }, heartbeatAt: { timestampValue: "2026-11-03T19:50:00Z" } } }],
      "lease:commit": body => {
        if (copying && JSON.stringify(body).includes('"transform"')) renewalsDuringCopy++;
        return [200, {}];
      },
    });
    const slowCopy = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/cmsPublishSourceVideo")) {
        copying = true;
        try {
          await new Promise(resolve => setTimeout(resolve, 60));
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        } finally { copying = false; }
      }
      return fetcher(input, init);
    });
    const response = await run({ mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5, ops: [],
      expectDigest: await digest() }, slowCopy, 10);
    expect(response.status).toBe(200);
    const heartbeats = calls.filter(call => JSON.stringify(call.body).includes('"transform"'));
    // Confirmations before and after the copy cannot satisfy this assertion.
    expect(renewalsDuringCopy).toBeGreaterThan(0);
    expect(heartbeats.length).toBeGreaterThan(2);
    expect(JSON.stringify(heartbeats[0].body)).toContain("heartbeatAt");
  });

  it("renews one request at a time and rereads a lease that moved", async () => {
    const lease = freeLease();
    let inFlight = 0;
    let most = 0;
    let transforms = 0;
    let copying = false;
    let renewalsDuringCopy = 0;
    const { fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: stored }],
      cmsSaveContent: () => [200, { success: true, document: { version: 6 }, publication: { queueId: "queue-1" } }],
      "lease:read": lease["lease:read"],
      // The first heartbeat loses its precondition to a concurrent write.
      "lease:commit": body => {
        const renewal = JSON.stringify(body).includes('"transform"');
        if (renewal && copying) renewalsDuringCopy++;
        return renewal && ++transforms === 1 ? [409, {}] : lease["lease:commit"]();
      },
    });
    const tracked = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/cmsPublishSourceVideo")) {
        copying = true;
        try {
          await new Promise(resolve => setTimeout(resolve, 40));
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        } finally { copying = false; }
      }
      const isLease = String(input).startsWith("https://firestore.googleapis.com/");
      if (isLease) most = Math.max(most, ++inFlight);
      try {
        await new Promise(resolve => setTimeout(resolve, 3));
        return await fetcher(input, init);
      } finally {
        if (isLease) inFlight--;
      }
    });
    const response = await run({ mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5, ops: [],
      expectDigest: await digest() }, tracked, 5);
    expect(response.status).toBe(200);
    expect(transforms).toBeGreaterThan(1);
    expect(renewalsDuringCopy).toBeGreaterThan(0);
    expect(most).toBe(1);
  });

  it("answers 503 when the lease service cannot be reached", async () => {
    const { calls, fetcher } = upstream({ cmsGetContent: () => [200, { found: true, document: stored }] });
    const offline = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).startsWith("https://firestore.googleapis.com/")) throw new TypeError("network down");
      return fetcher(input, init);
    });
    const response = await run({ mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5, ops: [], expectDigest: await digest() }, offline);
    expect(response.status).toBe(503);
    expect(calls.some(call => call.url.endsWith("/cmsPublishSourceVideo") || call.url.endsWith("/cmsSaveContent"))).toBe(false);
  });

  it("reports a committed publication when the public update request is lost", async () => {
    const { fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: { ...stored, blocks: [] } }],
      cmsSaveContent: () => [200, { success: true, document: { version: 6 } }],
      ...freeLease(),
    });
    const lossy = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/cmsPublish")) throw new TypeError("connection reset");
      return fetcher(input, init);
    });
    const response = await run({ mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5, ops: [],
      expectDigest: await digest({ ...stored, blocks: [] }) }, lossy);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ publicationCommitted: true, version: 6 });
  });

  it("takes the lease, copies videos, saves as published, then requests the public update", async () => {
    const { calls, fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: stored }],
      cmsPublishSourceVideo: () => [200, { success: true }],
      cmsSaveContent: () => [200, { success: true, document: { version: 6 } }],
      cmsPublish: () => [200, { success: true, queueId: "queue-1", transport: "page-no-build-v1" }],
      ...freeLease(),
    });
    const response = await run({ mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5, ops: [], expectDigest: await digest() }, fetcher);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "publish", version: 6, publication: { queueId: "queue-1" } });
    expect(calls.map(call => call.url.replace(/^https:\/\/firestore\.googleapis\.com\/.*/, "lease"))).toEqual([
      `${FUNCTIONS_ORIGIN}/cmsGetContent`, "lease", "lease", "lease", "lease", `${FUNCTIONS_ORIGIN}/cmsPublishSourceVideo`,
      "lease", "lease", `${FUNCTIONS_ORIGIN}/cmsSaveContent`, `${FUNCTIONS_ORIGIN}/cmsPublish`, "lease",
    ]);
    expect(JSON.stringify(calls[4].body)).toContain('"fieldPath":"heartbeatAt"');
    expect(calls[5].body).toEqual({ sourceId: "video-library", assetId: "asset-1", collection: "cmsPages", id: "about" });
    expect(calls[8].body).toEqual({ collection: "cmsPages", id: "about", baseVersion: 5, publish: true, document: {},
      automation: { requestReference: REFERENCE, planDigest: await digest() } });
    expect(calls[9].body).toEqual({ changes: [{ collection: "cmsPages", id: "about", sourceVersion: 6 }], runtimeFirst: true });
    expect(JSON.stringify(calls[10].body)).toContain("releasedAt");
  });

  it("reports a committed publication when the public update is not confirmed", async () => {
    const { fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: { ...stored, blocks: [] } }],
      cmsSaveContent: () => [200, { success: true, document: { version: 6 } }],
      cmsPublish: () => [503, { error: "Publishing is unavailable." }],
      ...freeLease(),
    });
    const response = await run({ mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5, ops: [],
      expectDigest: await digest({ ...stored, blocks: [] }) }, fetcher);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ publicationCommitted: true, version: 6 });
  });

  it("charges each video copy to the lifecycle budget and stops when it is spent", async () => {
    const twoVideos = { ...stored, blocks: [...stored.blocks,
      { id: "video-2", type: "video", order: 1, visible: true, data: { sourceId: "video-library", assetId: "asset-2", title: "Recap" } }] };
    const { calls, fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: twoVideos }],
      cmsPublishSourceVideo: () => [200, { success: true }],
      ...freeLease(),
    });
    let charges = 0;
    const response = await run({ mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5, ops: [],
      expectDigest: await digest(twoVideos) }, fetcher, undefined,
      async () => (++charges === 1 ? null : new Response(JSON.stringify({ error: "spent" }), { status: 429 })));
    expect(response.status).toBe(429);
    expect(charges).toBe(2);
    expect(calls.filter(call => call.url.endsWith("/cmsPublishSourceVideo"))).toHaveLength(1);
    expect(calls.some(call => call.url.endsWith("/cmsSaveContent"))).toBe(false);
  });

  it("stops before the save when a video copy fails", async () => {
    const { calls, fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: stored }],
      cmsPublishSourceVideo: () => [403, { error: "You do not have permission to publish this video." }],
      ...freeLease(),
    });
    const response = await run({ mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5, ops: [], expectDigest: await digest() }, fetcher);
    expect(response.status).toBe(403);
    expect(calls.some(call => call.url.endsWith("/cmsSaveContent"))).toBe(false);
    expect(JSON.stringify(calls.at(-1)?.body)).toContain("releasedAt");
  });
});

describe("content operations route", () => {
  it.each(["dry-run", "apply"] as const)("keeps fetch unbound through a verified %s request", async mode => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { calls, fetcher } = upstream({
      cmsGetContent: () => [200, { found: true, document: { version: 1, type: "post", status: "draft", credits: [] } }],
      cmsSaveContent: () => [200, { document: { version: 2 }, warnings: [] }],
      ...freeLease(),
    });
    const receivers: unknown[] = [];
    const fetchOrigin: typeof fetch = async function (this: unknown, input, init) {
      receivers.push(this);
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return fetcher(input, init);
    };
    const env = {
      ALLOW_LOCAL_ORIGINS: "false", CMS_EDGE_ORIGIN_SECRET: "edge-secret-for-tests", FIREBASE_PROJECT_ID: "njpbs-site",
      FUNCTIONS_ORIGIN,
      RATE_LIMITERS: { getByName: () => ({ consume: () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 }) }) } as unknown as DurableObjectNamespace<CmsRateLimiter>,
    } as CmsApiEnv;
    const worker = createCmsApiHandler({ fetchOrigin, now: () => 1_000,
      randomUUID: () => "00000000-0000-4000-8000-000000000000", verifyToken: async () => ({ uid: "agent-1" }) });
    const plan = { schema: 1, mode, collection: "cmsPosts", id: "post-1", baseVersion: 1,
      requestReference: REFERENCE, ops: [{ op: "setCredits", credits: [] }] };
    const response = await worker.fetch(new Request("https://cms-api.njpbs.org/cmsContentOps", {
      method: "POST", headers: { authorization: "Bearer agent-token", "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" },
      body: JSON.stringify({ ...plan, ...(mode === "apply" ? { expectDigest: await planDigest(parseContentOpsRequest({
        ...plan, expectDigest: "0".repeat(64),
      })) } : {}) }),
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, mode });
    // Apply reads and claims the lease, saves, then releases it with one commit.
    expect(receivers).toHaveLength(mode === "apply" ? 5 : 2);
    expect(receivers.every(receiver => receiver === undefined || receiver === globalThis)).toBe(true);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer agent-token");
    if (mode === "apply") expect(JSON.stringify(calls.at(-1)?.body)).toContain("releasedAt");
  });

  it("charges a publish to the publish budget as well as the mutation budget", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>();
    let consumed = 0;
    const env = {
      ALLOW_LOCAL_ORIGINS: "false", CMS_EDGE_ORIGIN_SECRET: "edge-secret-for-tests", FIREBASE_PROJECT_ID: "njpbs-site",
      FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net",
      // The IP and actor mutation charges pass; the third charge is the actor publish budget.
      RATE_LIMITERS: { getByName: () => ({ consume: () => (++consumed === 3
        ? { allowed: false, remaining: 0, retryAfterSeconds: 40 }
        : { allowed: true, remaining: 10, retryAfterSeconds: 0 }) }) } as unknown as DurableObjectNamespace<CmsRateLimiter>,
    } as CmsApiEnv;
    const worker = createCmsApiHandler({ fetchOrigin, now: () => 1_000, randomUUID: () => "request-id",
      verifyToken: async () => ({ uid: "agent-1" }) });
    const response = await worker.fetch(new Request("https://cms-api.njpbs.org/cmsContentOps", {
      method: "POST", headers: { authorization: "Bearer agent-token", "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" },
      body: JSON.stringify({ schema: 1, mode: "publish", collection: "cmsPages", id: "about", baseVersion: 1,
        requestReference: REFERENCE, expectDigest: "a".repeat(64), ops: [] }),
    }), env);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-rate-limit-scope")).toBe("actor");
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it.each([
    ["an unavailable limiter", () => { throw new Error("limiter down"); }, 503, null],
    ["a spent lifecycle budget", () => ({ allowed: false, remaining: 0, retryAfterSeconds: 40 }), 429, "actor"],
  ] as const)("keeps the edge response for %s on a nested video copy", async (_label, fifth, status, scope) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const document = { version: 5, status: "draft", blocks: [
      { id: "video-1", type: "video", order: 0, visible: true, data: { sourceId: "video-library", assetId: "asset-1", title: "Debate" } },
    ] };
    let claimed = false;
    const fetchOrigin = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/cmsGetContent")) return new Response(JSON.stringify({ found: true, document }), { status: 200 });
      if (url.endsWith(":commit")) { claimed = true; return new Response("{}", { status: 200 }); }
      if (url.startsWith("https://firestore.googleapis.com/")) {
        return claimed
          ? new Response(JSON.stringify({ updateTime: "2026-11-03T20:00:01Z", fields: { ownerId: { stringValue: "agent-1" },
            sessionId: { stringValue: "content-api-00000000-0000-4000-8000-000000000000" } } }), { status: 200 })
          : new Response("{}", { status: 404 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 599 });
    });
    let consumed = 0;
    const env = {
      ALLOW_LOCAL_ORIGINS: "false", CMS_EDGE_ORIGIN_SECRET: "edge-secret-for-tests", FIREBASE_PROJECT_ID: "njpbs-site",
      FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net",
      // IP and actor mutation, actor and IP publish, then the first lifecycle charge.
      RATE_LIMITERS: { getByName: () => ({ consume: (input: { nowMs: number }) => {
        times.push(input.nowMs);
        return ++consumed === 5 ? fifth() : { allowed: true, remaining: 10, retryAfterSeconds: 0 };
      } }) } as unknown as DurableObjectNamespace<CmsRateLimiter>,
    } as CmsApiEnv;
    // The clock moves on every read, so a nested charge must carry a later time than the request start.
    let clock = 1_000;
    const times: number[] = [];
    const worker = createCmsApiHandler({ fetchOrigin, now: () => (clock += 100), randomUUID: () => "00000000-0000-4000-8000-000000000000",
      verifyToken: async () => ({ uid: "agent-1" }) });
    const expectDigest = await planDigest(parseContentOpsRequest({ schema: 1, mode: "publish", collection: "cmsPages", id: "about",
      baseVersion: 5, requestReference: REFERENCE, expectDigest: "0".repeat(64), ops: [] }));
    const response = await worker.fetch(new Request("https://cms-api.njpbs.org/cmsContentOps", {
      method: "POST", headers: { authorization: "Bearer agent-token", "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" },
      body: JSON.stringify({ schema: 1, mode: "publish", collection: "cmsPages", id: "about", baseVersion: 5,
        requestReference: REFERENCE, expectDigest, ops: [] }),
    }), env);
    expect(response.status).toBe(status);
    expect(times[4]).toBeGreaterThan(times[0]);
    expect(response.headers.get("x-rate-limit-scope")).toBe(scope);
    if (scope) expect(response.headers.get("retry-after")).toBe("40");
    expect(fetchOrigin.mock.calls.some(([input]) => String(input).endsWith("/cmsPublishSourceVideo"))).toBe(false);
  });

  it("is served by the edge with a verified caller and forwards that caller's token", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ found: false }), { status: 200 }));
    const env = {
      ALLOW_LOCAL_ORIGINS: "false", CMS_EDGE_ORIGIN_SECRET: "edge-secret-for-tests", FIREBASE_PROJECT_ID: "njpbs-site",
      FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net",
      RATE_LIMITERS: { getByName: () => ({ consume: () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 }) }) } as unknown as DurableObjectNamespace<CmsRateLimiter>,
    } as CmsApiEnv;
    const worker = createCmsApiHandler({ fetchOrigin, now: () => 1_000, randomUUID: () => "request-id",
      verifyToken: async () => ({ uid: "agent-1" }) });
    const response = await worker.fetch(new Request("https://cms-api.njpbs.org/cmsContentOps", {
      method: "POST", headers: { authorization: "Bearer agent-token", "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" },
      body: JSON.stringify({ schema: 1, mode: "dry-run", collection: "cmsPages", id: "about", baseVersion: 1,
        requestReference: REFERENCE, ops: [{ op: "remove", id: "a" }] }),
    }), env);
    expect(response.status).toBe(404);
    const [url, init] = fetchOrigin.mock.calls[0];
    expect(String(url)).toBe("https://us-central1-njpbs-site.cloudfunctions.net/cmsGetContent");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer agent-token");
    expect(new Headers(init?.headers).get("x-njpbs-cms-edge")).toBe("edge-secret-for-tests");
  });
});
