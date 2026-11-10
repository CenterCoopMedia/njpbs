"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { parseImportRequest, transferError, SAFE_ERROR_CODES } = require("./cuez-transfer-contract");
const { readActor } = require("./cuez-transfer-selection");
const { createTransferOperations, MAPPINGS, mappingIdentity } = require("./cuez-transfer-operations");
const { createCmsSaveHandler } = require("../save");
const { importRichText, stripTransferMarkers } = require("./cuez-transfer-html");
const { can } = require("./rbac");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const draftIdForStory = (workspaceId, storyId) => digest(["cuez-import-draft-v1", workspaceId, storyId]).slice(0, 32);

function boundedText(value, max = 512000, empty = true) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || !value.isWellFormed() ||
      /\p{Cc}/u.test(value.replace(/[\r\n\t]/g, ""))) throw transferError("output_unavailable");
  return value;
}
const opaqueId = value => {
  boundedText(value, 1024, false);
  if (value.includes("://") || value.trim() !== value) throw transferError("output_unavailable");
  return value;
};

function storyLink(value) {
  boundedText(value, 2048, false);
  let url;
  try { url = new URL(value); } catch { throw transferError("output_unavailable"); }
  if (url.protocol !== "https:" || url.username || url.password) throw transferError("output_unavailable");
  return url.href;
}

