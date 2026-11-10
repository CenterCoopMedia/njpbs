import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { observeWithdrawalCatalog, mergeWithdrawalCatalog } from "./withdrawal-catalog";
import { mergePageWithdrawalCatalog } from "./page-withdrawal-catalog";
import { mergeRecordWithdrawalCatalog } from "./record-withdrawal-catalog";
import background from "../functions/lib/post-background-outputs.js";
import context from "../functions/lib/public-context-revision.js";
import { publicationTarget } from "../functions/lib/publication-target.js";

const target = publicationTarget(), sha = "a".repeat(40), operationId = "A".repeat(20);
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = JSON.stringify({ type: "service_account", project_id: target.projectId,
  client_email: `local-test@${target.projectId}.iam.gserviceaccount.com`,
  private_key: privateKey.export({ format: "pem", type: "pkcs8" }) });
const prefix = `projects/${target.projectId}/databases/(default)/documents/`;
const ownerPath = "system/publicDeployment/noBuildPostOwners";
const owner = { schemaVersion: 1, postId: "test-post", operationId, sourceVersion: 7,
  generation: 3, visible: false, ownedSlugs: ["test-story"] };
function wire(value: any): any {
  if (value === null) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(wire) } };
  if (typeof value === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)])) } };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  return { stringValue: value };
}
const document = (path: string, value: any) => ({ name: `${prefix}${path}`, fields: wire(value).mapValue.fields });

