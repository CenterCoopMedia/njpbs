"use strict";

const { transferError: contractError } = require("./cuez-transfer-contract");
const { createHash } = require("node:crypto");
const INTERNAL_FAILURE = Symbol("storydesk-client-failure");

function transferError(code) {
  const error = contractError(code);
  error[INTERNAL_FAILURE] = true;
  return error;
}

const ENDPOINT = "https://api.us.storydesk.cuez.app/v1/mcp/";
const READ_TOOLS = Object.freeze(["stories_get", "stories_list", "script_get", "sections_list", "assets_search", "assets_list_for_story"]);
const WRITE_TOOLS = Object.freeze(["stories_create", "stories_create_from_url", "sections_create", "assets_import_from_url", "stories_update", "sections_update"]);
const APPROVED_TOOLS = Object.freeze([...READ_TOOLS, ...WRITE_TOOLS]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FIELDS = {
  stories_get: ["storyId"], script_get: ["storyId"], sections_list: ["storyId"], assets_list_for_story: ["storyId"],
  stories_list: ["search", "date", "startDate", "endDate", "unplanned", "page", "limit"],
  assets_search: ["query", "type", "limit"],
  stories_create: ["title", "description"], stories_create_from_url: ["url"],
  sections_create: ["storyId", "title", "content"], assets_import_from_url: ["storyId", "url", "filename"],
  stories_update: ["storyId", "title", "description"], sections_update: ["storyId", "sectionId", "title", "content"],
};
const SCOPED_TOOLS = ["stories_list", "assets_search", "stories_create", "stories_create_from_url"];

function string(value, max = 1024, multiline = false, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || !value.isWellFormed() ||
      /\p{Cc}/u.test(multiline ? value.replace(/[\t\r\n]/g, "") : value)) throw transferError("invalid_request");
  return value;
}

function requireOperationId(operationId) {
  if (typeof operationId !== "string" || !/^[a-f0-9]{64}$/.test(operationId)) throw transferError("invalid_request");
  return operationId;
}

function transferMarker(operationId) {
  return `[boardwalk-transfer:${requireOperationId(operationId)}]`;
}

function contentHash(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function transcriptHtml(content) {
  string(content, 512000, true, true);
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return content.split(/\r\n|\r|\n/).map(line => `<p>${line.replace(/[&<>"']/g, char => entities[char])}</p>`).join("\n");
}

function validateArguments(name, args) {
  if (!APPROVED_TOOLS.includes(name)) throw transferError("not_authorized");
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
      Object.keys(args).some(key => !FIELDS[name].includes(key))) throw transferError("invalid_request");
  const result = { ...args };
  for (const [field, value] of Object.entries(result)) {
    if (["page", "limit"].includes(field)) {
      if (!Number.isSafeInteger(value) || value < 1 || (field === "limit" && value > 100)) throw transferError("invalid_request");
    } else if (field === "unplanned") {
      if (typeof value !== "boolean") throw transferError("invalid_request");
    } else string(value, ["description", "content"].includes(field) ? 512000 : 2048,
      ["description", "content"].includes(field), ["description", "content"].includes(field));
  }
  if (["stories_get", "script_get", "sections_list", "sections_create", "assets_list_for_story", "assets_import_from_url",
    "stories_update", "sections_update"].includes(name)) {
    string(result.storyId);
  }
  if (["stories_create", "stories_update"].includes(name)) string(result.title, 250);
  if (["sections_create", "sections_update"].includes(name)) {
    string(result.title, 512);
    if (result.title.trim().toLowerCase() === "brief") throw transferError("invalid_request");
  }
  if (name === "sections_update") string(result.sectionId);
  if (name === "assets_import_from_url" && result.filename !== undefined &&
      (result.filename.length > 200 || /[/\\]/.test(result.filename))) throw transferError("invalid_request");
  if (["assets_import_from_url", "stories_create_from_url"].includes(name)) string(result.url, 2048);
  if (name === "assets_search") {
    string(result.query);
    if (result.type !== undefined && !["image", "video", "audio"].includes(result.type)) throw transferError("invalid_request");
  }
  if (result.url !== undefined) {
    let url;
    try { url = new URL(result.url); } catch { throw transferError("invalid_request"); }
    if (url.protocol !== "https:" || url.username || url.password) throw transferError("invalid_request");
  }
  return result;
}

