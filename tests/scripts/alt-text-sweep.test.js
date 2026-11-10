import { describe, expect, it, vi } from "vitest";
import { claudeModel, createCmsClient, downloadImage, findImageUses, parseModelReply, runSweep } from "../../scripts/alt-text-sweep.mjs";

const asset = (id, altText = "") => ({ id, name: id, kind: "image", lifecycle: "active", altText,
  description: "", url: `https://images.example/${id}`, etag: `etag-${id}`, mimeType: "image/jpeg" });
const document = (overrides = {}) => ({ version: 2, status: "draft", type: "post", title: "A story", heroImage: "a", heroImageAlt: "",
  blocks: [{ type: "image", visible: true, data: { assetId: "b", alt: "" } }], ...overrides });
const reply = { alt: "A studio camera beside a window", description: "A camera in a room.", people: false };

function harness({ media = [asset("a", "Authored alt"), asset("b", "Authored alt")], doc = document(),
  mediaConflict = false, saveConflict = false, model = vi.fn(async () => reply), pages = [],
  mediaPageSize = media.length, postIds = ["post-1"], postPageSize = postIds.length, documents = {} } = {}) {
  const endpoints = [];
  const fetchImpl = vi.fn(async (url, options = {}) => {
    if (url.startsWith("https://identitytoolkit.googleapis.com/"))
      return Response.json({ idToken: "token", refreshToken: "refresh", expiresIn: "3600" });
    if (url.startsWith("https://images.example/"))
      return new Response("image bytes", { headers: { "content-type": "image/jpeg" } });
    const endpoint = new URL(url).pathname.slice(1);
    endpoints.push(endpoint);
    const body = JSON.parse(options.body);
    if (endpoint === "cmsListMedia") return Response.json({ records: body.assetIds
      ? media.filter(row => body.assetIds.includes(row.id))
      : media.slice((body.page - 1) * mediaPageSize, body.page * mediaPageSize),
      pageCount: body.assetIds ? 1 : Math.ceil(media.length / mediaPageSize) });
    if (endpoint === "cmsUpdateMediaMetadata") return mediaConflict
      ? Response.json({}, { status: 412 }) : Response.json({ success: true });
    if (endpoint === "cmsListContent") return Response.json(body.view === "pages"
      ? { pages } : { records: doc ? postIds.slice((Number(new URLSearchParams(body.query).get("page")) - 1) * postPageSize,
        Number(new URLSearchParams(body.query).get("page")) * postPageSize).map(id => ({ id, title: "A story" })) : [],
        pageCount: doc ? Math.ceil(postIds.length / postPageSize) : 1 });
    if (endpoint === "cmsGetContent") {
      const selected = documents[body.id] ?? doc;
      return Response.json({ found: Boolean(selected), document: structuredClone(selected) });
    }
    if (endpoint === "cmsSaveContent") return saveConflict
      ? Response.json({}, { status: 409 }) : Response.json({ success: true });
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  const call = createCmsClient({ fetchImpl, credential: { email: "agent@example.com", password: "private" },
    apiKey: "public-key", baseUrl: "https://cms.example" });
  return { call, fetchImpl, endpoints, model };
}

describe("alt-text sweep", () => {
  it("reports dry-run changes without writing and calls only the five allowed CMS endpoints", async () => {
    const h = harness({ media: [asset("a"), asset("b", "Authored alt")] });
    const report = await runSweep({ call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.mode).toBe("dry_run");
    expect(report.changes.map(change => change.fieldPath)).toEqual(["altText", "description", "heroImageAlt", "blocks[0].data.alt"]);
    expect(h.endpoints).not.toContain("cmsUpdateMediaMetadata");
    expect(h.endpoints).not.toContain("cmsSaveContent");
    expect(new Set(h.endpoints)).toEqual(new Set(["cmsListMedia", "cmsListContent", "cmsGetContent"]));
    expect(h.endpoints.every(endpoint => ["cmsListMedia", "cmsUpdateMediaMetadata", "cmsListContent", "cmsGetContent", "cmsSaveContent"].includes(endpoint))).toBe(true);
    await expect(h.call("cmsPublish", {})).rejects.toThrow("endpoint_not_allowed");
    expect(h.endpoints).not.toContain("cmsPublish");
  });

  it("leaves authored and decorative alt unchanged and makes one versioned save", async () => {
    const doc = document({ heroImageAlt: "Written by staff", blocks: [
      { type: "image", data: { assetId: "a", alt: "", altDecorative: true } },
      { type: "image_gallery", data: { images: [{ assetId: "b", alt: "" }, { assetId: "a", alt: "Authored" }] } },
    ] });
    const h = harness({ doc });
    const report = await runSweep({ apply: true, call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0].fieldPath).toBe("blocks[1].data.images[0].alt");
    const saves = h.fetchImpl.mock.calls.filter(([url]) => url.endsWith("/cmsSaveContent"));
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0][1].body)).toMatchObject({ baseVersion: 2,
      document: { blocks: [
        { data: { alt: "", altDecorative: true } },
        { data: { images: [{ alt: reply.alt }, { alt: "Authored" }] } },
      ] } });
    expect(JSON.parse(saves[0][1].body).document).not.toHaveProperty("status");
    expect(JSON.parse(saves[0][1].body).document).not.toHaveProperty("heroImageAlt");
    expect(h.endpoints.every(endpoint => ["cmsListMedia", "cmsUpdateMediaMetadata", "cmsListContent", "cmsGetContent", "cmsSaveContent"].includes(endpoint))).toBe(true);
  });

  it("saves a published post as a draft revision and never publishes it", async () => {
    const h = harness({ doc: document({ status: "published" }) });
    const report = await runSweep({ apply: true, call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    const saves = h.fetchImpl.mock.calls.filter(([url]) => url.endsWith("/cmsSaveContent"));
    expect(saves).toHaveLength(1);
    const body = JSON.parse(saves[0][1].body);
    expect(body.document).toMatchObject({ heroImageAlt: reply.alt });
    expect(body.document).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("publish");
    expect(body).not.toHaveProperty("scheduleAt");
    expect(report.changes.some(change => change.fieldPath === "heroImageAlt")).toBe(true);
  });

  it.each([
    null,
    { kind: "image", data: { assetId: "new-image", alt: "The selected image" } },
    { kind: "library-video", data: { sourceId: "video-library", assetId: "video", title: "Selected video" } },
    { kind: "linked-video", data: { url: "https://example.org/video", title: "Selected video" } },
    { kind: "embed", data: { url: "https://youtu.be/abcdefghijk", title: "Selected video" } },
    { kind: "unsupported" },
  ])("does not spend a model call or create a draft for an inactive legacy lead (%j)", async leadMedia => {
    const h = harness({ media: [asset("a", "Authored library alt")],
      doc: document({ status: "published", leadMedia, blocks: [] }) });
    const report = await runSweep({ apply: true, call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.documentsScanned).toBe(1);
    expect(report.modelCalls).toBe(0);
    expect(h.model).not.toHaveBeenCalled();
    expect(report.changes).toEqual([]);
    expect(h.endpoints).not.toContain("cmsSaveContent");
  });

  it.each(["draft", "published"])("fills the active %s lead image through a versioned leadMedia overlay", async status => {
    const leadMedia = { kind: "image", data: { assetId: "b", alt: "", caption: "Selected photo credit" } };
    const h = harness({ doc: document({ status, leadMedia, blocks: [] }) });
    const report = await runSweep({ apply: true, call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.modelCalls).toBe(1);
    expect(report.changes.map(change => change.fieldPath)).toEqual(["leadMedia.data.alt"]);
    expect(h.model).toHaveBeenCalledWith(expect.objectContaining({ context: "Selected photo credit" }));
    const saves = h.fetchImpl.mock.calls.filter(([url]) => url.endsWith("/cmsSaveContent"));
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0][1].body)).toEqual({ collection: "cmsPosts", id: "post-1", baseVersion: 2,
      document: { leadMedia: { ...leadMedia, data: { ...leadMedia.data, alt: reply.alt } } } });
    expect(h.endpoints).not.toContain("cmsPublish");
  });

  it("reports active lead alt in dry run without saving", async () => {
    const h = harness({ doc: document({ leadMedia: { kind: "image", data: { assetId: "b", alt: "" } }, blocks: [] }) });
    const report = await runSweep({ call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.changes.map(change => change.fieldPath)).toEqual(["leadMedia.data.alt"]);
    expect(h.endpoints).not.toContain("cmsSaveContent");
  });

  it.each([
    { kind: "image", data: { assetId: "b", alt: "Staff wrote this" } },
    { kind: "image", data: { assetId: "b", alt: "", altDecorative: true } },
    { kind: "image", data: { assetId: "../bad", alt: "" } },
    { kind: "embed", data: { url: "https://youtu.be/abcdefghijk", title: "Video" }, posterAssetId: "b" },
  ])("leaves authored, decorative, invalid and video-poster lead fields alone (%j)", async leadMedia => {
    const h = harness({ doc: document({ leadMedia, blocks: [] }) });
    const report = await runSweep({ apply: true, call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.modelCalls).toBe(0); expect(h.endpoints).not.toContain("cmsSaveContent");
  });

  it("does not alter an active image lead after scheduling", async () => {
    const h = harness({ doc: document({ status: "scheduled", leadMedia: { kind: "image", data: { assetId: "b", alt: "" } }, blocks: [] }) });
    const report = await runSweep({ apply: true, call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.modelCalls).toBe(0); expect(h.endpoints).not.toContain("cmsSaveContent");
    expect(report.skipped).toContainEqual(expect.objectContaining({ reason: "reviewed_or_scheduled_status" }));
  });

  it("still fills a body image while ignoring a cleared legacy lead", async () => {
    const h = harness({ doc: document({ status: "published", leadMedia: null }) });
    const report = await runSweep({ apply: true, call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.modelCalls).toBe(1);
    expect(report.changes.map(change => change.fieldPath)).toEqual(["blocks[0].data.alt"]);
    const saves = h.fetchImpl.mock.calls.filter(([url]) => url.endsWith("/cmsSaveContent"));
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0][1].body).document).toEqual({ blocks: [
      { type: "image", visible: true, data: { assetId: "b", alt: reply.alt } },
    ] });
  });

  it("skips an asset ETag conflict and a draft version conflict", async () => {
    const h = harness({ media: [asset("a"), asset("b", "Authored")], mediaConflict: true, saveConflict: true });
    const report = await runSweep({ apply: true, call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.skipped).toEqual([{ assetId: "a", reason: "etag_conflict" },
      { collection: "cmsPosts", id: "post-1", reason: "version_conflict" }]);
    expect(report.changes).toEqual([]);
    const update = h.fetchImpl.mock.calls.find(([url]) => url.endsWith("/cmsUpdateMediaMetadata"));
    expect(update[1].headers["If-Match"]).toBe("etag-a");
    expect(JSON.parse(update[1].body).metadata).toMatchObject({ altTextGenerated: true, altText: reply.alt });
  });

  it("stops at max calls and after three consecutive model errors", async () => {
    const media = [asset("a"), asset("b"), asset("c"), asset("d")];
    const limited = harness({ media, doc: null });
    const first = await runSweep({ maxCalls: 2, call: limited.call, fetchImpl: limited.fetchImpl, model: limited.model });
    expect(first.modelCalls).toBe(2);
    expect(first.stopped).toBe("max_calls");
    const failing = harness({ media, doc: null, model: vi.fn(async () => { throw new Error("model_failed"); }) });
    const second = await runSweep({ call: failing.call, fetchImpl: failing.fetchImpl, model: failing.model });
    expect(second.modelCalls).toBe(3);
    expect(second.stopped).toBe("three_consecutive_errors");
    expect(failing.endpoints).not.toContain("cmsListContent");
  });

  it("reads later media and post pages using a stable media sort", async () => {
    const h = harness({ media: [asset("a", "Authored"), asset("b", "Authored")],
      mediaPageSize: 1, postIds: ["post-1", "post-2"], postPageSize: 1 });
    const report = await runSweep({ call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.documentsScanned).toBe(2);
    expect(report.changes.filter(change => change.collection === "cmsPosts")).toHaveLength(4);
    const mediaRequests = h.fetchImpl.mock.calls.filter(([url]) => url.endsWith("/cmsListMedia"))
      .map(([, options]) => JSON.parse(options.body));
    expect(mediaRequests).toEqual([
      { kinds: ["image"], sort: "createdAt", direction: "asc", page: 1 },
      { kinds: ["image"], sort: "createdAt", direction: "asc", page: 2 },
    ]);
    expect(h.endpoints.filter(endpoint => endpoint === "cmsListContent")).toHaveLength(3);
  });

  it("skips reviewed content before a model call and skips an oversized original", async () => {
    const oversized = { ...asset("a"), sizeBytes: 21 * 1024 * 1024 };
    const h = harness({ media: [oversized], doc: document({ status: "approved" }) });
    const report = await runSweep({ apply: true, call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.modelCalls).toBe(0);
    expect(report.skipped).toEqual([
      { assetId: "a", reason: "image_too_large" },
      { collection: "cmsPosts", id: "post-1", reason: "reviewed_or_scheduled_status", status: "approved" },
    ]);
    expect(h.endpoints).not.toContain("cmsSaveContent");
    expect(h.endpoints).not.toContain("cmsUpdateMediaMetadata");
  });

  it("does not touch a library image marked decorative", async () => {
    const h = harness({ media: [{ ...asset("a"), decorative: true }], doc: null });
    const report = await runSweep({ apply: true, call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.modelCalls).toBe(0);
    expect(report.changes).toEqual([]);
    expect(h.endpoints).not.toContain("cmsUpdateMediaMetadata");
  });

  it("counts consecutive model errors across document boundaries", async () => {
    const h = harness({ media: [asset("a", "Authored")],
      doc: document({ blocks: [] }), postIds: ["post-1", "post-2", "post-3", "post-4"], postPageSize: 1,
      model: vi.fn(async () => { throw new Error("model_failed"); }) });
    const report = await runSweep({ call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.modelCalls).toBe(3);
    expect(report.errors).toHaveLength(3);
    expect(report.stopped).toBe("three_consecutive_errors");
    expect(report.documentsScanned).toBe(3);
  });

  it("does not reset consecutive model errors on skipped reviewed records", async () => {
    const h = harness({ media: [asset("a", "Authored")], doc: document({ blocks: [] }),
      postIds: ["draft-1", "live-1", "draft-2", "live-2", "draft-3", "draft-4"], postPageSize: 1,
      documents: { "live-1": document({ status: "in_review" }), "live-2": document({ status: "scheduled" }) },
      model: vi.fn(async () => { throw new Error("model_failed"); }) });
    const report = await runSweep({ call: h.call, fetchImpl: h.fetchImpl, model: h.model });
    expect(report.modelCalls).toBe(3);
    expect(report.stopped).toBe("three_consecutive_errors");
    expect(report.documentsScanned).toBe(5);
  });

  it("refreshes the ID token near expiry without logging or passing credentials to the CMS", async () => {
    let now = 0;
    const seen = [];
    const fetchImpl = vi.fn(async (url, options) => {
      seen.push({ url, options });
      if (url.includes("signInWithPassword")) return Response.json({ idToken: "first", refreshToken: "refresh", expiresIn: "120" });
      if (url.includes("securetoken")) return Response.json({ id_token: "second", refresh_token: "next", expires_in: "3600" });
      return Response.json({ success: true });
    });
    const call = createCmsClient({ fetchImpl, credential: { email: "agent@example.com", password: "private" },
      apiKey: "public-key", baseUrl: "https://cms.example", now: () => now });
    await call("cmsListMedia", { page: 1 });
    now = 61_000;
    await call("cmsListMedia", { page: 2 });
    expect(seen.filter(item => item.url.includes("securetoken"))).toHaveLength(1);
    expect(seen.filter(item => item.url.endsWith("/cmsListMedia")).map(item => item.options.headers.Authorization))
      .toEqual(["Bearer first", "Bearer second"]);
    expect(seen.filter(item => item.url.endsWith("/cmsListMedia")).every(item => !JSON.stringify(item.options.body).includes("private"))).toBe(true);
  });

  it("runs Claude with only Read in the image directory and sends context on stdin", async () => {
    let invocation;
    let prompt;
    const runCli = (binary, args, options, callback) => {
      invocation = { binary, args, options };
      return { stdin: { end(value) {
        prompt = value;
        callback(null, JSON.stringify({ result: JSON.stringify(reply) }));
      } } };
    };
    expect(await claudeModel({ imagePath: "/tmp/njpbs-alt-123/image.jpg", title: "A story", context: "Caption" }, runCli)).toEqual(reply);
    expect(invocation.binary).toBe("claude");
    expect(invocation.options.cwd).toBe("/tmp/njpbs-alt-123");
    expect(invocation.args.slice(1, 5)).toEqual(["--model", "claude-opus-5-5", "--effort", "medium"]);
    expect(invocation.args).toContain("--restricted");
    expect(invocation.args).toContain("--strict-mcp-config");
    expect(invocation.args).toContain("--no-session-persistence");
    expect(invocation.args.slice(invocation.args.indexOf("--tools"))).toEqual(["--tools", "Read", "--allowedTools", "Read"]);
    expect(invocation.args.join(" ")).not.toContain("A story");
    expect(prompt).toContain("Never name or guess the identity of a person");
  });

  it("rejects a download declared larger than 20 MB before writing it", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { headers: {
      "content-type": "image/jpeg", "content-length": String(20 * 1024 * 1024 + 1),
    } }));
    await expect(downloadImage(asset("a"), { fetchImpl })).rejects.toThrow("image_too_large");
  });

  it("matches visible, manual, and recommended fields and rejects malformed model text", () => {
    const uses = findImageUses("cmsPages", { homeHero: { mode: "manual", items: [
      { title: "First", href: "/first", imageAssetId: "a", alt: "" },
      { title: "Duplicate", href: "/first", imageAssetId: "b", alt: "" },
    ] }, blocks: [
      { type: "image", visible: false, data: { assetId: "a", alt: "" } },
      { type: "promotion_playlist", visible: true, data: { cards: [{ imageAssetId: "b", alt: "" }] } },
    ] });
    expect(uses.map(use => use.path)).toEqual(["homeHero.items[0].alt", "blocks[1].data.cards[0].alt"]);
    expect(() => parseModelReply({ alt: "", description: "", people: false })).toThrow();
    expect(() => parseModelReply({ alt: "x".repeat(126), description: "", people: false })).toThrow();
  });

  it("reads the final result event when the CLI prints its event list", () => {
    const answer = JSON.stringify({ alt: "Red studio backdrop", description: "A plain red backdrop.", people: false });
    const events = JSON.stringify([
      { type: "system" },
      { type: "assistant" },
      { type: "result", subtype: "success", is_error: false, result: answer },
    ]);
    expect(parseModelReply(events)).toEqual({ alt: "Red studio backdrop", description: "A plain red backdrop.", people: false });
    expect(() => parseModelReply(JSON.stringify([{ type: "result", is_error: true, result: answer }]))).toThrow("invalid_model_reply");
    expect(() => parseModelReply(JSON.stringify([{ type: "system" }]))).toThrow("invalid_model_reply");
  });

  it("retries a too-long alt once with the rule restated and records the failed rule", async () => {
    const long = { ...reply, alt: "x".repeat(126) };
    const retried = harness({ media: [asset("a")], doc: null,
      model: vi.fn().mockResolvedValueOnce(long).mockResolvedValueOnce(reply) });
    const fixed = await runSweep({ call: retried.call, fetchImpl: retried.fetchImpl, model: retried.model });
    expect(fixed.modelCalls).toBe(2);
    expect(fixed.errors).toEqual([]);
    expect(retried.model.mock.calls[1][0].retryNote).toContain("under 100 characters");

    const stillLong = harness({ media: [asset("a")], doc: null, model: vi.fn(async () => long) });
    const failed = await runSweep({ call: stillLong.call, fetchImpl: stillLong.fetchImpl, model: stillLong.model });
    expect(failed.modelCalls).toBe(2);
    expect(failed.errors).toEqual([{ target: "asset a", reason: "invalid_model_reply", detail: "alt_too_long" }]);
    expect(JSON.stringify(failed)).not.toContain("x".repeat(126));

    const capped = harness({ media: [asset("a")], doc: null, model: vi.fn(async () => long) });
    const once = await runSweep({ maxCalls: 1, call: capped.call, fetchImpl: capped.fetchImpl, model: capped.model });
    expect(once.modelCalls).toBe(1);

    const notJson = harness({ media: [asset("a")], doc: null, model: vi.fn(async () => "not json") });
    const noRetry = await runSweep({ call: notJson.call, fetchImpl: notJson.fetchImpl, model: notJson.model });
    expect(noRetry.modelCalls).toBe(1);
    expect(noRetry.errors[0]).toMatchObject({ reason: "invalid_model_reply", detail: "not_json" });
  });
});
