import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import clientModule from "../../functions/lib/cuez-transfer-storydesk.js";
import operationsModule from "../../functions/lib/cuez-transfer-operations.js";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { storydeskProvider } from "../helpers/cuez-storydesk-provider.js";
const operationId = "a".repeat(64);
const key = "test-bearer-do-not-echo";
const storyId = "00000000-0000-4000-8000-000000000099";
const marker = `[boardwalk-transfer:${operationId}]`;
const config = { apiKey: key, newsdeskId: "test-newsdesk" };
const client = (fetchImpl, timeoutMs = 1000) => clientModule.createStorydeskClient({ ...config, fetchImpl, timeoutMs });
const writes = [
  ["stories_create", { title: "Selected Post", description: "Outlet credit: Example outlet; source: https://outlet.example.test/story" }, "stories"],
  ["sections_create", { storyId, title: "Speaker-labeled transcript", content: "spk_0: Private transcript text" }, "sections"],
  ["assets_import_from_url", { storyId, url: "https://storage.example.test/video?token=test-url-token", filename: "video.mp4" }, "assets"],
];
const create = (c, tool = writes[0][0], args = writes[0][1], priorOutcome = "not-attempted") =>
  c.create({ operationId, tool, arguments: args, priorOutcome });
const envelope = (id, data) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } });
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
async function safeFailure(promise, code) {
  let caught;
  try { await promise; } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code });
  const serialized = `${caught} ${caught.stack} ${JSON.stringify(caught)}`;
  for (const secret of [key, "test-url-token", "Private transcript text", "unsafe-provider-message"]) expect(serialized).not.toContain(secret);
  return caught;
}
describe("StoryDesk MCP transport", () => {
  it.each([false, true])("reads JSON text content through the fixed POST endpoint (SSE=%s)", async sse => {
    const provider = storydeskProvider({ sse });
    let initSeen;
    const c = client(async (url, init) => { initSeen = init; return provider.fetch(url, init); });
    expect(await c.call("script_get", { storyId })).toEqual({ text: "Test Brief", html: "<p>Test Brief</p>", contentHash: "test-content-hash" });
    expect(provider.calls[0]).toEqual({ url: "https://api.us.storydesk.cuez.app/v1/mcp/", name: "script_get", args: { storyId } });
    expect(initSeen).toMatchObject({ method: "POST", redirect: "error", headers: {
      Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } });
    const rpc = JSON.parse(initSeen.body);
    expect(rpc).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "script_get", arguments: { storyId } } });
    expect(rpc.id).toBe(1);
  });
  it("injects only the configured newsdesk into newsdesk-scoped tools", async () => {
    const provider = storydeskProvider(); const c = client(provider.fetch);
    await c.call("stories_list", { search: "test", page: 1, limit: 20 });
    await c.call("assets_search", { query: "train", type: "video" });
    for (const call of provider.calls) expect(call.args.newsdeskId).toBe(config.newsdeskId);
    await safeFailure(c.call("stories_list", { newsdeskId: "other" }), "invalid_request");
    expect(provider.calls).toHaveLength(2);
  });
  it("parses multiline SSE events with CRLF, notifications and a matching response ID", async () => {
    const c = client(async (_url, init) => {
      const { id } = JSON.parse(init.body);
      const response = JSON.stringify(envelope(id, { contentHash: "live-brief" }), null, 2)
        .split("\n").map(line => `data: ${line}`).join("\r\n");
      return new Response(`: ping\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\n${response}\r\n\r\n`,
        { headers: { "content-type": "text/event-stream" } });
    });
    expect(await c.call("script_get", { storyId })).toEqual({ contentHash: "live-brief" });
  });
  it.each([[401, "not_authorized"], [403, "not_authorized"], [400, "invalid_request"],
    [404, "output_unavailable"], [409, "remote_conflict"], [412, "remote_conflict"],
    [429, "transient_failure"], [503, "transient_failure"]])("maps HTTP %s safely", async (status, code) => {
    await safeFailure(client(async () => new Response(`${key} test-url-token Private transcript text`, { status }))
      .call("stories_get", { storyId }), code);
  });
  it.each([[-32000, "not_authorized"], [-32602, "invalid_request"], [-32601, "not_configured"], [-32603, "transient_failure"]])(
    "maps JSON-RPC %s without echoing provider data", async (code, safe) => {
      await safeFailure(client(async (_url, init) => json({ jsonrpc: "2.0", id: JSON.parse(init.body).id,
        error: { code, message: `unsafe-provider-message ${key} test-url-token Private transcript text` } }))
        .call("stories_get", { storyId }), safe);
    });
  it("refuses unapproved tools and unsafe draft arguments before fetch", async () => {
    let calls = 0;
    const c = client(async () => { calls++; throw new Error("Fetch must not run"); });
    for (const tool of ["publish", "stories_delete", "script_update", "social_posts_publish",
      "web_posts_publish", "stories_schedule", "stories_unpublish", "embargo_set", "privacy_update",
      "tag_categories_create", "dossier_templates_list", "constructor", "__proto__"]) {
      await safeFailure(c.call(tool, {}), "not_authorized");
    }
    await safeFailure(c.call("stories_create", { title: "Unmarked" }), "invalid_request");
    await safeFailure(c.call("stories_update", { storyId, title: "Changed" }), "invalid_request");
    await safeFailure(c.call("sections_update", { storyId, sectionId: "section", title: "Changed" }), "invalid_request");
    await safeFailure(create(c, "stories_create", { title: "Test", scheduledDate: "2026-10-29" }), "invalid_request");
    await safeFailure(create(c, "sections_create", { storyId, title: "Test", templateId: "unapproved-template" }), "invalid_request");
    await safeFailure(create(c, "sections_create", { storyId, title: "Brief" }), "invalid_request");
    await safeFailure(create(c, "assets_import_from_url", { storyId, url: "https://storage.example.test/test", filename: "path/file" }), "invalid_request");
    await safeFailure(create(c, "stories_create_from_url", { url: "https://outlet.example.test/story" }), "invalid_request");
    await safeFailure(c.create({ operationId, tool: "stories_create", arguments: { title: "Test" } }), "invalid_request");
    expect(calls).toBe(0);
  });
  it("requires injected configuration without reading secrets", () => {
    expect(() => clientModule.createStorydeskClient()).toThrow(expect.objectContaining({ code: "not_configured" }));
    expect(() => clientModule.createStorydeskClient({ ...config, apiKey: "bad\nheader" })).toThrow(expect.objectContaining({ code: "not_configured" }));
  });
  it.each(["wrong-id", "duplicate", "invalid-json", "tool-error"])("rejects an unsettled response: %s", async mode => {
    const c = client(async (_url, init) => {
      const id = JSON.parse(init.body).id;
      if (mode === "invalid-json") return new Response("Private transcript text");
      if (mode === "wrong-id") return json(envelope(id + 1, {}));
      if (mode === "tool-error") return json({ jsonrpc: "2.0", id, result: { isError: true,
        content: [{ type: "text", text: `unsafe-provider-message ${key}` }] } });
      return new Response(`data: ${JSON.stringify(envelope(id, {}))}\n\ndata: ${JSON.stringify(envelope(id, {}))}\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    });
    await safeFailure(c.call("stories_get", { storyId }), mode === "tool-error" ? "invalid_request" : "outcome_unknown");
  });
  it("bounds response bytes and times out a stalled body", async () => {
    await safeFailure(client(async () => new Response("x".repeat(2 * 1024 * 1024 + 1)))
      .call("stories_get", { storyId }), "outcome_unknown");
    let cancelled = false;
    const c = client(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: {")); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } }), 10);
    await safeFailure(c.call("stories_get", { storyId }), "outcome_unknown");
    expect(cancelled).toBe(true);
  });
});

describe("creates and lost-response reconciliation", () => {
  it.each(writes)("accepts the live %s create shape without depending on a lookup", async (tool, args, collection) => {
    const provider = storydeskProvider(); const c = client(provider.fetch);
    const result = await create(c, tool, args);
    expect(result).toEqual({ state: "complete", remoteIdentity: "00000000-0000-4000-8000-000000000001", recovered: false });
    const object = provider.objects[collection][0];
    if (tool === "stories_create") expect(object.description).toBe(`${args.description}\n${marker}`);
    if (tool === "sections_create") expect(object.title).toBe(`${args.title} ${marker}`);
    if (tool === "assets_import_from_url") expect(provider.calls[0].args.filename).toBe("video.mp4");
    expect(JSON.stringify(result)).not.toMatch(/test-url-token|Private transcript text|Outlet credit/);
    expect(provider.calls).toHaveLength(1);
    const repeated = await create(c, tool, args);
    if (tool === "assets_import_from_url") expect(repeated.state).toBe("reconciliation");
    else expect(repeated.recovered).toBe(true);
    expect(provider.calls.filter(call => call.name === tool)).toHaveLength(1);
  });
  it.each(writes.flatMap(row => ["drop-after", "timeout-after", "malformed-after"].map(mode => [...row, mode])))(
    "looks up %s after %s without another create", async (tool, args, collection, mode) => {
      const provider = storydeskProvider({ sse: true });
      provider.failNext({ tool, mode, message: `${key} test-url-token Private transcript text` });
      const c = client(provider.fetch, 10);
      expect(await create(c, tool, args)).toMatchObject(tool === "assets_import_from_url" ?
        { state: "reconciliation", errorCode: "outcome_unknown" } : { state: "complete", recovered: true });
      expect(provider.objects[collection]).toHaveLength(1);
      expect(provider.calls.filter(call => call.name === tool)).toHaveLength(1);
      if (tool !== "assets_import_from_url") expect(provider.calls[1].name).toBe({ stories_create: "stories_list", sections_create: "sections_list" }[tool]);
    });
  it("stops on an empty lookup after a dropped request and on worker restart", async () => {
    const provider = storydeskProvider(); provider.failNext({ tool: "stories_create", mode: "drop-before" });
    expect(await create(client(provider.fetch))).toEqual({ state: "reconciliation", errorCode: "outcome_unknown" });
    expect(await create(client(provider.fetch), "stories_create", writes[0][1], "unknown"))
      .toEqual({ state: "reconciliation", errorCode: "outcome_unknown" });
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(1);
  });
  it("uses only lookup when durable state says the prior outcome is unknown", async () => {
    const provider = storydeskProvider();
    await create(client(provider.fetch));
    const resumed = client(provider.fetch);
    expect(await create(resumed, "stories_create", writes[0][1], "unknown")).toMatchObject({ state: "complete", recovered: true });
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(1);
  });
  it.each(["ambiguous", "paginated", "unsupported", "unmarked", "failed"])("stays in reconciliation for %s lookup evidence", async mode => {
    const provider = storydeskProvider(); await create(client(provider.fetch));
    if (mode === "ambiguous") provider.objects.stories.push({ ...provider.objects.stories[0], id: "second-story" });
    if (mode === "unmarked") provider.objects.stories[0].description = "No exact transfer marker";
    const c = client(async (url, init) => {
      const rpc = JSON.parse(init.body);
      if (rpc.params.name === "stories_list" && mode === "paginated") return json(envelope(rpc.id,
        { data: provider.objects.stories, meta: { page: 1, limit: 1, total: 2, totalPages: 2 } }));
      if (rpc.params.name === "stories_list" && mode === "unsupported") return json(envelope(rpc.id, provider.objects.stories));
      if (mode === "failed") throw new Error(`unsafe-provider-message ${key}`);
      return provider.fetch(url, init);
    });
    expect(await create(c, "stories_create", writes[0][1], "unknown")).toEqual({ state: "reconciliation", errorCode: "outcome_unknown" });
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(1);
  });
  it("does not mistake a forged transport error code for a confirmed failure", async () => {
    const provider = storydeskProvider();
    const c = client(async (url, init) => {
      if (JSON.parse(init.body).params.name === "stories_create") throw Object.assign(new Error(`unsafe-provider-message ${key}`), { code: "transient_failure" });
      return provider.fetch(url, init);
    });
    expect(await create(c)).toEqual({ state: "reconciliation", errorCode: "outcome_unknown" });
  });
  it("never retries a server failure as a known-not-applied write", async () => {
    const provider = storydeskProvider(); provider.failNext({ tool: "stories_create", mode: "http", status: 503 });
    expect(await create(client(provider.fetch))).toEqual({ state: "reconciliation", errorCode: "outcome_unknown" });
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(1);
  });
  it("allows an explicit retry after a confirmed rate rejection and deduplicates concurrent calls", async () => {
    const provider = storydeskProvider(); const c = client(provider.fetch);
    provider.failNext({ tool: "stories_create", mode: "http", status: 429 });
    await safeFailure(create(c), "transient_failure");
    const results = await Promise.all([create(c), create(c)]);
    expect(results.every(result => result.state === "complete")).toBe(true);
    expect(provider.objects.stories).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(2);
  });
  it("escapes transcript lines as HTML paragraphs", async () => {
    const provider = storydeskProvider();
    await create(client(provider.fetch), "sections_create", { storyId, title: "Transcript",
      content: '00:01 <Alice> & "Bob"\r\n00:02 It\'s <script>alert(1)</script>\n\nLast line' });
    expect(provider.objects.sections[0].content).toBe('<p>00:01 &lt;Alice&gt; &amp; &quot;Bob&quot;</p>\n' +
      '<p>00:02 It&#39;s &lt;script&gt;alert(1)&lt;/script&gt;</p>\n<p></p>\n<p>Last line</p>');
  });
  it("matches dossiers only in the requested story and checks exact content", async () => {
    const provider = storydeskProvider();
    await create(client(provider.fetch), "sections_create", writes[1][1]);
    provider.objects.sections.push({ ...provider.objects.sections[0], id: "other-section", storyId: "other-story" });
    expect(await create(client(provider.fetch), "sections_create", writes[1][1], "unknown")).toMatchObject({ state: "complete", recovered: true });
    provider.objects.sections[0].content = "Edited by staff";
    expect(await create(client(provider.fetch), "sections_create", writes[1][1], "unknown")).toMatchObject({ state: "reconciliation" });
    expect(provider.calls.filter(call => call.name === "sections_create")).toHaveLength(1);
  });
});

const db = isolatedFirestore("cuez-storydesk-steps");
const operationStore = () => operationsModule.createTransferOperations({ firestore: db });
function preparedExport(kind = "post", revision = 1, target = kind === "post" || kind === "video" ? "new-story" : kind === "transcript" ? "dossier" : "story-asset") {
  const s = { kind, expectedUpdateTime: `${revision}:0`, expectedVersion: revision };
  const record = { collection: { post: "cmsPosts", image: "media_assets", video: "mediaSourceAssets", transcript: "mediaSourceAssets" }[kind],
    recordId: "selected", updateTime: `${revision}:0`, version: revision };
  const resolved = { record };
  if (kind === "post") s.recordId = "selected";
  else s.assetId = "selected";
  if (["video", "transcript"].includes(kind)) {
    Object.assign(s, { sourceId: "video-library", fileVersion: "74bca5c72cb25c4d9532b08d956d1dc5" });
    resolved.original = { bucket: "test-originals", objectKey: "objects/video.mp4", objectVersionId: "original-v1", sizeBytes: 1000 };
  }
  if (kind === "image") resolved.image = { storageKey: "images/selected.png", sizeBytes: 100, mimeType: "image/png" };
  if (kind === "transcript") {
    Object.assign(s, { transcriptId: "b".repeat(64), expectedJobUpdateTime: `${revision}:0`, expectedEditRevision: revision - 1 });
    resolved.transcript = { jobId: s.transcriptId, updateTime: s.expectedJobUpdateTime, editRevision: s.expectedEditRevision,
      segments: { objectKey: "transcripts/segments.json", objectVersionId: `segments-${revision}` },
      text: { objectKey: "transcripts/text.txt", objectVersionId: `text-${revision}` } };
  }
  return { direction: "export", initiatedBy: "staff", origin: null, resolvedSelection: resolved,
    selectionSnapshot: { workspaceId: config.newsdeskId, selection: s, target: { kind: target, ...(target === "new-story" ? {} : { storyId }) }, mappingVersion: 1 } };
}
async function claimExport(p = preparedExport()) {
  const store = operationStore();
  const queued = await store.enqueue(p);
  return (await store.claim(queued.operation.operationId, p)).operation;
}
const readOperation = async op => (await db.collection(operationsModule.OPERATIONS).doc(op.operationId).get()).data();
const writeStep = (c, op, step, tool, args, expectedMappingOperationId = null) =>
  c.writeStep({ operations: operationStore(), operationId: op.operationId, attemptId: op.attemptId, step, tool, arguments: args, expectedMappingOperationId });
async function finishExport(op, result, expectedMappingOperationId = null) {
  return operationStore().complete({ operationId: op.operationId, attemptId: op.attemptId,
    remoteIdentity: result.remoteIdentity, remoteChangeMarker: result.remoteChangeMarker, expectedMappingOperationId });
}
describe("durable guarded provider steps", () => {
  beforeEach(async () => {
    await Promise.all([operationsModule.OPERATIONS, operationsModule.MAPPINGS].map(name => db.recursiveDelete(db.collection(name))));
  });
  it("preserves a staff dossier rename on re-export", async () => {
    const provider = storydeskProvider(), c = client(provider.fetch);
    const first = await claimExport(preparedExport("transcript"));
    const args = { storyId, title: "Transcript", content: "First line" };
    const sent = await writeStep(c, first, "content", "sections_create", args);
    await finishExport(first, sent);
    provider.objects.sections[0].title = "Staff title";
    const second = await claimExport(preparedExport("transcript", 2));
    expect(await writeStep(c, second, "content", "sections_create", { ...args, content: "Next line" }, first.operationId))
      .toMatchObject({ state: "conflict", errorCode: "remote_conflict" });
    expect(provider.objects.sections[0].title).toBe("Staff title");
    expect(provider.calls.filter(call => call.name === "sections_update")).toHaveLength(0);
  });
  it("releases a reservation after transformed payload validation fails", async () => {
    const provider = storydeskProvider(), c = client(provider.fetch);
    const first = await claimExport();
    await expect(writeStep(c, first, "story", "stories_create", { title: "Draft", description: "a".repeat(511950) }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(await readOperation(first)).toMatchObject({ state: "failed", errorCode: "invalid_request", steps: {} });
    expect((await db.collection(operationsModule.MAPPINGS).get()).empty).toBe(true);
    expect(provider.calls).toHaveLength(0);
    const second = await claimExport(preparedExport("post", 2));
    expect(await writeStep(c, second, "story", "stories_create", { title: "Shortened", description: "Valid" }))
      .toMatchObject({ state: "complete" });
  });
  it.each(["post", "transcript"])("recovers a concurrent %s update during a delayed revision read", async kind => {
    const provider = storydeskProvider(), c = client(provider.fetch);
    const tool = kind === "post" ? "stories_create" : "sections_create";
    const readTool = kind === "post" ? "stories_get" : "sections_list";
    const args = kind === "post" ? { title: "First", description: "First draft" } : { storyId, title: "Transcript", content: "First line" };
    const first = await claimExport(preparedExport(kind));
    await finishExport(first, await writeStep(c, first, "content", tool, args));
    const second = await claimExport(preparedExport(kind, 2));
    let reading, release;
    const started = new Promise(resolve => { reading = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const slow = client(async (url, init) => {
      if (JSON.parse(init.body).params.name === readTool) { reading(); await gate; }
      return provider.fetch(url, init);
    });
    const nextArgs = { ...args, title: "Updated", ...(kind === "post" ? { description: "Next" } : { content: "Next" }) };
    const delayed = writeStep(slow, second, "content", tool, nextArgs, first.operationId);
    await started;
    const sent = await writeStep(c, second, "content", tool, nextArgs, first.operationId);
    release();
    expect(sent.state).toBe("complete");
    expect(await delayed).toMatchObject({ state: "complete", remoteIdentity: sent.remoteIdentity });
    expect((await readOperation(second)).state).toBe("transferring");
    expect(provider.calls.filter(call => call.name === (kind === "post" ? "stories_update" : "sections_update"))).toHaveLength(1);
    expect((await finishExport(second, sent, first.operationId)).state).toBe("complete");
  });
  it.each(["post", "transcript"])("updates a mapped %s in place and stores independent remote revision evidence", async kind => {
    const provider = storydeskProvider();
    const tool = kind === "post" ? "stories_create" : "sections_create";
    const args = kind === "post" ? { title: "First", description: "First draft" } : { storyId, title: "Transcript", content: "First line" };
    const first = await claimExport(preparedExport(kind));
    const sent = await writeStep(client(provider.fetch), first, "content", tool, args);
    expect(sent.state).toBe("complete");
    const done = await finishExport(first, sent);
    const second = await claimExport(preparedExport(kind, 2));
    const nextArgs = kind === "post" ? { title: "Updated", description: "Second draft" } : { storyId, title: "Transcript", content: "Next & line" };
    const updated = await writeStep(client(provider.fetch), second, "content", tool, nextArgs, first.operationId);
    expect(updated).toMatchObject({ state: "complete", remoteIdentity: sent.remoteIdentity, recovered: false });
    expect(provider.objects[kind === "post" ? "stories" : "sections"]).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === tool)).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === (kind === "post" ? "stories_update" : "sections_update"))).toHaveLength(1);
    const completed = await finishExport(second, updated, first.operationId);
    expect(completed.mappingId).toBe(done.mappingId);
    const mapping = (await db.collection(operationsModule.MAPPINGS).doc(done.mappingId).get()).data();
    expect(mapping).toMatchObject({ externalId: sent.remoteIdentity, lastOperationId: second.operationId });
    if (kind === "post") {
      expect(mapping.lastRemoteRevision).toBe(provider.objects.stories[0].updatedAt);
      expect(provider.objects.stories[0].description).toBe(`Second draft\n[boardwalk-transfer:${second.operationId}]`);
    } else {
      expect(provider.objects.sections[0].content).toBe("<p>Next &amp; line</p>");
      expect(mapping.lastRemoteRevision).toBe(createHash("sha256").update(JSON.stringify([`Transcript [boardwalk-transfer:${second.operationId}]`, "<p>Next &amp; line</p>"])).digest("hex"));
    }
  });
  it.each(["post", "transcript"])("records a %s remote edit conflict before any re-export write", async kind => {
    const provider = storydeskProvider(); const c = client(provider.fetch);
    const tool = kind === "post" ? "stories_create" : "sections_create";
    const args = kind === "post" ? { title: "First", description: "First draft" } : { storyId, title: "Transcript", content: "First line" };
    const first = await claimExport(preparedExport(kind));
    const sent = await writeStep(c, first, "content", tool, args);
    const done = await finishExport(first, sent);
    if (kind === "post") Object.assign(provider.objects.stories[0], { description: "Staff edit", updatedAt: "2026-10-29T16:00:00Z" });
    else provider.objects.sections[0].content = "<p>Staff edit</p>";
    const callsBefore = provider.calls.filter(call => clientModule.WRITE_TOOLS.includes(call.name)).length;
    const second = await claimExport(preparedExport(kind, 2));
    expect(await writeStep(c, second, "content", tool, { ...args, title: "Local revision" }, first.operationId))
      .toEqual({ state: "conflict", errorCode: "remote_conflict" });
    expect(provider.calls.filter(call => clientModule.WRITE_TOOLS.includes(call.name))).toHaveLength(callsBefore);
    const saved = await readOperation(second);
    expect(saved).toMatchObject({ state: "conflict", errorCode: "remote_conflict",
      conflict: { selectionSnapshot: second.selectionSnapshot, resolvedSelection: second.resolvedSelection } });
    expect(saved.conflict.remoteRevision).toBe(kind === "post" ? "2026-10-29T16:00:00Z" :
      createHash("sha256").update(JSON.stringify([`Transcript [boardwalk-transfer:${first.operationId}]`, "<p>Staff edit</p>"])).digest("hex"));
    expect(provider.objects[kind === "post" ? "stories" : "sections"][0][kind === "post" ? "description" : "content"]).toContain("Staff edit");
    expect((await db.collection(operationsModule.MAPPINGS).doc(done.mappingId).get()).data()).toMatchObject({ lastOperationId: first.operationId, pendingOperationId: null });
  });
  it("refuses a stale mapping before any provider call", async () => {
    const provider = storydeskProvider(); const c = client(provider.fetch);
    const first = await claimExport(); const sent = await writeStep(c, first, "story", "stories_create", writes[0][1]);
    await finishExport(first, sent);
    const second = await claimExport(preparedExport("post", 2));
    const callsBefore = provider.calls.length;
    expect(await writeStep(c, second, "story", "stories_create", writes[0][1])).toMatchObject({ state: "conflict" });
    expect(provider.calls).toHaveLength(callsBefore);
    expect(provider.objects.stories).toHaveLength(1);
  });
  it("adds assets with new IDs on re-export and records the pre-import ID set", async () => {
    const provider = storydeskProvider(); const c = client(provider.fetch);
    provider.objects.assets.push({ id: "staff-asset", storyId });
    const first = await claimExport(preparedExport("image"));
    const sent = await writeStep(c, first, "asset", "assets_import_from_url", writes[2][1]);
    const done = await finishExport(first, sent);
    expect((await readOperation(first)).steps.asset).toMatchObject({ outcome: "complete", remoteIdentity: sent.remoteIdentity, preImportAssetIds: ["staff-asset"] });
    const second = await claimExport(preparedExport("image", 2));
    const next = await writeStep(c, second, "asset", "assets_import_from_url", writes[2][1], first.operationId);
    expect(next.state).toBe("complete");
    expect(next.remoteIdentity).not.toBe(sent.remoteIdentity);
    await finishExport(second, next, first.operationId);
    expect((await db.collection(operationsModule.MAPPINGS).doc(done.mappingId).get()).data().externalId).toBe(next.remoteIdentity);
    expect(provider.calls.filter(call => call.name === "assets_import_from_url")).toHaveLength(2);
  });
  it.each([false, true])("keeps an unknown asset import in reconciliation, including one new ID (staff edit=%s)", async staffEdit => {
    const provider = storydeskProvider();
    provider.objects.assets.push({ id: "existing-asset", storyId });
    const op = await claimExport(preparedExport("image"));
    provider.failNext({ tool: "assets_import_from_url", mode: "drop-after" });
    expect(await writeStep(client(provider.fetch), op, "asset", "assets_import_from_url", writes[2][1]))
      .toEqual({ state: "reconciliation", errorCode: "outcome_unknown" });
    if (staffEdit) provider.objects.assets.push({ id: "concurrent-staff-asset", storyId });
    const saved = await readOperation(op);
    expect(saved.steps.asset).toMatchObject({ outcome: "unknown", preImportAssetIds: ["existing-asset"], remoteIdentity: null });
    expect(await writeStep(client(provider.fetch), op, "asset", "assets_import_from_url", writes[2][1])).toMatchObject({ state: "reconciliation" });
    expect(provider.calls.filter(call => call.name === "assets_import_from_url")).toHaveLength(1);
  });
  it.each([[429, "transient_failure"], [404, "output_unavailable"]])(
    "does not repeat story creation after asset HTTP %s and a worker restart", async (status, errorCode) => {
    const provider = storydeskProvider();
    const p = preparedExport("video"); const first = await claimExport(p);
    const story = await writeStep(client(provider.fetch), first, "story", "stories_create", { title: "Video", description: "Selected video" });
    provider.failNext({ tool: "assets_import_from_url", mode: "http", status });
    const args = { ...writes[2][1], storyId: story.remoteIdentity };
    expect(await writeStep(client(provider.fetch), first, "asset", "assets_import_from_url", args)).toEqual({ state: "failed", errorCode });
    await operationStore().advance({ operationId: first.operationId, attemptId: first.attemptId, event: "retry" });
    const retried = (await operationStore().claim(first.operationId, p)).operation;
    expect(await writeStep(client(provider.fetch), retried, "story", "stories_create", { title: "Video", description: "Selected video" }))
      .toMatchObject({ state: "complete", remoteIdentity: story.remoteIdentity, recovered: true });
    expect(await writeStep(client(provider.fetch), retried, "asset", "assets_import_from_url",
      { ...args, url: "https://storage.example.test/video?token=renewed-test-url" })).toMatchObject({ state: "complete" });
    expect(provider.objects.stories).toHaveLength(1);
    expect(provider.objects.assets).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(1);
    expect((await readOperation(first)).steps).toMatchObject({ story: { outcome: "complete", remoteIdentity: story.remoteIdentity }, asset: { outcome: "complete" } });
  });
  it("resumes a partially applied re-export without a false conflict on the next revision", async () => {
    const provider = storydeskProvider(); const c = client(provider.fetch);
    const first = await claimExport(preparedExport("video"));
    const initial = await writeStep(c, first, "story", "stories_create", { title: "First video" });
    const args = { ...writes[2][1], storyId: initial.remoteIdentity };
    await writeStep(c, first, "asset", "assets_import_from_url", args);
    const done = await finishExport(first, initial);
    const p = preparedExport("video", 2); const second = await claimExport(p);
    const storyArgs = { title: "Updated video" };
    const updated = await writeStep(c, second, "story", "stories_create", storyArgs, first.operationId);
    provider.failNext({ tool: "assets_import_from_url", mode: "http", status: 404 });
    expect(await writeStep(c, second, "asset", "assets_import_from_url", args, first.operationId))
      .toEqual({ state: "failed", errorCode: "output_unavailable" });
    expect((await db.collection(operationsModule.MAPPINGS).doc(done.mappingId).get()).data())
      .toMatchObject({ lastOperationId: first.operationId, pendingOperationId: second.operationId });
    await operationStore().advance({ ...second, event: "retry" });
    const retried = (await operationStore().claim(second.operationId, p)).operation;
    const resumed = await writeStep(client(provider.fetch), retried, "story", "stories_create", storyArgs, first.operationId);
    expect(resumed).toMatchObject({ state: "complete", recovered: true, remoteIdentity: initial.remoteIdentity,
      remoteChangeMarker: updated.remoteChangeMarker });
    await writeStep(client(provider.fetch), retried, "asset", "assets_import_from_url", args, first.operationId);
    await finishExport(retried, resumed, first.operationId);
    const third = await claimExport(preparedExport("video", 3));
    expect(await writeStep(client(provider.fetch), third, "story", "stories_create", { title: "Next video" }, second.operationId))
      .toMatchObject({ state: "complete", remoteIdentity: initial.remoteIdentity });
    expect(provider.objects.stories).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === "stories_update")).toHaveLength(2);
  });
  it.each([409, 412].flatMap(status => [false, true].map(update => [status, update])))(
    "records write HTTP %s as a confirmed conflict (update=%s)", async (status, update) => {
      const provider = storydeskProvider(); const c = client(provider.fetch);
      let expectedMappingOperationId = null;
      if (update) {
        const first = await claimExport();
        const sent = await writeStep(c, first, "story", "stories_create", writes[0][1]);
        await finishExport(first, sent);
        expectedMappingOperationId = first.operationId;
      }
      const op = await claimExport(preparedExport("post", update ? 2 : 1));
      provider.failNext({ tool: update ? "stories_update" : "stories_create", mode: "http", status });
      expect(await writeStep(c, op, "story", "stories_create", { title: "Rejected draft" }, expectedMappingOperationId))
        .toEqual({ state: "conflict", errorCode: "remote_conflict" });
      const saved = await readOperation(op);
      expect(saved).toMatchObject({ state: "conflict", lastEvent: "confirmed_conflict", errorCode: "remote_conflict",
        steps: { story: { outcome: "not-applied", errorCode: "remote_conflict" } },
        conflict: { remoteRevision: "unavailable", selectionSnapshot: op.selectionSnapshot, resolvedSelection: op.resolvedSelection } });
      expect(saved.conflict.localRevision).toBe(saved.steps.story.payloadHash);
      expect(provider.objects.stories).toHaveLength(update ? 1 : 0);
      if (update) expect(provider.objects.stories[0].title).toBe(writes[0][1].title);
    });
  it.each([409, 412, 404, 400])("adopts a partial story after asset HTTP %s and exports a new file without a duplicate story", async status => {
    const provider = storydeskProvider(); const c = client(provider.fetch);
    const first = await claimExport(preparedExport("video"));
    const story = await writeStep(c, first, "story", "stories_create", writes[0][1]);
    provider.failNext({ tool: "assets_import_from_url", mode: "http", status });
    const state = [409, 412].includes(status) ? "conflict" : "failed";
    expect(await writeStep(c, first, "asset", "assets_import_from_url", { ...writes[2][1], storyId: story.remoteIdentity }))
      .toMatchObject({ state });
    const changedSelection = revision => {
      const p = preparedExport("video", revision);
      p.resolvedSelection.original.objectVersionId = `original-v${revision}`;
      p.selectionSnapshot.selection.fileVersion = createHash("sha256").update(`source-media-file-version:original-v${revision}`).digest("hex").slice(0, 32);
      return p;
    };
    const changed = changedSelection(2);
    await expect(operationStore().claim(first.operationId, changed)).rejects.toMatchObject({ code: "selection_changed" });
    const blocked = await claimExport(changed);
    expect(await writeStep(c, blocked, "story", "stories_create", { title: "New file" })).toMatchObject({ state: "conflict" });
    const closed = await operationStore().acknowledgePartial({ ...first, acknowledgedBy: "reviewing-staff" });
    expect(closed).toMatchObject({ state, remoteIdentity: story.remoteIdentity,
      partialAcknowledgment: { completedStepIds: ["story"] } });
    const next = await claimExport(changedSelection(3));
    const resumed = client(provider.fetch);
    const updated = await writeStep(resumed, next, "story", "stories_create", { title: "Replacement file" }, first.operationId);
    expect(updated).toMatchObject({ state: "complete", remoteIdentity: story.remoteIdentity });
    expect(await writeStep(resumed, next, "asset", "assets_import_from_url", {
      ...writes[2][1], storyId: story.remoteIdentity, url: "https://storage.example.test/replacement?token=renewed",
    }, first.operationId)).toMatchObject({ state: "complete" });
    const done = await finishExport(next, updated, first.operationId);
    expect((await db.collection(operationsModule.MAPPINGS).doc(done.mappingId).get()).data())
      .toMatchObject({ externalId: story.remoteIdentity, lastOperationId: next.operationId, pendingOperationId: null });
    expect(provider.objects.stories).toHaveLength(1);
    expect(provider.objects.assets).toHaveLength(1);
    expect(provider.objects.assets[0].storyId).toBe(story.remoteIdentity);
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === "stories_update")).toHaveLength(1);
  });
  it.each(["post", "transcript"].flatMap(kind => [
    ["http", 401, "not_authorized"], ["http", 403, "not_authorized"],
    ["http", 400, "invalid_request"], ["http", 422, "invalid_request"],
    ["http", 404, "output_unavailable"], ["http", 409, "remote_conflict"], ["http", 412, "remote_conflict"],
    ["rpc-error", -32000, "not_authorized"], ["rpc-error", -32601, "not_configured"], ["rpc-error", -32602, "invalid_request"],
  ].map(failure => [kind, ...failure])))(
    "preserves a %s pre-write read rejection (%s %s) as %s", async (kind, mode, status, errorCode) => {
      const provider = storydeskProvider(); const c = client(provider.fetch);
      const tool = kind === "post" ? "stories_create" : "sections_create";
      const readTool = kind === "post" ? "stories_get" : "sections_list";
      const args = kind === "post" ? { title: "First" } : { storyId, title: "Transcript", content: "First line" };
      const first = await claimExport(preparedExport(kind));
      const sent = await writeStep(c, first, "content", tool, args);
      const done = await finishExport(first, sent);
      const op = await claimExport(preparedExport(kind, 2));
      provider.failNext({ tool: readTool, mode, status, code: status });
      const writesBefore = provider.calls.filter(call => clientModule.WRITE_TOOLS.includes(call.name)).length;
      const state = errorCode === "remote_conflict" ? "conflict" : "failed";
      expect(await writeStep(c, op, "content", tool, { ...args, title: "Updated" }, first.operationId))
        .toEqual({ state, errorCode });
      expect(provider.calls.filter(call => clientModule.WRITE_TOOLS.includes(call.name))).toHaveLength(writesBefore);
      expect(await readOperation(op)).toMatchObject({ state, steps: {}, errorCode });
      expect((await db.collection(operationsModule.MAPPINGS).doc(done.mappingId).get()).data())
        .toMatchObject({ externalId: sent.remoteIdentity, lastOperationId: first.operationId, pendingOperationId: null });
      await expect(operationStore().advance({ ...op, event: "retry" })).rejects.toMatchObject({ code: "invalid_transition" });
    });
  it.each(["post", "transcript"].flatMap(kind => ["http", "drop-before", "malformed-after"].map(mode => [kind, mode])))(
    "retries a failed %s pre-write revision read (%s) without reconciliation", async (kind, mode) => {
      const provider = storydeskProvider(); const c = client(provider.fetch);
      const tool = kind === "post" ? "stories_create" : "sections_create";
      const readTool = kind === "post" ? "stories_get" : "sections_list";
      const args = kind === "post" ? { title: "First" } : { storyId, title: "Transcript", content: "First line" };
      const first = await claimExport(preparedExport(kind));
      const sent = await writeStep(c, first, "content", tool, args);
      const done = await finishExport(first, sent);
      const p = preparedExport(kind, 2); const op = await claimExport(p);
      provider.failNext({ tool: readTool, mode, status: 503 });
      const writesBefore = provider.calls.filter(call => clientModule.WRITE_TOOLS.includes(call.name)).length;
      expect(await writeStep(c, op, "content", tool, { ...args, title: "Updated" }, first.operationId))
        .toEqual({ state: "failed", errorCode: "transient_failure" });
      expect(provider.calls.filter(call => clientModule.WRITE_TOOLS.includes(call.name))).toHaveLength(writesBefore);
      expect(await readOperation(op)).toMatchObject({ state: "failed", lastEvent: "confirmed_failure", steps: {}, errorCode: "transient_failure" });
      expect((await db.collection(operationsModule.MAPPINGS).doc(done.mappingId).get()).data())
        .toMatchObject({ lastOperationId: first.operationId, pendingOperationId: op.operationId });
      await operationStore().advance({ ...op, event: "retry" });
      const retried = (await operationStore().claim(op.operationId, p)).operation;
      expect(await writeStep(client(provider.fetch), retried, "content", tool, { ...args, title: "Updated" }, first.operationId))
        .toMatchObject({ state: "complete", remoteIdentity: sent.remoteIdentity });
      expect(provider.calls.filter(call => clientModule.WRITE_TOOLS.includes(call.name))).toHaveLength(writesBefore + 1);
    });
  it("allows two named asset steps in one operation and reuses each completed step", async () => {
    const provider = storydeskProvider(); const c = client(provider.fetch);
    const op = await claimExport(preparedExport("image"));
    const first = await writeStep(c, op, "first-asset", "assets_import_from_url", writes[2][1]);
    const second = await writeStep(c, op, "second-asset", "assets_import_from_url", { ...writes[2][1], filename: "second.mp4" });
    expect(second).toMatchObject({ state: "complete" });
    expect(second.remoteIdentity).not.toBe(first.remoteIdentity);
    expect(await writeStep(c, op, "first-asset", "assets_import_from_url", writes[2][1]))
      .toMatchObject({ state: "complete", remoteIdentity: first.remoteIdentity, recovered: true });
    expect(await writeStep(c, op, "second-asset", "assets_import_from_url", { ...writes[2][1], filename: "second.mp4" }))
      .toMatchObject({ state: "complete", remoteIdentity: second.remoteIdentity, recovered: true });
    expect(provider.objects.assets).toHaveLength(2);
    expect(provider.calls.filter(call => call.name === "assets_import_from_url")).toHaveLength(2);
  });
  it.each(["drop-after", "drop-before"])("recovers an unknown update only from exact read-back fields (%s)", async mode => {
    const provider = storydeskProvider(); const c = client(provider.fetch);
    const first = await claimExport(); const sent = await writeStep(c, first, "story", "stories_create", writes[0][1]);
    await finishExport(first, sent);
    const second = await claimExport(preparedExport("post", 2));
    provider.failNext({ tool: "stories_update", mode });
    const args = { title: "Second", description: "Changed draft" };
    const result = await writeStep(c, second, "story", "stories_create", args, first.operationId);
    expect(result.state).toBe(mode === "drop-after" ? "complete" : "reconciliation");
    expect(provider.objects.stories).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === "stories_update")).toHaveLength(1);
    if (mode === "drop-before") {
      expect(await writeStep(client(provider.fetch), second, "story", "stories_create", args, first.operationId)).toMatchObject({ state: "reconciliation" });
      expect(provider.calls.filter(call => call.name === "stories_update")).toHaveLength(1);
    }
  });
  it("persists a successful create ID before a failed revision read and reuses it after restart", async () => {
    const provider = storydeskProvider(); const op = await claimExport();
    provider.failNext({ tool: "stories_get", mode: "http", status: 503 });
    expect(await writeStep(client(provider.fetch), op, "story", "stories_create", writes[0][1])).toMatchObject({ state: "reconciliation" });
    expect((await readOperation(op)).steps.story).toMatchObject({ outcome: "complete", remoteIdentity: provider.objects.stories[0].id, remoteChangeMarker: null });
    expect(await writeStep(client(provider.fetch), op, "story", "stories_create", writes[0][1])).toMatchObject({ state: "complete", recovered: true });
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === "stories_list")).toHaveLength(0);
  });
  it("retains the confirmed revision when a concurrent recovery finishes later", async () => {
    const provider = storydeskProvider(); const op = await claimExport();
    let created, lookupStarted, firstFinished;
    const createdWait = new Promise(resolve => { created = resolve; });
    const lookupWait = new Promise(resolve => { lookupStarted = resolve; });
    const finishWait = new Promise(resolve => { firstFinished = resolve; });
    const fetch = async (url, init) => {
      const tool = JSON.parse(init.body).params.name;
      if (tool === "stories_create") {
        const response = await provider.fetch(url, init);
        created(); await lookupWait; return response;
      }
      if (tool === "stories_list") { lookupStarted(); await finishWait; }
      return provider.fetch(url, init);
    };
    const first = writeStep(client(fetch), op, "story", "stories_create", writes[0][1]);
    await createdWait;
    const second = writeStep(client(fetch), op, "story", "stories_create", writes[0][1]);
    const sent = await first;
    firstFinished();
    expect(await second).toMatchObject({ state: "complete", remoteIdentity: sent.remoteIdentity, remoteChangeMarker: sent.remoteChangeMarker });
    expect((await readOperation(op)).steps.story.remoteChangeMarker).toBe(sent.remoteChangeMarker);
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(1);
  });
  it("retains a nullable baseline when the asset list is unavailable", async () => {
    const provider = storydeskProvider(); const op = await claimExport(preparedExport("image"));
    provider.failNext({ tool: "assets_list_for_story", mode: "http", status: 503 });
    expect(await writeStep(client(provider.fetch), op, "asset", "assets_import_from_url", writes[2][1])).toMatchObject({ state: "complete" });
    expect((await readOperation(op)).steps.asset.preImportAssetIds).toBeNull();
    expect(provider.calls.filter(call => call.name === "assets_import_from_url")).toHaveLength(1);
  });
});