function markedArguments(name, args, operationId) {
  const marker = transferMarker(operationId);
  // URL extraction exposes no marker-bearing argument; do not send an undocumented one.
  if (name === "stories_create_from_url") throw transferError("invalid_request");
  if (["stories_create", "stories_update"].includes(name)) return { ...args, description: `${args.description ?? ""}\n${marker}` };
  if (["sections_create", "sections_update"].includes(name)) return { ...args, title: `${args.title} ${marker}`,
    content: transcriptHtml(args.content ?? "") };
  if (name === "assets_import_from_url") return args;
  throw transferError("invalid_request");
}

function responseFailure(status, write) {
  if ([401, 403].includes(status)) return "not_authorized";
  if (status === 429) return "transient_failure";
  if ([400, 422].includes(status)) return "invalid_request";
  if (status === 404) return "output_unavailable";
  if ([409, 412].includes(status)) return "remote_conflict";
  return write ? "outcome_unknown" : "transient_failure";
}

async function boundedResponse(response, signal) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES || !response.body) throw transferError("outcome_unknown");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw transferError("outcome_unknown");
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function rpcEnvelope(body, contentType, id) {
  let responses;
  if (contentType.includes("text/event-stream") || body.trimStart().startsWith("data:")) {
    responses = body.replace(/\r\n/g, "\n").split(/\n\n/).flatMap(event => {
      const data = event.split("\n").filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).replace(/^ /, "")).join("\n");
      return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
    });
  } else responses = [JSON.parse(body)];
  const matches = responses.filter(value => value?.jsonrpc === "2.0" && value.id === id);
  if (matches.length !== 1) throw transferError("outcome_unknown");
  return matches[0];
}

function toolData(envelope, write) {
  if (Object.hasOwn(envelope, "error") === Object.hasOwn(envelope, "result")) throw transferError("outcome_unknown");
  const code = envelope.error?.code;
  if (envelope.error) {
    if (code === -32602) throw transferError("invalid_request");
    if (code === -32000) throw transferError("not_authorized");
    if (code === -32601) throw transferError("not_configured");
    throw transferError(write ? "outcome_unknown" : "transient_failure");
  }
  const result = envelope.result;
  if (result?.isError) throw transferError(write ? "outcome_unknown" : "invalid_request");
  if (!Array.isArray(result?.content) || result.content.length === 0 ||
      result.content.some(item => item?.type !== "text" || typeof item.text !== "string")) throw transferError("outcome_unknown");
  const data = result.content.map(item => JSON.parse(item.text));
  if (data.some(value => value === null || typeof value !== "object")) throw transferError("outcome_unknown");
  if (data.some(value => value.error)) throw transferError(write ? "outcome_unknown" : "invalid_request");
  return data.length === 1 ? data[0] : data;
}

function remoteId(value) {
  return typeof value === "string" && value && value.length <= 1024 && value.isWellFormed() &&
    value.trim() === value && !/\p{Cc}/u.test(value) && !value.includes("://") ? value : null;
}

function createdIdentity(value, tool, storyId) {
  const object = value?.data;
  if (tool === "assets_import_from_url") return object?.storyId === storyId ? remoteId(object.assetId) : null;
  return remoteId(object?.id);
}

function completeStories(value) {
  const { data, meta } = value ?? {};
  if (!Array.isArray(data) || !meta || meta.page !== 1 || !Number.isSafeInteger(meta.limit) || meta.limit < 1 || meta.limit > 100 ||
      !Number.isSafeInteger(meta.total) || meta.total !== data.length || data.length > meta.limit ||
      !Number.isSafeInteger(meta.totalPages) || meta.totalPages < 0 || meta.totalPages > 1 || (meta.total > 0 && meta.totalPages !== 1)) return null;
  return data;
}

