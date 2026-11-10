import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { boardwalkFixture, registry, newsdeskId, now } from "../helpers/cuez-boardwalk-fixture.js";
import { storydeskProvider } from "../helpers/cuez-storydesk-provider.js";
import flows from "../../functions/lib/cuez-transfer-export.js";
import clients from "../../functions/lib/cuez-transfer-storydesk.js";
import storageModule from "../../functions/lib/cuez-transfer-storage.js";

const db = isolatedFirestore("cuez-export");
let fixture, provider, flow, reads, intercept;
beforeEach(async () => {
  fixture = await boardwalkFixture(db);
  provider = storydeskProvider(); reads = []; intercept = null;
  const storage = storageModule.createTransferStorage({
    clientFor: () => ({ send: async command => {
      reads.push(command.input);
      if (command.constructor.name === "GetObjectCommand") return { VersionId: "text-v1", Body: Readable.from(["Reporter: One & two\n<Next>"]) };
      return { VersionId: command.input.VersionId, ContentLength: command.input.Key.includes("clips/") ? 100 : 500 };
    } }),
    sign: async (_client, command, options) => {
      expect(options.expiresIn).toBe(3600);
      reads.push(command.input);
      return "https://renditions.example.test/selected?signature=ephemeral";
    },
    fetchImpl: async () => new Response(null, { headers: { "content-length": "100" } }),
  });
  flow = flows.createExportFlow({ firestore: db, client: clients.createStorydeskClient({ apiKey: "test-key", newsdeskId,
    fetchImpl: (url, init) => intercept ? intercept(url, init) : provider.fetch(url, init) }),
    actorUid: "staff", newsdeskId, registry, renditionBucket: "test-renditions", publicMediaOrigin: "https://media.example.test", storage, now: () => now });
});
const send = async (kind, newStory) => {
  const queued = await flow.prepareExport(await fixture.request(kind, newStory));
  return flow.sendExport(queued.operation.operationId);
};