it.each(["development", "production"])("pins the current Page and retained withdrawal queue in one masked %s observation", async environment => {
  const dev = publicationTarget(environment), devPrefix = `projects/${dev.projectId}/databases/(default)/documents/`;
  const marker = { schemaVersion: 1, pageId: "contact", operationId, sourceVersion: 7, revision: 3,
    ownedPaths: ["/contact/", "/former/"], snapshotDigest: "c".repeat(64), contextRevision: 3 };
  const currentId = "B".repeat(20);
  const page = { schemaVersion: 1, pageId: "contact", operationId: currentId, sourceVersion: 8,
    generation: 4, ownedPaths: marker.ownedPaths, visible: true, durableWithdrawal: marker };
  const data = new Map<string, any>([
    ["system/publicDeployment/contexts/public", { schemaVersion: 1, revision: 4 }],
    ["system/publicDeployment", { state: "deploying", activeCommitSha: sha }],
    ["system/cmsPublicationRuntime", { schemaVersion: 1, phase: "paused", commitSha: sha, serializerId: dev.serializerId }],
    [`cmsPublishQueue/${operationId}`, { transport: "page-no-build-v1", status: "cancelled",
      noBuildPage: { ...marker, generation: 3, visible: false } }],
    [`cmsPublishQueue/${currentId}`, { transport: "page-no-build-v1", status: "pending" }],
    ["cmsPages/contact", { publiclyVisible: true, published: { sourceVersion: 8 } }],
  ]);
  const calls: { url: URL; body: any }[] = [];
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "synthetic-page-token", token_type: "Bearer" });
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.pathname.endsWith(":beginTransaction")) return Response.json({ transaction: "cGFnZQ==" });
    if (url.pathname.endsWith(":rollback")) return Response.json({});
    if (url.pathname.endsWith(":batchGet")) return Response.json(body.documents.map((name: string) => {
      const value = data.get(name.slice(devPrefix.length));
      return value ? { found: { name, fields: wire(value).mapValue.fields } } : { missing: name };
    }));
    if (url.pathname.endsWith("/system/publicDeployment/noBuildPageOwners")) return Response.json({
      documents: [{ name: `${devPrefix}system/publicDeployment/noBuildPageOwners/contact`, fields: wire(page).mapValue.fields },
        { name: `${devPrefix}system/publicDeployment/noBuildPageOwners/about`, fields: wire({ ...page,
          pageId: "about", durableWithdrawal: null, operationId: "C".repeat(20) }).mapValue.fields }] });
    throw new Error("Unexpected Page catalog request");
  });
  const devAccount = JSON.stringify({ ...JSON.parse(account), project_id: dev.projectId,
    client_email: `local-test@${dev.projectId}.iam.gserviceaccount.com` });
  const observed = await observeWithdrawalCatalog({ target: dev, account: devAccount, commitSha: sha, family: "page" }, request);
  expect((await mergePageWithdrawalCatalog(null, observed, dev.workerName)).withdrawals).toMatchObject([
    { pageId: "contact", operationId, revision: 3 }]);
  const reads = calls.filter(call => call.url.pathname.endsWith(":batchGet"));
  expect(reads.some(call => call.body.documents.includes(`${devPrefix}cmsPublishQueue/${operationId}`))).toBe(true);
  expect(reads.some(call => call.body.documents.includes(`${devPrefix}cmsPublishQueue/${currentId}`))).toBe(true);
  for (const call of reads) {
    expect(call.body.transaction).toBe("cGFnZQ==");
    expect(call.body.mask.fieldPaths).not.toContain("draft");
    expect(call.body.mask.fieldPaths).not.toContain("claim");
  }
  expect(reads.some(call => call.body.documents.includes(`${devPrefix}cmsPages/about`) ||
    call.body.documents.includes(`${devPrefix}cmsPublishQueue/${"C".repeat(20)}`))).toBe(false);
  expect(calls.at(-1)!.url.pathname.endsWith(":rollback")).toBe(true);
});
function fixture(failure = false, largeStatic = false, visibleCount = 0) {
  const calls: { url: URL; body: any; method: string }[] = [];
  const data = new Map<string, any>([
    ["system/publicDeployment/contexts/public", { schemaVersion: 1, revision: 3 }],
    ["system/publicDeployment", { state: "idle", activeCommitSha: sha }],
    ["system/cmsPublicationRuntime", { schemaVersion: 1, phase: "paused", commitSha: "c".repeat(40),
      serializerId: "node-compute-publisher", cloud: { phase: "paused", commitSha: sha, serializerId: target.serializerId } }],
    [`cmsPublishQueue/${operationId}`, { transport: "post-no-build-v1", status: "success", noBuildPost: owner,
      publicReceipt: { operationId, sourceVersion: 7, visible: false, htmlDigest: null, admissionRevision: 1,
        rendererSha: sha, contextDigest: "b".repeat(64) }, postProof: { status: "verified" } }],
    ["cmsPosts/test-post", { version: 7, publiclyVisible: false, published: { sourceVersion: 7, metadata: { slug: "test-story" } } }],
  ]);
  const staticOwners = largeStatic ? [1, 2].map(index => ({ ...owner, postId: `static-${index}`,
    operationId: String(index).repeat(20), mode: "static", visible: true, ownedSlugs: [`static-story-${index}`] })) : [];
  for (const staticOwner of staticOwners) data.set(`cmsPosts/${staticOwner.postId}`, { version: 7,
    publiclyVisible: true, published: { sourceVersion: 7, publishedAt: "2026-10-12T12:00:00Z",
      metadata: { type: "post", slug: staticOwner.ownedSlugs[0] }, blocks: [
        { type: "prose", data: { html: '"'.repeat(600_000) } } ] } });
  const visibleOwners = Array.from({ length: visibleCount }, (_, i) => ({ ...owner,
    postId: `visible-${i}`, operationId: `V${String(i).padStart(19, "0")}`,
    mode: "static", visible: true, rendererSha: sha, staticProof: { visible: true }, ownedSlugs: [`visible-${i}`] }));
  for (const item of visibleOwners) data.set(`cmsPosts/${item.postId}`, {
    publiclyVisible: true, published: { sourceVersion: 7, metadata: { slug: item.ownedSlugs[0] }, blocks: [] } });
  const metrics = { documentReads: 0 };
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "synthetic-test-token", token_type: "Bearer" });
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, method: init?.method ?? "GET" });
    if (url.pathname.endsWith(":beginTransaction")) return Response.json({ transaction: "dGVzdA==" });
    if (url.pathname.endsWith(":rollback")) return new Response("{}");
    if (url.pathname.endsWith(":batchGet")) { metrics.documentReads += body.documents.length; return Response.json(body.documents.slice().reverse().map((name: string) => {
      const path = name.slice(prefix.length);
      return data.has(path) ? { found: document(path, data.get(path)), readTime: "2026-10-12T12:00:00Z" }
        : { missing: name, readTime: "2026-10-12T12:00:00Z" };
    })); }
    if (url.pathname.endsWith(`/${ownerPath}`)) {
      if (failure) return new Response(null, { status: 503 });
      if (!url.searchParams.has("pageToken")) metrics.documentReads += 1 + staticOwners.length + visibleOwners.length;
      return Response.json(url.searchParams.has("pageToken") ? {} : {
        documents: [owner, ...staticOwners, ...visibleOwners].map(value => document(`${ownerPath}/${value.postId}`, value)), nextPageToken: "page-two" });
    }
    throw new Error("Unexpected test request");
  });
  return { request, calls, metrics, data, visibleOwners };
}