function createImportFlow({ firestore, client, actorUid, actorEmail, newsdeskId, now = Date.now }) {
  const operations = createTransferOperations({ firestore, now });
  const authorize = async () => {
    const actor = await firestore.runTransaction(tx => readActor(firestore, tx, actorUid));
    if (!can(actor.principal, "content.create", { ownerId: actorUid, unassignedDraft: true })) throw transferError("not_authorized");
    return actor;
  };

  async function listCandidates({ search = "", page = 1, limit = 25 } = {}) {
    await authorize();
    const response = await client.call("stories_list", { ...(search ? { search } : {}), page, limit });
    if (!Array.isArray(response?.data) || !response.meta || response.meta.page !== page || response.data.length > limit ||
        !Number.isSafeInteger(response.meta.totalPages) || response.meta.totalPages < 0) throw transferError("output_unavailable");
    return { stories: response.data.map(item => {
      const description = stripTransferMarkers(boundedText(item.description ?? "", 512000));
      const descriptionTooLong = description.length > 10000;
      return { id: opaqueId(item.id), title: boundedText(item.title, 250, false),
        description: descriptionTooLong ? "" : description, descriptionTooLong, link: storyLink(item.link) };
    }),
    page, totalPages: response.meta.totalPages };
  }

  async function readStory(request) {
    const parsed = parseImportRequest(request);
    if (!newsdeskId || parsed.workspaceId !== newsdeskId) throw transferError("not_configured");
    await authorize();
    const [{ data: story }, brief, { data: dossiers }] = await Promise.all([
      client.call("stories_get", { storyId: parsed.storyId }), client.call("script_get", { storyId: parsed.storyId }),
      client.call("sections_list", { storyId: parsed.storyId }),
    ]);
    if (!story || story.id !== parsed.storyId || !Array.isArray(dossiers) || dossiers.length > 100 ||
        typeof brief?.contentHash !== "string") throw transferError("output_unavailable");
    const description = boundedText(story.description ?? "", 512000);
    if (stripTransferMarkers(description).length > 10000) throw transferError("description_too_long");
    const mappedStory = { id: opaqueId(story.id), title: boundedText(story.title, 250, false),
      description, link: storyLink(story.link), updatedAt: opaqueId(story.updatedAt) };
    const html = boundedText(brief.html);
    const briefHash = opaqueId(brief.contentHash);
    const sections = dossiers.map(item => ({ id: opaqueId(item.id), title: boundedText(item.title, 512, false),
      content: boundedText(item.content), createdAt: boundedText(item.createdAt, 1024, false) }));
    if (new Set(sections.map(item => item.id)).size !== sections.length) throw transferError("output_unavailable");
    const creatorId = typeof story.creator === "string" ? opaqueId(story.creator)
      : typeof story.creator?.id === "string" ? opaqueId(story.creator.id) : null;
    const remoteChangeMarker = digest({ story: mappedStory, brief: { html, contentHash: briefHash }, dossiers: sections, creatorId });
    const briefContent = await importRichText(html, mappedStory.link);
    const mappedDossiers = await Promise.all(sections.map(async section => ({ id: section.id, title: stripTransferMarkers(section.title) || "Dossier",
      ...await importRichText(section.content, mappedStory.link) })));
    const warnings = [...new Set(["StoryDesk's Brief read omits embedded media, feed items, story references, and mention identities.",
      ...(story.creator != null ? ["Review the original author credit in StoryDesk before importing."] : []),
      ...(stripTransferMarkers(mappedStory.description) !== mappedStory.description || sections.some(section => stripTransferMarkers(section.title) !== section.title)
        ? ["Internal transfer markers were omitted."] : []),
      ...briefContent.warnings, ...mappedDossiers.flatMap(section => section.warnings)])];
    const sourceAttribution = { system: "storydesk", storyId: mappedStory.id, storyLink: mappedStory.link,
      briefHash, dossierIds: sections.map(section => section.id), creatorId };
    return { parsed, story: mappedStory, brief: briefContent.document, dossiers: mappedDossiers, warnings,
      remoteChangeMarker, sourceAttribution };
  }

  async function prepared(snapshot) {
    let origin = null;
    const marker = /\n\[boardwalk-transfer:([a-f0-9]{64})\]$/.exec(snapshot.story.description);
    if (marker) {
      const exported = await operations.read(marker[1]);
      if (exported?.direction === "export" && exported.state === "complete" && exported.remoteIdentity === snapshot.story.id &&
          exported.selectionSnapshot.workspaceId === newsdeskId) origin = exported.origin;
    }
    return { direction: "import", selectionSnapshot: { ...snapshot.parsed, remoteChangeMarker: snapshot.remoteChangeMarker },
      resolvedSelection: {}, initiatedBy: actorUid, origin };
  }

  async function previewImport(request) {
    const snapshot = await readStory(request);
    const { operation } = await operations.enqueue(await prepared(snapshot));
    return { operation, story: { ...snapshot.story, description: stripTransferMarkers(snapshot.story.description) }, brief: snapshot.brief, dossiers: snapshot.dossiers,
      warnings: snapshot.warnings, remoteChangeMarker: snapshot.remoteChangeMarker };
  }

  function postDocument(snapshot) {
    const prose = content => ({ type: "prose", visible: true, data: { content } });
    const heading = text => prose({ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] }] });
    const blocks = [heading("Brief"), prose(snapshot.brief)];
    for (const section of snapshot.dossiers) blocks.push(heading(section.title), prose(section.document));
    blocks.push(prose({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Source: StoryDesk. " },
      { type: "text", text: "View the original story", marks: [{ type: "link", attrs: { href: snapshot.story.link } }] },
    ] }] }));
    return { type: "post", status: "draft", title: snapshot.story.title, summary: stripTransferMarkers(snapshot.story.description), tags: [],
      blocks: blocks.map((block, order) => ({ ...block, order })) };
  }

  async function saveDraft(operation, snapshot, expectedMappingOperationId) {
    const recordId = draftIdForStory(newsdeskId, snapshot.story.id);
    return firestore.runTransaction(async tx => {
      const actor = await readActor(firestore, tx, actorUid);
      const staged = await operations.prepareImportCommit({ transaction: tx, operationId: operation.operationId,
        attemptId: operation.attemptId, recordId, expectedMappingOperationId, draftHash: digest, sourceAttribution: snapshot.sourceAttribution });
      if (!staged.commit) return staged.operation;
      // The Post owner validates, authorizes, composes, audits, and writes in this transaction.
      const joinedFirestore = new Proxy(firestore, { get(target, key) {
        if (key === "runTransaction") return callback => callback(tx);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      let nextId = recordId;
      const mintId = () => { const id = nextId; nextId = randomUUID(); return id; };
      const handler = createCmsSaveHandler({ firestore: joinedFirestore,
        requirePrincipalFn: async () => ({ ...actor, email: actorEmail ?? actor.email }),
        mintId, now: () => new Date(now()).toISOString() });
      const body = { collection: "cmsPosts", document: postDocument(snapshot),
        ...(staged.draft ? { id: recordId, baseVersion: staged.draft.version } : {}) };
      let response, status = 200;
      const res = { headersSent: false, status(value) { status = value; return this; }, json(value) { response = value; this.headersSent = true; return this; } };
      await handler({ method: "POST", body, headers: {} }, res);
      if (status !== 200 || !response?.success) {
        throw transferError(status >= 500 ? "transient_failure" : status === 403 ? "not_authorized"
          : status === 409 ? "selection_changed" : "invalid_request");
      }
      return staged.commit(response.document);
    });
  }

  async function confirmImport(operationId, { retry = false, reconcile = false } = {}) {
    const existing = await operations.read(operationId);
    if (!existing || existing.direction !== "import") throw transferError("invalid_request");
    await authorize();
    if (["complete", "conflict"].includes(existing.state)) return existing;
    if (reconcile && ["transferring", "reconciliation"].includes(existing.state)) {
      // A draft write and its completion receipt share a transaction. No receipt means no write.
      await operations.advance({ operationId, attemptId: existing.attemptId, event: "confirmed_failure", errorCode: "transient_failure" });
      return operations.read(operationId);
    }
    if (retry) await operations.advance({ operationId, attemptId: existing.attemptId, event: "retry" });
    const { remoteChangeMarker: expected, ...request } = existing.selectionSnapshot;
    const snapshot = await readStory(request);
    if (snapshot.remoteChangeMarker !== expected) return operations.advance({ operationId, attemptId: existing.attemptId,
      event: "confirmed_conflict", errorCode: "remote_conflict", conflict: { localRevision: expected, remoteRevision: snapshot.remoteChangeMarker } });
    const p = await prepared(snapshot);
    const claimed = await operations.claim(operationId, p);
    if (!claimed.claimed) return claimed.operation;
    const recordId = draftIdForStory(newsdeskId, snapshot.story.id);
    const identity = mappingIdentity(claimed.operation, { collection: "cmsPosts", recordId, version: 1, updateTime: "new" });
    const previous = (await firestore.collection(MAPPINGS).doc(identity.mappingId).get()).data();
    try { return await saveDraft(claimed.operation, snapshot, previous?.lastOperationId ?? null); }
    catch (error) {
      const code = SAFE_ERROR_CODES.includes(error?.code) ? error.code : "transient_failure";
      return operations.advance({ operationId, attemptId: claimed.operation.attemptId, event: "confirmed_failure",
        errorCode: ["remote_conflict", "outcome_unknown"].includes(code) ? "transient_failure" : code });
    }
  }

  return { listCandidates, previewImport, confirmImport, operations };
}

module.exports = { createImportFlow, draftIdForStory, draftHash: digest };