describe("export orchestration with the real operation store", () => {
  it.each(["video", "clip", "image", "transcript", "post"])("sends selected %s into one new story and deduplicates", async kind => {
    const result = await send(kind, true);
    expect(result.state).toBe("complete");
    expect(provider.objects.stories).toHaveLength(1);
    expect(result.remoteIdentity).toBe(provider.objects.stories[0].id);
    expect(await flow.sendExport(result.operationId)).toMatchObject({ state: "complete", attemptCount: 1 });
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(1);
    const mapping = (await db.collection("cuezMappings").doc(result.mappingId).get()).data();
    expect(mapping.externalId).toBe(result.remoteIdentity);
    expect(mapping.lastRemoteRevision).toBe(provider.objects.stories[0].updatedAt);
    if (kind === "transcript") expect(provider.objects.sections[0].content).toBe("<p>Reporter: One &amp; two</p>\n<p>&lt;Next&gt;</p>");
    expect(JSON.stringify(result)).not.toMatch(/signature=|Reporter:|https:/);
    expect(reads.every(input => input.Bucket !== "test-originals")).toBe(true);
  });
  it.each(["video", "clip", "image", "transcript"])("sends %s to the selected existing story without creating a story", async kind => {
    expect((await send(kind, false)).state).toBe("complete");
    expect(provider.objects.stories).toHaveLength(0);
    const object = kind === "transcript" ? provider.objects.sections[0] : provider.objects.assets[0];
    expect(object.storyId).toBe("selected-story");
  });
  it.each(["stories_create", "assets_import_from_url", "sections_create"])("retries after a known rejection of %s, retaining completed steps", async tool => {
    const kind = tool === "sections_create" ? "transcript" : "video";
    provider.failNext({ tool, mode: "http", status: 429 });
    const result = await send(kind, true);
    expect(result).toMatchObject({ state: "failed", errorCode: "transient_failure" });
    expect((await flow.sendExport(result.operationId, { retry: true })).state).toBe("complete");
    expect(provider.objects.stories).toHaveLength(1);
    expect(kind === "transcript" ? provider.objects.sections : provider.objects.assets).toHaveLength(1);
  });
  it("retries the recorded Post selection after an edit, then exports the edit as a new operation", async () => {
    provider.failNext({ tool: "stories_create", mode: "http", status: 429 });
    const failed = await send("post", true);
    await fixture.ref("cmsPosts", "post").update({ title: "Edited title", summary: "Edited summary" });
    expect((await flow.sendExport(failed.operationId, { retry: true })).state).toBe("complete");
    expect(provider.objects.stories[0]).toMatchObject({ title: "Post" });
    expect(provider.objects.stories[0].description).toContain("Draft summary");
    expect(provider.objects.stories[0].description).not.toContain("Edited summary");
    const revised = await send("post", true);
    expect(revised.operationId).not.toBe(failed.operationId);
    expect(revised.state).toBe("complete");
    expect(provider.objects.stories).toHaveLength(1);
    expect(provider.objects.stories[0]).toMatchObject({ title: "Edited title" });
    expect(provider.objects.stories[0].description).toContain("Edited summary");
  });
  it("requires edit access to the selected Post", async () => {
    await fixture.ref("users", "staff").update({ role: "staff" });
    await expect(flow.prepareExport(await fixture.request("post", true))).rejects.toMatchObject({ code: "not_authorized" });
    await fixture.ref("users", "staff").update({ role: "staff", grants: [{ role: "contributor", sections: ["news"] }] });
    await fixture.ref("cmsPosts", "post").update({ authorUid: "another-editor", createdBy: "another-editor" });
    await expect(flow.prepareExport(await fixture.request("post", true))).rejects.toMatchObject({ code: "not_authorized" });
    await fixture.ref("cmsPosts", "post").update({ authorUid: "staff", createdBy: "staff" });
    expect((await send("post", true)).state).toBe("complete");
  });
  it.each(["video", "transcript"])("retries the selected %s output after a source metadata edit", async kind => {
    provider.failNext({ tool: kind === "video" ? "assets_import_from_url" : "sections_create", mode: "http", status: 429 });
    const failed = await send(kind, true);
    await fixture.ref("mediaSourceAssets", "asset").update({ name: "Edited name", rendition: null });
    if (kind === "transcript") await fixture.ref("mediaSourceTranscriptJobs", fixture.transcript.id).update({ editRevision: 1 });
    expect((await flow.sendExport(failed.operationId, { retry: true })).state).toBe("complete");
    expect(provider.objects.stories[0].title).toBe("Selected video");
    expect(reads.some(input => input.VersionId === (kind === "video" ? "web-v1" : "text-v1"))).toBe(true);
  });
  it("reconciles a saved story after source edits and expiry, then closes its reservation", async () => {
    provider.failNext({ tool: "stories_get", mode: "http", status: 503 });
    const uncertain = await send("clip", true);
    expect(uncertain.state).toBe("reconciliation");
    await fixture.ref("mediaSourceAssets", "asset").update({ description: "Edited source" });
    await fixture.ref("mediaSourceClipJobs", fixture.clip.id).update({ expiresAt: "2026-10-29T15:00:01Z" });
    const writes = provider.calls.filter(call => /_(create|update|import_from_url)$/.test(call.name)).length;
    const recovered = await flow.sendExport(uncertain.operationId, { reconcile: true });
    expect(recovered).toMatchObject({ state: "failed", errorCode: "transient_failure" });
    expect(provider.calls.filter(call => /_(create|update|import_from_url)$/.test(call.name))).toHaveLength(writes);
    const closed = await flow.operations.acknowledgePartial({ operationId: recovered.operationId,
      attemptId: recovered.attemptId, acknowledgedBy: "staff" });
    expect((await db.collection("cuezMappings").doc(closed.mappingId).get()).data().pendingOperationId).toBeNull();
  });
  it("releases an expired clip's reservation when its known rejection cannot be retried", async () => {
    provider.failNext({ tool: "assets_import_from_url", mode: "http", status: 429 });
    const failed = await send("clip", false);
    const later = flows.createExportFlow({ firestore: db,
      client: clients.createStorydeskClient({ apiKey: "test-key", newsdeskId, fetchImpl: provider.fetch }),
      actorUid: "staff", newsdeskId, registry, renditionBucket: "test-renditions", now: () => now + 24 * 60 * 60 * 1000 });
    const closed = await later.sendExport(failed.operationId, { retry: true });
    expect(closed).toMatchObject({ state: "failed", errorCode: "output_unavailable" });
    expect((await db.collection("cuezMappings").get()).empty).toBe(true);
  });
  it.each(["stories_create", "sections_create"])("recovers a lost %s response from its exact marker", async tool => {
    provider.failNext({ tool, mode: "drop-after" });
    expect((await send(tool === "sections_create" ? "transcript" : "video", true)).state).toBe("complete");
    expect(provider.calls.filter(call => call.name === tool)).toHaveLength(1);
  });
  it("reconciles a lost dossier response, then re-exports the dossier without a false conflict", async () => {
    provider.failNext({ tool: "sections_create", mode: "drop-after" });
    let lookupFailed = false;
    intercept = async (url, init) => {
      const { name } = JSON.parse(init.body).params;
      if (!lookupFailed && name === "sections_list" && provider.calls.some(call => call.name === "sections_create")) {
        lookupFailed = true;
        return new Response("Unavailable", { status: 503 });
      }
      return provider.fetch(url, init);
    };
    const uncertain = await send("transcript", false);
    expect(uncertain.state).toBe("reconciliation");
    expect((await flow.sendExport(uncertain.operationId, { reconcile: true })).state).toBe("complete");
    await fixture.ref("mediaSourceAssets", "asset").update({ description: "Local change" });
    expect((await send("transcript", false)).state).toBe("complete");
    expect(provider.objects.sections).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === "sections_create")).toHaveLength(1);
  });
  it("leaves a lost asset outcome in reconciliation, including after a repeated send or lookup", async () => {
    provider.failNext({ tool: "assets_import_from_url", mode: "drop-after" });
    const result = await send("video", true);
    expect(result.state).toBe("reconciliation");
    expect((await flow.sendExport(result.operationId)).state).toBe("reconciliation");
    expect((await flow.sendExport(result.operationId, { reconcile: true })).state).toBe("reconciliation");
    await expect(flow.sendExport(result.operationId, { retry: true })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(provider.objects.stories).toHaveLength(1); expect(provider.objects.assets).toHaveLength(1);
  });
  it.each([false, true])("resumes an acknowledged partial transcript without duplicating its story or existing dossier (%s)", async existingDossier => {
    if (existingDossier) {
      expect((await send("transcript", true)).state).toBe("complete");
      await fixture.ref("mediaSourceAssets", "asset").update({ description: "Second revision" });
    }
    provider.failNext({ tool: existingDossier ? "sections_update" : "sections_create", mode: "http", status: 400 });
    const failed = await send("transcript", true);
    expect(failed.state).toBe("failed");
    await flow.operations.acknowledgePartial({ operationId: failed.operationId, attemptId: failed.attemptId, acknowledgedBy: "staff" });
    await expect(flow.sendExport(failed.operationId, { retry: true })).rejects.toMatchObject({ code: "invalid_transition" });
    await fixture.ref("mediaSourceAssets", "asset").update({ description: "Third revision" });
    expect((await send("transcript", true)).state).toBe("complete");
    expect(provider.objects.stories).toHaveLength(1);
    expect(provider.objects.sections).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === "stories_create")).toHaveLength(1);
    expect(provider.calls.filter(call => call.name === "sections_create")).toHaveLength(existingDossier ? 1 : 2);
  });
  it("recovers a saved story receipt after a failed read before allowing an explicit continuation", async () => {
    provider.failNext({ tool: "stories_get", mode: "http", status: 503 });
    const result = await send("video", true);
    expect(result.state).toBe("reconciliation");
    expect((await flow.sendExport(result.operationId, { reconcile: true })).state).toBe("failed");
    expect((await flow.sendExport(result.operationId, { retry: true })).state).toBe("complete");
    expect(provider.objects.stories).toHaveLength(1);
  });
  it.each(["post", "transcript"])("updates a mapped %s in place and refuses later remote edits", async kind => {
    const first = await send(kind, true);
    await fixture.ref("mediaSourceAssets", "asset").update({ description: "Local change" });
    await fixture.ref("cmsPosts", "post").update({ summary: "Local change" });
    const second = await send(kind, true);
    expect(second).toMatchObject({ state: "complete", remoteIdentity: first.remoteIdentity, mappingId: first.mappingId });
    expect(provider.objects.stories).toHaveLength(1);
    if (kind === "transcript") expect(provider.objects.sections).toHaveLength(1);
    provider.objects.stories[0].updatedAt = "staff-revision";
    await fixture.ref("mediaSourceAssets", "asset").update({ description: "Another change" });
    await fixture.ref("cmsPosts", "post").update({ summary: "Another change" });
    const before = provider.calls.filter(call => call.name.endsWith("_update")).length;
    expect((await send(kind, true)).state).toBe("conflict");
    expect(provider.calls.filter(call => call.name.endsWith("_update"))).toHaveLength(before);
  });
  it("refuses unavailable viewing copies, changed selections, revoked access, and absent Around NJ ownership", async () => {
    const request = await fixture.request("video", true);
    await fixture.ref("mediaSourceAssets", "asset").update({ rendition: null });
    await expect(flow.prepareExport(request)).rejects.toMatchObject({ code: "selection_changed" });
    await expect(flow.prepareExport(await fixture.request("video", true))).rejects.toMatchObject({ code: "output_unavailable" });
    await fixture.ref("users", "staff").update({ active: false });
    await expect(flow.prepareExport(await fixture.request("post", true))).rejects.toMatchObject({ code: "not_authorized" });
    expect(provider.calls).toHaveLength(0);
  });
  it("retains a public Post link only when a published snapshot exists", async () => {
    await fixture.ref("cmsPosts", "post").update({ published: { metadata: { slug: "public-story" } } });
    expect((await send("post", true)).state).toBe("complete");
    expect(provider.objects.stories[0].description).toContain("https://njpbs.org/posts/public-story/");
  });
  it("refuses Around NJ even when a stray document has the proposed feed shape", async () => {
    const { createHash } = await import("node:crypto");
    const canonicalUrl = "https://outlet.example.test/story";
    const id = createHash("sha256").update(canonicalUrl).digest("hex");
    await fixture.ref("aroundNjStories", id).set({ canonicalUrl, headline: "Outlet story", outlet: "Example outlet",
      partner: true, summary: "Feed summary", lastSeenAt: "2026-10-29T12:00:00Z" });
    await expect(flow.prepareExport(await fixture.request("around-nj", true))).rejects.toMatchObject({ code: "output_unavailable" });
    expect(provider.calls).toHaveLength(0);
    expect((await db.collection("cuezTransferOperations").get()).empty).toBe(true);
  });
});