it("reads a masked, paginated, paused catalog in one read-only transaction and rolls it back", async () => {
  const { request, calls } = fixture();
  const observed = await observeWithdrawalCatalog({ target, account, commitSha: sha }, request);
  expect((await mergeWithdrawalCatalog(null, observed, target.workerName)).withdrawals).toMatchObject([
    { postId: owner.postId, operationId, sourceVersion: 7, ownedSlugs: ["test-story"] }]);
  expect(calls[0].body).toEqual({ options: { readOnly: {} } });
  const reads = calls.filter(call => call.url.pathname.endsWith(":batchGet"));
  expect(reads).toHaveLength(3);
  for (const { body } of reads) {
    expect(body.transaction).toBe("dGVzdA==");
    expect(body.mask.fieldPaths.length).toBeGreaterThan(0);
    expect(body.mask.fieldPaths).not.toContain("working");
    expect(body.mask.fieldPaths).not.toContain("draft");
    expect(body.mask.fieldPaths).not.toContain("claim");
  }
  const postRead = reads.find(call => call.body.documents.some((name: string) => name.includes("/cmsPosts/")))!;
  expect(postRead.body.mask.fieldPaths).not.toContain("published");
  const pages = calls.filter(call => call.method === "GET");
  expect(pages).toHaveLength(2);
  expect(pages[1].url.searchParams.get("pageToken")).toBe("page-two");
  for (const { url } of pages) {
    expect(url.searchParams.get("transaction")).toBe("dGVzdA==");
    expect(url.searchParams.getAll("mask.fieldPaths")).not.toContain("staticProof.files");
  }
  expect(calls.at(-1)!.url.pathname.endsWith(":rollback")).toBe(true);
  expect(calls.at(-1)!.body).toEqual({ transaction: "dGVzdA==" });
  expect(calls.some(call => /:(commit|batchWrite)$/.test(call.url.pathname))).toBe(false);
});

it("refuses a failed owner page without a partial catalog and still releases the transaction", async () => {
  const { request, calls } = fixture(true);
  await expect(observeWithdrawalCatalog({ target, account, commitSha: sha }, request)).rejects.toThrow();
  expect(calls.at(-1)!.url.pathname.endsWith(":rollback")).toBe(true);
  expect(calls.filter(call => call.url.pathname.endsWith(":batchGet"))).toHaveLength(1);
});

it("reads large static snapshots individually without blocking an unrelated native withdrawal", async () => {
  const { request, calls } = fixture(false, true);
  const observed = await observeWithdrawalCatalog({ target, account, commitSha: sha }, request);
  expect(observed.posts.get("static-1")!.published.blocks[0].data.html).toHaveLength(600_000);
  expect(observed.posts.get("static-2")!.published.blocks[0].data.html).toHaveLength(600_000);
  expect((await mergeWithdrawalCatalog(null, observed, target.workerName)).withdrawals).toMatchObject([
    { postId: owner.postId, operationId, sourceVersion: 7, ownedSlugs: ["test-story"] }]);
  const snapshots = calls.filter(call => call.body?.mask?.fieldPaths.includes("published"));
  expect(snapshots).toHaveLength(2);
  expect(snapshots.every(call => call.body.documents.length === 1)).toBe(true);
});


it("polls fresh owner metadata without hydrating 20 visible static Posts", async () => {
  const { request, calls, metrics } = fixture(false, false, 20);
  const observed = await observeWithdrawalCatalog({ target, account, commitSha: sha }, request);
  expect((await mergeWithdrawalCatalog(null, observed, target.workerName)).withdrawals).toMatchObject([
    { postId: owner.postId, operationId, sourceVersion: 7 }]);
  const visibleReads = calls.filter(call => call.body?.documents?.some((name: string) => /visible-|cmsPublishQueue\/V/.test(name)));
  expect(visibleReads).toHaveLength(0);
  expect(metrics.documentReads).toBe(27); // Four controls, 21 owners, one withdrawal queue and one Post.
  expect(calls).toHaveLength(7); // Transaction, controls, two owner pages, queue, Post, rollback.
});


it("still rejects a malformed visible owner identity before skipping its proof", async () => {
  const { request } = fixture(false, false, 1);
  const invalid: typeof fetch = async (url, init) => {
    const response = await request(url, init);
    if (!new URL(String(url)).pathname.endsWith(`/${ownerPath}`) || new URL(String(url)).searchParams.has("pageToken")) return response;
    const page = await response.json();
    page.documents[1].fields.operationId = { stringValue: "invalid" };
    return Response.json(page);
  };
  await expect(observeWithdrawalCatalog({ target, account, commitSha: sha }, invalid)).rejects.toThrow();
});


