/// <reference path="./admin-import-meta.d.ts" />
// Content operations (#4716): compose one Boardwalk save from a schema 1 ops file with the
// editor's own reducer and request builder. Pure: the caller loads the draft and sends the
// request. cmsSaveContent still authorizes, validates, and writes history and audit rows.
import { blockEditorReducer, initialBlockEditorState, type BlockEditorAction, type BlockEditorState } from "../../admin/src/lib/block-editor-state";
import { createBlock, type AdminBlock } from "../../admin/src/lib/block-factory";
import { editableBlocksForPublicPage } from "../../admin/src/lib/public-page-block-ownership";
import { pageBlocksSaveRequest, recordSaveRequest, storedPageContentFromDocument } from "../../admin/src/lib/content-save-request";
import { BLOCK_TYPES, type BlockType } from "../../packages/content-core/src/content-model";
import { publicPage, type PublicPageId } from "../../packages/content-core/src/public-pages";
import { insertableBlocksForSection, type SectionId } from "../../packages/content-core/src/editor-admin";
import { normalizeStoryCredits, resolveStoryCredits } from "../../packages/content-core/src/story-credits";

export const MAX_CONTENT_OPS = 100;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REF_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const BLOCK_TYPE_SET = new Set<string>(BLOCK_TYPES);