function createStorydeskClient({ apiKey, newsdeskId, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(apiKey) ||
      typeof newsdeskId !== "string" || !newsdeskId || newsdeskId.trim() !== newsdeskId || newsdeskId.length > 1024 ||
      !newsdeskId.isWellFormed() || /\p{Cc}/u.test(newsdeskId)) throw transferError("not_configured");
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw transferError("invalid_request");
  let sequence = 0;
  const attempted = new Set();

  async function invoke(name, args) {
    const write = WRITE_TOOLS.includes(name);
    const id = ++sequence;
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(transferError("outcome_unknown")); }, timeoutMs);
    });
    const request = async () => {
      const response = await fetchImpl(ENDPOINT, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name,
          arguments: SCOPED_TOOLS.includes(name) ? { ...args, newsdeskId } : args } }) });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw transferError(responseFailure(response.status, write));
      }
      const body = await boundedResponse(response, controller.signal);
      return toolData(rpcEnvelope(body, response.headers.get("content-type") ?? "", id), write);
    };
    try {
      return await Promise.race([request(), timeout]);
    } catch (error) {
      // Discard provider and transport messages, causes and response bodies.
      throw transferError(error?.[INTERNAL_FAILURE] === true ? error.code : "outcome_unknown");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function call(name, args = {}) {
    const parsed = validateArguments(name, args);
    if (!READ_TOOLS.includes(name)) throw transferError("invalid_request");
    return invoke(name, parsed);
  }

  const unsettled = () => ({ state: "reconciliation", errorCode: "outcome_unknown" });

  async function lookup({ operationId, tool, storyId, arguments: args }) {
    requireOperationId(operationId);
    if (!["stories_create", "sections_create", "assets_import_from_url"].includes(tool)) throw transferError("invalid_request");
    if (tool !== "stories_create") string(storyId);
    // IDs-only asset lists cannot distinguish our import from concurrent staff work.
    if (tool === "assets_import_from_url") return unsettled();
    try {
      let matches;
      if (tool === "stories_create") {
        const list = completeStories(await call("stories_list", { search: transferMarker(operationId), page: 1, limit: 100 }));
        if (!list || list.some(item => !remoteId(item?.id) || typeof item.description !== "string")) return unsettled();
        matches = list.filter(item => item.description.endsWith(`\n${transferMarker(operationId)}`));
      } else {
        const list = (await call("sections_list", { storyId }))?.data;
        if (!Array.isArray(list) || list.some(item => !remoteId(item?.id) || typeof item.title !== "string" || typeof item.content !== "string")) return unsettled();
        const expected = markedArguments(tool, validateArguments(tool, args), operationId);
        if (expected.storyId !== storyId) return unsettled();
        matches = list.filter(item => item.title === expected.title && item.content === expected.content);
      }
      if (matches.length === 1) return { state: "complete", remoteIdentity: matches[0].id, recovered: true };
    } catch {
      // A failed lookup cannot establish absence or authorize another create.
    }
    return unsettled();
  }

  async function create({ operationId, step, tool, arguments: args, priorOutcome } = {}) {
    const parsed = validateArguments(tool, args);
    if (!["stories_create", "sections_create", "assets_import_from_url"].includes(tool) ||
        !["not-attempted", "unknown"].includes(priorOutcome)) throw transferError("invalid_request");
    const stepName = step ?? tool.replaceAll("_", "-");
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(stepName)) throw transferError("invalid_request");
    const marked = validateArguments(tool, markedArguments(tool, parsed, operationId));
    const identity = `${operationId}:${stepName}`;
    if (priorOutcome === "unknown" || attempted.has(identity)) return lookup({ operationId, tool, storyId: parsed.storyId, arguments: parsed });
    attempted.add(identity);
    try {
      const result = await invoke(tool, marked);
      const remoteIdentity = createdIdentity(result, tool, parsed.storyId);
      if (remoteIdentity) return { state: "complete", remoteIdentity, recovered: false };
    } catch (error) {
      if (error.code !== "outcome_unknown") {
        attempted.delete(identity);
        throw error;
      }
    }
    return lookup({ operationId, tool, storyId: parsed.storyId, arguments: parsed });
  }

  async function observe(tool, args, id) {
    if (["stories_create", "stories_update"].includes(tool)) {
      const object = (await call("stories_get", { storyId: id }))?.data;
      if (!object || object.id !== id || !remoteId(object.updatedAt)) throw transferError("outcome_unknown");
      return { revision: object.updatedAt, matches: object.title === args.title && object.description === args.description };
    }
    const list = (await call("sections_list", { storyId: args.storyId }))?.data;
    if (!Array.isArray(list)) throw transferError("outcome_unknown");
    const matches = list.filter(item => item?.id === id);
    if (matches.length !== 1 || typeof matches[0].title !== "string" || typeof matches[0].content !== "string") throw transferError("outcome_unknown");
    return { revision: contentHash(JSON.stringify([matches[0].title, matches[0].content])),
      matches: matches[0].title === args.title && matches[0].content === args.content };
  }

  async function assetIds(storyId) {
    try {
      const list = (await call("assets_list_for_story", { storyId }))?.data;
      if (Array.isArray(list) && list.length <= 10000 && list.every(item => remoteId(item?.id)) &&
          new Set(list.map(item => item.id)).size === list.length) return list.map(item => item.id).sort();
    } catch { /* A failed read does not prevent recording an unknown asset outcome. */ }
    return null;
  }

  async function recordUnknown(operations, fence) {
    await operations.advance({ ...fence, event: "outcome_unknown", errorCode: "outcome_unknown" });
    return unsettled();
  }

  function assertStepTarget(operation, tool, args) {
    const target = operation.selectionSnapshot.target;
    if (tool === "stories_create") {
      if (target.kind !== "new-story") throw transferError("invalid_request");
      return;
    }
    if (tool === "sections_create") {
      if (target.kind === "dossier" && target.storyId === args.storyId) return;
    }
    if (target.kind === "story-asset" && target.storyId === args.storyId) return;
    const priorStory = Object.values(operation.steps).find(item =>
      ["stories_create", "stories_update"].includes(item.tool) && item.outcome === "complete");
    if (target.kind !== "new-story" ||
        priorStory?.remoteIdentity !== args.storyId) throw transferError("invalid_request");
  }

  async function planStep(reserved, step, tool, parsed, operationId, operations) {
    assertStepTarget(reserved.operation, tool, parsed);
    let mapping = reserved.mapping;
    // A new-story mapping identifies its container; a dossier step owns a separate ID.
    if (mapping && tool === "sections_create" && reserved.operation.selectionSnapshot.target.kind === "new-story") {
      let previousId = mapping.lastOperationId;
      let receipt = null;
      const visited = new Set();
      while (previousId) {
        if (visited.has(previousId) || visited.size >= 100) throw transferError("outcome_unknown");
        visited.add(previousId);
        const previous = await operations.read(previousId);
        receipt = previous?.steps?.[step];
        if (receipt?.outcome === "complete" && receipt.remoteChangeMarker) break;
        // A closed partial transfer proves only known rejections or unattempted steps.
        // Follow its prior mapping so an existing dossier keeps its original ID.
        if (!previous?.partialAcknowledgment || (receipt && receipt.outcome !== "not-applied")) throw transferError("outcome_unknown");
        previousId = previous.mappingCheck.expectedMappingOperationId;
        receipt = null;
      }
      mapping = receipt ? { ...mapping, externalId: receipt.remoteIdentity, lastRemoteRevision: receipt.remoteChangeMarker } : null;
    }
    const update = !!mapping && tool !== "assets_import_from_url";
    const actualTool = update ? { stories_create: "stories_update", sections_create: "sections_update" }[tool] : tool;
    const actualArgs = update ? { ...parsed, ...(tool === "stories_create" ? { storyId: mapping.externalId } : { sectionId: mapping.externalId }) } : parsed;
    const marked = validateArguments(actualTool, markedArguments(actualTool, actualArgs, operationId));
    const payloadHash = contentHash(JSON.stringify(Object.entries(marked).filter(([field]) => field !== "url").sort(([a], [b]) => a.localeCompare(b))));
    const previous = reserved.operation.steps[step];
    if (previous && (previous.tool !== actualTool || previous.payloadHash !== payloadHash)) throw transferError("selection_changed");
    return { step, tool, parsed, mapping, update, actualTool, marked, payloadHash, previous };
  }

  async function recordPrewriteFailure(plan, operations, fence, errorCode, remoteRevision = null) {
    const conflict = errorCode === "remote_conflict";
    const operation = await operations.advance({ ...fence, unstartedStep: plan.step,
      event: conflict ? "confirmed_conflict" : "confirmed_failure", errorCode,
      ...(conflict ? { conflict: { localRevision: plan.payloadHash, remoteRevision: remoteRevision ?? "unavailable" } } : {}) });
    const step = operation.steps[plan.step];
    if (step?.outcome === "complete") return { state: "complete", remoteIdentity: step.remoteIdentity,
      remoteChangeMarker: step.remoteChangeMarker, recovered: true };
    if (step?.outcome === "unknown") return null;
    return { state: operation.state, errorCode: operation.errorCode };
  }

  async function checkRemoteRevision(plan, operations, fence) {
    if (!plan.update || (plan.previous && plan.previous.outcome !== "not-applied")) return null;
    let current;
    try { current = await observe(plan.actualTool, plan.marked, plan.mapping.externalId); }
    catch (error) {
      const errorCode = ["outcome_unknown", "transient_failure"].includes(error.code) ? "transient_failure" : error.code;
      return recordPrewriteFailure(plan, operations, fence, errorCode);
    }
    if (!plan.mapping.lastRemoteRevision) return recordUnknown(operations, fence);
    if (current.revision === plan.mapping.lastRemoteRevision) return null;
    return recordPrewriteFailure(plan, operations, fence, "remote_conflict", current.revision);
  }

  async function applyStep(plan, intent, operations, fence) {
    if (intent.priorOutcome === "complete") return { state: "complete", remoteIdentity: intent.step.remoteIdentity, recovered: true };
    try {
      if (!plan.update) return await create({ operationId: fence.operationId, step: plan.step, tool: plan.tool,
        arguments: plan.parsed, priorOutcome: intent.priorOutcome });
      if (intent.priorOutcome === "not-attempted") await invoke(plan.actualTool, plan.marked);
      return { state: "complete", remoteIdentity: plan.mapping.externalId, recovered: intent.priorOutcome === "unknown" };
    } catch (error) {
      if (error.code === "outcome_unknown") return plan.update ?
        { state: "complete", remoteIdentity: plan.mapping.externalId, recovered: true } : unsettled();
      await operations.finishStep({ ...fence, step: plan.step, outcome: "not-applied", errorCode: error.code });
      if (error.code === "remote_conflict") {
        // A rejected write supplies no remote revision; retain the step's payload hash.
        await operations.advance({ ...fence, event: "confirmed_conflict", errorCode: "remote_conflict",
          conflict: { localRevision: plan.payloadHash, remoteRevision: "unavailable" } });
        return { state: "conflict", errorCode: "remote_conflict" };
      }
      await operations.advance({ ...fence, event: "confirmed_failure", errorCode: error.code });
      return { state: "failed", errorCode: error.code };
    }
  }

  async function confirmStep(plan, result, operations, fence) {
    if (["failed", "conflict"].includes(result.state)) return result;
    if (result.state !== "complete") return recordUnknown(operations, fence);
    const receipt = { ...fence, step: plan.step, outcome: "complete", remoteIdentity: result.remoteIdentity };
    // Save create success before a subsequent read can fail or the worker can stop.
    if (!plan.update) await operations.finishStep(receipt);
    if (plan.tool === "assets_import_from_url") return { ...result, remoteChangeMarker: null };
    let observed;
    try { observed = await observe(plan.actualTool, plan.marked, result.remoteIdentity); }
    catch { return recordUnknown(operations, fence); }
    if (!observed.matches) return recordUnknown(operations, fence);
    await operations.finishStep({ ...receipt, remoteChangeMarker: observed.revision });
    return { ...result, remoteChangeMarker: observed.revision };
  }

  // One durable provider step. Callers still own preparation, sequencing and final completion.
  async function writeStep({ operations, operationId, attemptId, step, tool, arguments: args, expectedMappingOperationId = null }) {
    requireOperationId(operationId);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(step ?? "") ||
        !["stories_create", "sections_create", "assets_import_from_url"].includes(tool)) throw transferError("invalid_request");
    const parsed = validateArguments(tool, args);
    const fence = { operationId, attemptId };
    const reserved = await operations.reserveMapping({ ...fence, expectedMappingOperationId });
    if (reserved.operation.state === "conflict") return { state: "conflict", errorCode: "remote_conflict" };
    let plan;
    try { plan = await planStep(reserved, step, tool, parsed, operationId, operations); }
    catch (error) {
      if (!["invalid_request", "selection_changed"].includes(error.code)) throw error;
      await operations.advance({ ...fence, unstartedStep: step, event: "confirmed_failure", errorCode: error.code });
      throw error;
    }
    const previous = plan.previous;
    if (previous?.outcome === "complete" && (previous.remoteChangeMarker || tool === "assets_import_from_url")) {
      return { state: "complete", remoteIdentity: previous.remoteIdentity, remoteChangeMarker: previous.remoteChangeMarker, recovered: true };
    }
    const conflict = await checkRemoteRevision(plan, operations, fence);
    if (conflict) return conflict;
    const preImportAssetIds = tool === "assets_import_from_url" && !previous ? await assetIds(parsed.storyId) : previous?.preImportAssetIds ?? null;
    const intent = await operations.beginStep({ ...fence, step, tool: plan.actualTool, storyId: plan.marked.storyId ?? null,
      payloadHash: plan.payloadHash, preImportAssetIds });
    const result = await applyStep(plan, intent, operations, fence);
    return confirmStep(plan, result, operations, fence);
  }

  return { call, create, lookup, writeStep };
}

module.exports = { ENDPOINT, APPROVED_TOOLS, READ_TOOLS, WRITE_TOOLS, transferMarker, contentHash, transcriptHtml, createStorydeskClient };
