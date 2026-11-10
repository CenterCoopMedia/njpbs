import { beforeEach, describe, expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { boardwalkFixture, newsdeskId, now } from "../helpers/cuez-boardwalk-fixture.js";
import { storydeskProvider } from "../helpers/cuez-storydesk-provider.js";
import imports from "../../functions/lib/cuez-transfer-import.js";
import clients from "../../functions/lib/cuez-transfer-storydesk.js";
import html from "../../functions/lib/cuez-transfer-html.js";
import { getSchema } from "@tiptap/core";
import { richTextExtensions } from "../../admin/src/lib/rich-text";

const db = isolatedFirestore("cuez-import");
let fixture, provider, flow;
const request = { workspaceId: newsdeskId, importKind: "story-with-brief-and-dossiers", storyId: "external-story", mappingVersion: 1 };
beforeEach(async () => {
  fixture = await boardwalkFixture(db);
  provider = storydeskProvider();
  provider.objects.stories.push({ id: request.storyId, title: "External story", description: "Original description",
    createdAt: "2026-10-29T12:00:00Z", updatedAt: "2026-10-29T12:01:00Z", link: "https://storydesk.example.test/story", creator: { id: "original-reporter" } });
  provider.objects.briefs.push({ storyId: request.storyId, text: "Brief text", html: "<p>Brief <strong>text</strong> &amp; context.</p>", contentHash: "brief-v1" });
  provider.objects.sections.push({ storyId: request.storyId, id: "dossier-b", title: "Background", content: "<p>First dossier.</p>", createdAt: "2026-10-29T12:00:00Z" },
    { storyId: request.storyId, id: "dossier-a", title: "Interview", content: "<p>Second dossier.</p>", createdAt: "2026-10-29T12:01:00Z" });
  flow = imports.createImportFlow({ firestore: db, client: clients.createStorydeskClient({ apiKey: "test-key", newsdeskId, fetchImpl: provider.fetch }),
    actorUid: "staff", newsdeskId, now: () => now });
});
const preview = () => flow.previewImport(request);
const confirm = async () => flow.confirmImport((await preview()).operation.operationId);

describe("explicit StoryDesk import through the Post save owner", () => {
  it.each([500, 503])("retries a transient Post save HTTP %s without changing the source", async status => {
    let failSave = true;
    const failingDb = new Proxy(db, { get(target, key) {
      if (key === "runTransaction") return callback => target.runTransaction(tx => callback(new Proxy(tx, { get(transaction, method) {
        if (method === "set") return (reference, ...args) => {
          if (failSave && reference.parent.id === "cmsPosts") {
            failSave = false;
            throw Object.assign(new Error("Synthetic backend failure"), { status });
          }
          return transaction.set(reference, ...args);
        };
        const value = Reflect.get(transaction, method);
        return typeof value === "function" ? value.bind(transaction) : value;
      } })));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const failingFlow = imports.createImportFlow({ firestore: failingDb,
      client: clients.createStorydeskClient({ apiKey: "test-key", newsdeskId, fetchImpl: provider.fetch }),
      actorUid: "staff", newsdeskId, now: () => now });
    const before = await failingFlow.previewImport(request);
    expect(await failingFlow.confirmImport(before.operation.operationId)).toMatchObject({ state: "failed", errorCode: "transient_failure" });
    expect((await db.collection("cmsPosts").get()).size).toBe(1);
    expect((await failingFlow.previewImport(request)).operation.operationId).toBe(before.operation.operationId);
    expect(await failingFlow.confirmImport(before.operation.operationId, { retry: true })).toMatchObject({ state: "complete" });
    expect((await db.collection("cmsPosts").get()).size).toBe(2);
  });
  it("preserves adjacent source blocks in the preview and saved draft", async () => {
    provider.objects.briefs[0].html = "<div>First paragraph</div><section>Second paragraph</section><article>Third paragraph</article>";
    const before = await preview();
    expect(before.brief.content.map(block => block.content[0].text)).toEqual(["First paragraph", "Second paragraph", "Third paragraph"]);
    const done = await flow.confirmImport(before.operation.operationId);
    const post = (await fixture.ref("cmsPosts", done.importedRecord.recordId).get()).data();
    const brief = post.blocks[1].data.content;
    expect(brief.content.map(block => block.content[0].text)).toEqual(["First paragraph", "Second paragraph", "Third paragraph"]);
  });
  it("lists and previews the story, Brief, ordered dossiers, attribution, and omissions without saving a Post", async () => {
    const list = await flow.listCandidates({ search: "Original", page: 1, limit: 25 });
    expect(list.stories).toMatchObject([{ id: "external-story", title: "External story" }]);
    const result = await preview();
    expect(result.story).toMatchObject({ id: "external-story", description: "Original description", link: "https://storydesk.example.test/story" });
    expect(result.brief.content[0].content[1]).toMatchObject({ type: "text", text: "text", marks: [{ type: "bold" }] });
    expect(result.dossiers.map(item => item.id)).toEqual(["dossier-b", "dossier-a"]);
    expect(result.warnings[0]).toContain("omits embedded media");
    expect((await db.collection("cmsPosts").get()).size).toBe(1);
    expect(provider.calls.every(call => clients.READ_TOOLS.includes(call.name))).toBe(true);
  });
  it("identifies a description above the import limit before creating an operation", async () => {
    provider.objects.stories[0].description = "x".repeat(10001);
    const list = await flow.listCandidates();
    expect(list.stories[0]).toMatchObject({ description: "", descriptionTooLong: true });
    await expect(preview()).rejects.toMatchObject({ code: "description_too_long" });
    expect((await db.collection("cuezTransferOperations").get()).empty).toBe(true);
    expect((await db.collection("cmsPosts").get()).size).toBe(1);
  });
  it("creates one private draft with validated blocks, source link, IDs, origin, audit, and mapping in the same transaction", async () => {
    const result = await confirm();
    expect(result.state).toBe("complete");
    const id = result.importedRecord.recordId;
    const post = (await fixture.ref("cmsPosts", id).get()).data();
    expect(post).toMatchObject({ id, type: "post", status: "draft", title: "External story", summary: "Original description", createdBy: "staff", version: 1 });
    expect(post.published).toBeUndefined();
    // The save owner gives ordinary drafts a legacy timestamp; only scheduleAt schedules.
    expect(post.publishAt).toBe("2026-10-29T15:00:00.000Z");
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
    expect(post.blocks.filter(block => block.data.content?.content[0]?.type === "heading")
      .map(block => block.data.content.content[0].content[0].text)).toEqual(["Brief", "Background", "Interview"]);
    expect(JSON.stringify(post.blocks)).toContain("https://storydesk.example.test/story");
    expect(post.cuezOrigin.system).toBe("external");
    const mapping = (await fixture.ref("cuezMappings", result.mappingId).get()).data();
    expect(mapping).toMatchObject({ externalId: request.storyId, boardwalkRecord: { collection: "cmsPosts", recordId: id },
      sourceAttribution: { system: "storydesk", creatorId: "original-reporter", dossierIds: ["dossier-b", "dossier-a"] } });
    expect(result.sourceAttribution).toEqual(mapping.sourceAttribution);
    expect(mapping.lastLocalRevision.draftHash).toBe(imports.draftHash(post));
    expect(JSON.stringify(result)).not.toMatch(/Original description|First dossier|Brief text/);
    expect((await confirm()).operationId).toBe(result.operationId);
    expect((await fixture.ref("cmsPosts", id).get()).data().version).toBe(1);
    expect(provider.calls.every(call => clients.READ_TOOLS.includes(call.name))).toBe(true);
  });
  it("updates the same unchanged draft when the Brief changes", async () => {
    const first = await confirm();
    provider.objects.briefs[0].html = "<p>Corrected Brief.</p>";
    provider.objects.briefs[0].contentHash = "brief-v2";
    const second = await confirm();
    expect(second.state).toBe("complete");
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.importedRecord).toMatchObject({ recordId: first.importedRecord.recordId, version: 2 });
    expect(second.mappingId).toBe(first.mappingId);
    expect((await db.collection("cmsPosts").get()).size).toBe(2);
  });
  it.each(["staff-edit", "published", "scheduled", "deleted"])("records conflict before touching a mapped draft after %s", async kind => {
    const first = await confirm();
    const ref = fixture.ref("cmsPosts", first.importedRecord.recordId);
    await ref.update({ "staff-edit": { title: "Staff edit" }, published: { published: { slug: "existing-public-story" } },
      scheduled: { status: "scheduled", publishAt: "2026-11-01T12:00:00Z" }, deleted: { deleted: true } }[kind]);
    const before = (await ref.get()).data();
    provider.objects.briefs[0].html = "<p>Changed remotely.</p>";
    const second = await confirm();
    expect(second.state).toBe("conflict");
    expect((await ref.get()).data()).toEqual(before);
    expect((await fixture.ref("cuezMappings", first.mappingId).get()).data().lastOperationId).toBe(first.operationId);
    expect(second.conflict.proposed.remoteRevision).not.toBe(first.remoteChangeMarker);
  });
  it("requires a new preview when any source changes after preview", async () => {
    const before = await preview();
    provider.objects.sections.reverse();
    const result = await flow.confirmImport(before.operation.operationId);
    expect(result.state).toBe("conflict");
    expect((await db.collection("cmsPosts").get()).size).toBe(1);
  });
  it("preserves a fragment-based StoryDesk link and string creator identity", async () => {
    provider.objects.stories[0].link = "https://storydesk.example.test/#/story/example";
    provider.objects.stories[0].creator = "source-creator";
    const result = await confirm();
    expect(result.state).toBe("complete");
    expect(result.sourceAttribution).toMatchObject({ storyLink: "https://storydesk.example.test/#/story/example", creatorId: "source-creator" });
  });
  it("refuses revoked accounts and relies on the Post owner's create authorization", async () => {
    const before = await preview();
    await fixture.ref("users", "staff").update({ active: false });
    await expect(flow.confirmImport(before.operation.operationId)).rejects.toMatchObject({ code: "not_authorized" });
    await fixture.ref("users", "staff").set({ active: true, role: "viewer", emailVerified: true });
    await expect(flow.confirmImport(before.operation.operationId)).rejects.toMatchObject({ code: "not_authorized" });
    expect((await db.collection("cmsPosts").get()).size).toBe(1);
    expect((await db.collection("cuezMappings").get()).empty).toBe(true);
  });
  it("refuses list, preview, and confirmation for staff without Post create access before reading StoryDesk", async () => {
    const before = await preview();
    await fixture.ref("users", "staff").set({ active: true, role: "staff", emailVerified: true });
    provider.calls.length = 0;
    await expect(flow.listCandidates()).rejects.toMatchObject({ code: "not_authorized" });
    await expect(preview()).rejects.toMatchObject({ code: "not_authorized" });
    await expect(flow.confirmImport(before.operation.operationId)).rejects.toMatchObject({ code: "not_authorized" });
    expect(provider.calls).toHaveLength(0);
    expect((await flow.operations.read(before.operation.operationId)).state).toBe("queued");
  });
  it("removes internal transfer markers from preview and imported summary and bodies", async () => {
    const marker = `[boardwalk-transfer:${"a".repeat(64)}]`;
    provider.objects.stories[0].description += `\n${marker}`;
    provider.objects.briefs[0].html += `<p>Brief tail ${marker}</p>`;
    provider.objects.sections[0].title += ` ${marker}`;
    provider.objects.sections[0].content += `<p>Dossier tail ${marker}</p>`;
    const prepared = await preview();
    expect(prepared.story.description).toBe("Original description");
    expect(JSON.stringify([prepared.brief, prepared.dossiers])).not.toContain("boardwalk-transfer:");
    expect(prepared.warnings).toContain("Internal transfer markers were omitted.");
    const result = await flow.confirmImport(prepared.operation.operationId);
    const post = (await fixture.ref("cmsPosts", result.importedRecord.recordId).get()).data();
    expect(post.summary).toBe("Original description");
    expect(JSON.stringify(post.blocks)).not.toContain("boardwalk-transfer:");
    expect(JSON.stringify(post.blocks)).toContain("Dossier tail");
  });
  it("records the importing actor's email in the Post owner's audit row", async () => {
    await fixture.ref("users", "staff").update({ email: "importer@example.test" });
    const result = await confirm();
    const rows = await db.collection("admin_logs").where("target", "==", `cmsPosts/${result.importedRecord.recordId}`).get();
    expect(rows.docs.map(row => row.data())).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "cms.save", actorUid: "staff", actorEmail: "importer@example.test" }),
    ]));
  });
  it("deduplicates simultaneous confirmations and fences interrupted imports without a draft receipt", async () => {
    const before = await preview();
    const results = await Promise.all([flow.confirmImport(before.operation.operationId), flow.confirmImport(before.operation.operationId)]);
    expect(results.some(item => item.state === "complete")).toBe(true);
    expect((await db.collection("cmsPosts").get()).size).toBe(2);
    provider.objects.briefs[0].html = "<p>Another version.</p>";
    const next = await preview();
    const op = next.operation;
    await flow.operations.claim(op.operationId, { direction: op.direction, selectionSnapshot: op.selectionSnapshot,
      resolvedSelection: {}, initiatedBy: "staff", origin: null });
    expect(await flow.confirmImport(op.operationId, { reconcile: true })).toMatchObject({ state: "failed", errorCode: "transient_failure" });
    expect((await flow.confirmImport(op.operationId, { retry: true })).state).toBe("complete");
  });
});