export class ContentOpsError extends Error {
  constructor(readonly status: number, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

// "publish-dry-run" checks a publish and returns the digest that publish must repeat.
export type ContentOpsMode = "dry-run" | "apply" | "publish-dry-run" | "publish";

export interface Destination {
  rowId?: string;
  column?: number;
  beforeId?: string;
}

export type ContentOp =
  | { op: "insert"; ref?: string; type: BlockType; data?: Record<string, unknown>; destination?: Destination }
  | { op: "move"; id: string; destination: Destination }
  | { op: "remove"; id: string }
  | { op: "split"; id: string; columns: number[] }
  | { op: "setData"; id: string; data: Record<string, unknown>; unset?: string[] }
  | { op: "setVisible"; id: string; visible: boolean }
  | { op: "setCredits"; credits: unknown[] };

export interface ContentOpsRequest {
  schema: 1;
  mode: ContentOpsMode;
  collection: "cmsPages" | "cmsPosts";
  id: string;
  baseVersion: number;
  requestReference: string;
  expectDigest?: string;
  ops: ContentOp[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasOnly(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function parseDestination(value: unknown, index: number): Destination {
  if (value === undefined) return {};
  if (!isPlainObject(value) || !hasOnly(value, ["rowId", "column", "beforeId"]) ||
      (value.rowId !== undefined && typeof value.rowId !== "string") ||
      (value.column !== undefined && !Number.isSafeInteger(value.column)) ||
      (value.beforeId !== undefined && typeof value.beforeId !== "string") ||
      ((value.rowId === undefined) !== (value.column === undefined))) {
    throw new ContentOpsError(400, `Operation ${index + 1}: a destination names rowId and column together, and may name beforeId.`);
  }
  return value as Destination;
}

function parseOp(value: unknown, index: number, collection: ContentOpsRequest["collection"]): ContentOp {
  const fail = (message: string): never => { throw new ContentOpsError(400, `Operation ${index + 1}: ${message}`); };
  if (!isPlainObject(value) || typeof value.op !== "string") return fail("each operation is an object with an op.");
  const id = (): string => (typeof value.id === "string" && value.id !== "" ? value.id : fail("id must name a block."));
  if (collection === "cmsPosts" && value.op !== "setCredits") return fail("Posts accept only setCredits in this version.");
  if (collection === "cmsPages" && value.op === "setCredits") return fail("Pages have no credits.");
  switch (value.op) {
    case "insert":
      if (!hasOnly(value, ["op", "ref", "type", "data", "destination"])) return fail("insert takes ref, type, data and destination.");
      if (typeof value.type !== "string" || !BLOCK_TYPE_SET.has(value.type)) return fail("type must be a block type.");
      if (value.ref !== undefined && (typeof value.ref !== "string" || !REF_PATTERN.test(value.ref))) return fail("ref must be a short lowercase name.");
      if (value.data !== undefined && !isPlainObject(value.data)) return fail("data must be an object.");
      return { op: "insert", type: value.type as BlockType, ref: value.ref as string | undefined,
        data: value.data as Record<string, unknown> | undefined, destination: parseDestination(value.destination, index) };
    case "move":
      if (!hasOnly(value, ["op", "id", "destination"])) return fail("move takes id and destination.");
      return { op: "move", id: id(), destination: parseDestination(value.destination, index) };
    case "remove":
      if (!hasOnly(value, ["op", "id"])) return fail("remove takes id.");
      return { op: "remove", id: id() };
    case "split":
      if (!hasOnly(value, ["op", "id", "columns"]) || !Array.isArray(value.columns) ||
          !value.columns.every(width => Number.isSafeInteger(width))) return fail("split takes id and integer column widths.");
      return { op: "split", id: id(), columns: value.columns as number[] };
    case "setData":
      // `unset` removes optional fields, as the editor does when it clears a value.
      if (!hasOnly(value, ["op", "id", "data", "unset"]) || !isPlainObject(value.data) ||
          (value.unset !== undefined && (!Array.isArray(value.unset) || value.unset.length > 20 ||
            value.unset.some(field => typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field) ||
              Object.hasOwn(value.data as object, field))))) {
        return fail("setData takes id, a data object and optional unset field names not in data.");
      }
      return { op: "setData", id: id(), data: value.data, ...(value.unset ? { unset: value.unset as string[] } : {}) };
    case "setVisible":
      if (!hasOnly(value, ["op", "id", "visible"]) || typeof value.visible !== "boolean") return fail("setVisible takes id and visible.");
      return { op: "setVisible", id: id(), visible: value.visible };
    case "setCredits":
      if (!hasOnly(value, ["op", "credits"]) || !Array.isArray(value.credits)) return fail("setCredits takes a credits list.");
      return { op: "setCredits", credits: value.credits };
    default:
      return fail("op is not supported.");
  }
}

/** Validate the request envelope and every operation before any upstream call. */
export function parseContentOpsRequest(value: unknown): ContentOpsRequest {
  const fail = (message: string): never => { throw new ContentOpsError(400, message); };
  if (!isPlainObject(value) || value.schema !== 1) return fail("Send a schema 1 content operations request.");
  if (!hasOnly(value, ["schema", "mode", "collection", "id", "baseVersion", "requestReference", "expectDigest", "ops"])) {
    return fail("The request has an unknown field.");
  }
  const mode = value.mode;
  if (mode !== "dry-run" && mode !== "apply" && mode !== "publish-dry-run" && mode !== "publish") {
    return fail("mode must be dry-run, apply, publish-dry-run or publish.");
  }
  const checking = mode === "dry-run" || mode === "publish-dry-run";
  const publishing = mode === "publish" || mode === "publish-dry-run";
  const collection = value.collection;
  if (collection !== "cmsPages" && collection !== "cmsPosts") return fail("collection must be cmsPages or cmsPosts.");
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) return fail("id must name one saved record.");
  if (!Number.isSafeInteger(value.baseVersion) || (value.baseVersion as number) < 1) return fail("baseVersion must be the saved version.");
  if (typeof value.requestReference !== "string" || !/^[\x20-\x7e]{1,200}$/.test(value.requestReference) ||
      value.requestReference.trim() !== value.requestReference) {
    return fail("requestReference must name the staff request in 1 to 200 plain characters.");
  }
  if (checking ? value.expectDigest !== undefined
    : typeof value.expectDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.expectDigest)) {
    return fail(checking ? "A dry run does not take expectDigest." : "Apply and publish require the dry-run digest.");
  }
  if (!Array.isArray(value.ops) || value.ops.length > MAX_CONTENT_OPS) return fail(`ops must list at most ${MAX_CONTENT_OPS} operations.`);
  if (publishing ? value.ops.length !== 0 : value.ops.length === 0) {
    return fail(publishing ? "Publish sends the saved version with no operations." : "List at least one operation.");
  }
  const ops = value.ops.map((op, index) => parseOp(op, index, collection));
  return { schema: 1, mode, collection, id: value.id, baseVersion: value.baseVersion as number,
    requestReference: value.requestReference, expectDigest: value.expectDigest as string | undefined, ops };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The plan digest: SHA-256 of the target, the version it starts from, the action and the
 * operations. A dry run returns it; apply and publish must repeat it, so the change that runs
 * is the change that was reviewed. The audit row records it.
 */
export async function planDigest(request: ContentOpsRequest): Promise<string> {
  const plan = { schema: 1, collection: request.collection, id: request.id, baseVersion: request.baseVersion,
    action: request.mode === "publish" || request.mode === "publish-dry-run" ? "publish" : "save", ops: request.ops };
  const bytes = new TextEncoder().encode(canonicalJson(plan));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Pages with their own conversion boundaries stay in Boardwalk (design slice 5). */
export function pageRefusal(pageId: string, stored: Record<string, unknown>): string | null {
  if (pageId === "home" || pageId === "data-hub") return "Edit this Page in Boardwalk. Its layout has its own rules.";
  if (stored.homeCompositionVersion !== undefined || stored.serviceCompositionVersion !== undefined ||
      stored.dataHubCompositionVersion !== undefined) {
    return "Edit this Page in Boardwalk. Its layout has its own rules.";
  }
  return null;
}

export interface ComposedSave {
  body: Record<string, unknown>;
  before: AdminBlock[];
  after: AdminBlock[];
}

function dispatch(section: SectionId, state: BlockEditorState, action: BlockEditorAction, index: number): BlockEditorState {
  const next = blockEditorReducer(section, state, action);
  if (next.error) throw new ContentOpsError(400, `Operation ${index + 1}: ${next.error}`);
  return next;
}

function editorDestination(destination: Destination, resolve: (id: string) => string) {
  return {
    ...(destination.rowId !== undefined ? { layout: { rowId: resolve(destination.rowId), column: destination.column! } } : {}),
    ...(destination.beforeId !== undefined ? { beforeId: resolve(destination.beforeId) } : {}),
  };
}

/** Run the ops through the editor reducer against a loaded Page draft. */
export function composePageSave(pageId: PublicPageId, stored: Record<string, unknown>, request: ContentOpsRequest): ComposedSave {
  const page = publicPage(pageId);
  if (!page) throw new ContentOpsError(400, "This Page is not in the public page registry.");
  const refusal = pageRefusal(pageId, stored);
  if (refusal) throw new ContentOpsError(409, refusal);
  const section = page.editorTemplate as SectionId;
  const storedPage = storedPageContentFromDocument(pageId, stored);
  const before = editableBlocksForPublicPage(pageId, storedPage.blocks, storedPage.homeCompositionVersion);
  let state = initialBlockEditorState(before);
  const refs = new Map<string, string>();
  const resolve = (id: string) => refs.get(id) ?? id;
  const requireBlock = (id: string, index: number) => {
    const resolved = resolve(id);
    if (!state.blocks.some(block => block.id === resolved)) {
      throw new ContentOpsError(400, `Operation ${index + 1}: block ${id} is not on the Page.`);
    }
    return resolved;
  };
  request.ops.forEach((op, index) => {
    switch (op.op) {
      case "insert": {
        // The editor palette offers only the section's insertable block types. Checking first
        // also keeps Home-only block defaults, which read Vite settings, out of the Worker.
        if (!insertableBlocksForSection(section).includes(op.type)) {
          throw new ContentOpsError(400, `Operation ${index + 1}: this Page does not take ${op.type} blocks.`);
        }
        // New blocks take temporary ids. The server mints their canonical ids on save.
        const id = `tmp-${index + 1}`;
        if (op.ref) {
          if (refs.has(op.ref)) throw new ContentOpsError(400, `Operation ${index + 1}: ref ${op.ref} is already used.`);
          refs.set(op.ref, id);
        }
        state = dispatch(section, state, { kind: "editRows", edit: { kind: "insert", block: createBlock(op.type, id),
          destination: editorDestination(op.destination ?? {}, resolve) } }, index);
        if (!state.blocks.some(block => block.id === id)) throw new ContentOpsError(400, `Operation ${index + 1}: the block was not added.`);
        if (op.data) {
          const block = state.blocks.find(candidate => candidate.id === id)!;
          state = dispatch(section, state, { kind: "setData", id, data: { ...block.data, ...op.data }, discrete: true }, index);
        }
        break;
      }
      case "move":
        state = dispatch(section, state, { kind: "editRows", edit: { kind: "move", id: requireBlock(op.id, index),
          destination: editorDestination(op.destination, resolve) } }, index);
        break;
      case "remove":
        state = dispatch(section, state, { kind: "editRows", edit: { kind: "remove", id: requireBlock(op.id, index) } }, index);
        break;
      case "split":
        state = dispatch(section, state, { kind: "editRows", edit: { kind: "split", id: requireBlock(op.id, index), columns: op.columns } }, index);
        break;
      case "setData": {
        const id = requireBlock(op.id, index);
        const block = state.blocks.find(candidate => candidate.id === id)!;
        // Row widths change only through split, which applies the editor's layout rules.
        if (block.type === "row") throw new ContentOpsError(400, `Operation ${index + 1}: change row widths with split.`);
        const data: Record<string, unknown> = { ...block.data, ...op.data };
        for (const field of op.unset ?? []) delete data[field];
        state = dispatch(section, state, { kind: "setData", id, data, discrete: true }, index);
        break;
      }
      case "setVisible":
        state = dispatch(section, state, { kind: "setVisible", id: requireBlock(op.id, index), visible: op.visible }, index);
        break;
      default:
        throw new ContentOpsError(400, `Operation ${index + 1}: Pages have no credits.`);
    }
  });
  const body = pageBlocksSaveRequest({ pageId, section, storedPage, blocks: state.blocks,
    enforcePublicPageOwnership: true, baseVersion: request.baseVersion });
  return { body, before, after: state.blocks };
}

/** Post credits ride the record request builder, as a partial record save. */
export function composePostSave(stored: Record<string, unknown>, request: ContentOpsRequest): ComposedSave {
  if (stored.type !== "post") throw new ContentOpsError(409, "Only Post credits can change through the content API.");
  let credits: unknown[] | undefined;
  for (const op of request.ops) if (op.op === "setCredits") credits = op.credits;
  const body = recordSaveRequest("post", { id: request.id, version: request.baseVersion, credits });
  return { body, before: [], after: [] };
}

// The longest run of blocks that kept their relative order. Every other surviving block moved,
// so one moved row reads as one move, not as a shift of everything after it.
function keptInOrder(before: string[], after: string[]): Set<string> {
  const lengths = before.map(() => new Array<number>(after.length + 1).fill(0));
  lengths.push(new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i][j] = before[i] === after[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const kept = new Set<string>();
  for (let i = 0, j = 0; i < before.length && j < after.length;) {
    if (before[i] === after[j]) { kept.add(before[i]); i++; j++; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }
  return kept;
}

export interface ContentChange {
  path: string;
  change: "added" | "removed" | "moved" | "widths" | "fields" | "visibility" | "credits";
  type?: string;
  fields?: string[];
}

/** A short, ordered list of what the save changes, for review before apply. */
export function summarizeChanges(collection: ContentOpsRequest["collection"], stored: Record<string, unknown>,
  composed: ComposedSave): ContentChange[] {
  if (collection === "cmsPosts") {
    // Compare what each byline shows: a legacy `author` counts as its custom credit, as the
    // save resolves it.
    const next = (composed.body.document as Record<string, unknown>).credits;
    const before = resolveStoryCredits(stored as { credits?: unknown; author?: unknown });
    const after = next === undefined ? before : normalizeStoryCredits(next).credits;
    return canonicalJson(before) === canonicalJson(after) && (next === undefined || Array.isArray(stored.credits))
      ? [] : [{ path: "/credits", change: "credits" }];
  }
  const changes: ContentChange[] = [];
  const before = new Map(composed.before.map(block => [block.id, block]));
  const after = new Map(composed.after.map(block => [block.id, block]));
  const kept = keptInOrder(composed.before.map(block => block.id).filter(id => after.has(id)),
    composed.after.map(block => block.id).filter(id => before.has(id)));
  for (const [id, block] of before) if (!after.has(id)) changes.push({ path: `/blocks/${id}`, change: "removed", type: block.type });
  composed.after.forEach(block => {
    const prior = before.get(block.id);
    if (!prior) {
      changes.push({ path: `/blocks/${block.id}`, change: "added", type: block.type });
      return;
    }
    if (!kept.has(block.id) || canonicalJson(prior.layout) !== canonicalJson(block.layout)) {
      changes.push({ path: `/blocks/${block.id}`, change: "moved", type: block.type });
    }
    if (block.type === "row" && canonicalJson(prior.data.columns) !== canonicalJson(block.data.columns)) {
      changes.push({ path: `/blocks/${block.id}/data/columns`, change: "widths", type: block.type });
    }
    const fields = Object.keys({ ...prior.data, ...block.data })
      .filter(key => !(block.type === "row" && key === "columns") && canonicalJson(prior.data[key]) !== canonicalJson(block.data[key]));
    if (fields.length) changes.push({ path: `/blocks/${block.id}/data`, change: "fields", type: block.type, fields: fields.sort() });
    if (prior.visible !== block.visible) changes.push({ path: `/blocks/${block.id}/visible`, change: "visibility", type: block.type });
  });
  return changes;
}