it("hydrates a withdrawn static proof when the retained owner still says visible", async () => {
  const { request, data, visibleOwners } = fixture(false, false, 1);
  const retained = visibleOwners[0];
  const post = { version: 8, publiclyVisible: false, published: { sourceVersion: 8,
    publishedAt: "2026-10-12T12:00:00.000Z", blocks: [], metadata: { type: "post", slug: "visible-0" } } };
  data.set("cmsPosts/visible-0", post);
  Object.assign(retained, { staticProof: { schemaVersion: 1, postId: retained.postId, operationId: retained.operationId,
    sourceVersion: 8, visible: false, slug: "visible-0", ownedSlugs: retained.ownedSlugs,
    snapshotDigest: background.dependency(post).digest, contextDigest: context.publicContextDigest(3) } });
  expect(retained.visible).toBe(true); // Static return activation preserves this older flag.
  const observed = await observeWithdrawalCatalog({ target, account, commitSha: sha }, request);
  expect(observed.posts.get(retained.postId)?.publiclyVisible).toBe(false);
  const merged = await mergeWithdrawalCatalog(null, observed, target.workerName);
  expect(merged.withdrawals).toEqual(expect.arrayContaining([
    expect.objectContaining({ postId: retained.postId, sourceVersion: 8 }),
    expect.objectContaining({ postId: owner.postId, sourceVersion: 7 }),
  ]));
});


it("pins the registered record namespace and its retained withdrawal operation in one observation", async () => {
  const recordId = "program-one", currentId = "B".repeat(20);
  const marker = { schemaVersion: 1, recordId, family: "programs", operationId, sourceVersion: 7, revision: 3,
    ownedPaths: ["/programs/example/", "/shows/example/"], snapshotDigest: "c".repeat(64), contextRevision: 3 };
  const owner = { schemaVersion: 1, documentId: recordId, family: "programs", operationId: currentId, sourceVersion: 8,
    generation: 4, visible: true, ownedPaths: marker.ownedPaths, durableWithdrawal: marker };
  const data = new Map<string, any>([
    ["system/publicDeployment/contexts/public", { schemaVersion: 1, revision: 4 }],
    ["system/publicDeployment", { state: "idle", activeCommitSha: sha }],
    ["system/cmsPublicationRuntime", { schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: target.serializerId }],
    ["system/publicDeployment/noBuildRecordFamilies/current", { schemaVersion: 1, families: ["programs"] }],
    [`cmsPublishQueue/${operationId}`, { transport: "public-context-no-build-v1", status: "cancelled", recordPublication: {
      ...marker, documentId: recordId, generation: 3, visible: false } }],
    [`cmsPublishQueue/${currentId}`, { transport: "public-context-no-build-v1", status: "pending" }],
    [`cmsPosts/${recordId}`, { publiclyVisible: true, published: { sourceVersion: 8 } }],
  ]);
  const reads: any[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "synthetic-record-token", token_type: "Bearer" });
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname.endsWith(":beginTransaction")) return Response.json({ transaction: "cmVjb3Jk" });
    if (url.pathname.endsWith(":rollback")) return Response.json({});
    if (url.pathname.endsWith(":batchGet")) {
      reads.push(body);
      return Response.json(body.documents.map((name: string) => data.has(name.slice(prefix.length))
        ? { found: { name, fields: wire(data.get(name.slice(prefix.length))).mapValue.fields } } : { missing: name }));
    }
    if (url.pathname.endsWith("/system/publicDeployment/noBuildRecordOwners")) {
      expect(url.searchParams.get("transaction")).toBe("cmVjb3Jk");
      expect(url.searchParams.getAll("mask.fieldPaths")).toContain("durableWithdrawal.family");
      return Response.json({ documents: [document(`system/publicDeployment/noBuildRecordOwners/${recordId}`, owner)] });
    }
    throw new Error("Unexpected record catalog request");
  };
  const observed = await observeWithdrawalCatalog({ target, account, commitSha: sha, family: "record" }, request);
  expect(observed.recordFamilies).toEqual(["programs"]);
  expect((await mergeRecordWithdrawalCatalog(null, observed, target.workerName)).withdrawals).toMatchObject([
    { recordId, family: "programs", operationId, revision: 3 }]);
  expect(reads.some(body => body.documents.includes(`${prefix}system/publicDeployment/noBuildRecordFamilies/current`))).toBe(true);
  expect(reads.some(body => body.documents.includes(`${prefix}cmsPublishQueue/${operationId}`) && body.documents.includes(`${prefix}cmsPublishQueue/${currentId}`))).toBe(true);
  for (const read of reads) { expect(read.transaction).toBe("cmVjb3Jk"); expect(read.mask.fieldPaths).not.toContain("draft"); }
});