describe("HTML to the existing portable rich-text boundary", () => {
  it.each(["div", "section", "article"])("keeps adjacent %s text and nested blocks separate", async tag => {
    const { document } = await html.importRichText(`<${tag}>First</${tag}><${tag}>Second<p>Nested</p>Tail</${tag}>`);
    expect(document.content.map(block => block.content[0].text)).toEqual(["First", "Second", "Nested", "Tail"]);
    expect(() => getSchema(richTextExtensions()).nodeFromJSON(document).check()).not.toThrow();
  });
  it.each([
    ["<div><p>a</p></div>", "a"],
    ["<ul><li>text</li><li><p>other</p></li></ul>", "textother"],
    ["<blockquote>text<p>block</p>tail</blockquote>", "textblocktail"],
    ["<li>one</li><li>two</li>", "onetwo"],
  ])("produces editor-valid blocks for %s", async (input, text) => {
    const converted = await html.importRichText(input);
    const document = getSchema(richTextExtensions()).nodeFromJSON(converted.document);
    expect(() => document.check()).not.toThrow();
    expect(document.textContent).toBe(text);
  });
  it("resolves source-relative links against StoryDesk and removes credential-bearing links", async () => {
    const result = await html.importRichText('<p><a href="/reference">Source</a><a href="https://user:password@example.test/">Unsafe</a></p>', "https://storydesk.example.test/story");
    expect(result.document.content[0].content[0].marks[0].attrs.href).toBe("https://storydesk.example.test/reference");
    expect(JSON.stringify(result.document)).not.toMatch(/user:password/);
  });
  it("opens imported paragraphs, lists, and code in the existing editor schema without losing text", async () => {
    const converted = await html.importRichText("<div><p>Lead.</p><ul><li>One <strong>voice</strong></li><li>Two</li></ul><pre><code>&lt;safe&gt;</code></pre></div>");
    const document = getSchema(richTextExtensions()).nodeFromJSON(converted.document);
    expect(() => document.check()).not.toThrow();
    expect(document.textContent).toBe("Lead.One voiceTwo<safe>");
  });
  it("decodes entities, keeps safe marks and links, and drops active content and unsafe URLs", async () => {
    const result = await html.importRichText('<h1>Heading</h1><p onclick="bad()">A &amp; B <em>said</em> <a href="javascript:bad()">no</a> <a href="https://example.test/">yes</a></p><script>bad()</script><img src="https://example.test/pixel">');
    expect(result.document.content[0]).toMatchObject({ type: "heading", attrs: { level: 2 } });
    const serialized = JSON.stringify(result.document);
    expect(serialized).toContain("A & B"); expect(serialized).toContain("https://example.test/");
    expect(serialized).not.toMatch(/javascript|onclick|bad\(\)|pixel/);
    expect(result.warnings).toEqual(expect.arrayContaining(["Embedded or active content was omitted.", "An unsupported link was removed."]));
  });
});
