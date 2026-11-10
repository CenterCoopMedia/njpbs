"use strict";

const { PUBLIC_PAGE_DEFINITIONS, publicPageDefinition } = require("./public-page-contract");
const { PUBLICLY_ROUTED_RECORD_KINDS, publicRouteBaseForRecordKind } = require("./public-record-kinds");
const { authorizeContentRead, authorizeContentWrite, contentResource, mayReachContentRead } = require("./content-authorization");

const UNAVAILABLE_MESSAGE = "This page is unavailable or you do not have permission to edit it.";

function unavailable(denialReason) {
  return Object.assign(new Error(UNAVAILABLE_MESSAGE), { status: 403, denialReason });
}

// Accept local public paths only. Never turn an input into an external redirect.
function normalizePublicPath(value) {
  if (typeof value !== "string" || value.length > 256 || !value.startsWith("/")) return null;
  if (value === "/") return value;
  const path = value.endsWith("/") ? value.slice(0, -1) : value;
  if (!path.slice(1).split("/").every(segment => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment))) return null;
  return `${path}/`;
}

function explicitTarget(type, id) {
  if (typeof id !== "string" || !id || Buffer.byteLength(id, "utf8") > 1500 || id.includes("/") || id !== id.trim() || /^(?:\.{1,2}|__.*__)$/.test(id)) return null;
  if (type === "home") return id === "home" ? { collection: "cmsPages", id, type } : null;
  if (type === "page") return id !== "home" && publicPageDefinition(id) ? { collection: "cmsPages", id, type } : null;
  return PUBLICLY_ROUTED_RECORD_KINDS.includes(type) ? { collection: "cmsPosts", id, type } : null;
}

function pathLookup(path) {
  for (const type of PUBLICLY_ROUTED_RECORD_KINDS) {
    const base = publicRouteBaseForRecordKind(type);
    if (path.startsWith(base) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path.slice(base.length, -1))) {
      return { collection: "cmsPosts", type, slug: path.slice(base.length, -1) };
    }
  }
  if (path === "/") return { collection: "cmsPages", type: "home", id: "home" };
  if (!/^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path)) return null;
  const canonical = path === "/donate/" ? "/give/" : path === "/public-meetings/" ? "/meeting-notices/" : path;
  const id = Object.entries(PUBLIC_PAGE_DEFINITIONS).find(([, page]) => page.path === canonical)?.[0];
  return { collection: "cmsPages", type: "page", slug: path.slice(1, -1), id };
}

async function snapshotForPath(firestore, path) {
  const lookup = pathLookup(path);
  if (!lookup) throw unavailable("unsupported-path");
  const records = firestore.collection(lookup.collection);
  if (!lookup.slug) return { ...lookup, snapshot: await records.doc(lookup.id).get() };
  // Published routing survives a draft rename. Queries are bounded and require
  // only single-field indexes; no content listing or new index is needed.
  const results = await Promise.all([
    records.where("published.metadata.slug", "==", lookup.slug).limit(2).get(),
    records.where("published.metadata.previousSlugs", "array-contains", lookup.slug).limit(2).get(),
  ]);
  const candidates = new Map(results.flatMap(result => result.docs).map(snapshot => [snapshot.id, snapshot]));
  if (candidates.size > 1) throw unavailable("ambiguous-path");
  const snapshot = [...candidates.values()][0] ?? (lookup.id ? await records.doc(lookup.id).get() : null);
  if (!snapshot) throw unavailable("target-missing");
  const stored = snapshot.exists ? snapshot.data() : null;
  // Built-in Pages remain public before their first CMS publication.
  if (stored && !lookup.id && (stored.publiclyVisible === false || !stored.published)) throw unavailable("target-not-published");
  return { ...lookup, id: snapshot.id, snapshot };
}

async function resolveEditorTarget({ firestore, principal, input }) {
  if (!mayReachContentRead(principal)) throw unavailable("no-content-access");
  const hasExactTarget = input.type !== undefined || input.id !== undefined;
  const exact = hasExactTarget ? explicitTarget(input.type, input.id) : null;
  if (hasExactTarget && (!exact || input.path !== undefined)) throw unavailable("invalid-target");
  const path = hasExactTarget ? null : normalizePublicPath(input.path);
  if (!hasExactTarget && !path) throw unavailable("invalid-path");
  const target = exact
    ? { ...exact, snapshot: await firestore.collection(exact.collection).doc(exact.id).get() }
    : await snapshotForPath(firestore, path);
  const stored = target.snapshot.exists ? target.snapshot.data() : null;
  if (!stored && target.collection === "cmsPages" && !PUBLIC_PAGE_DEFINITIONS[target.id]) throw unavailable("target-missing");
  if (stored?.deleted === true) throw unavailable("target-deleted");
  if (target.collection === "cmsPosts" && !stored) throw unavailable("target-missing");
  if (target.collection === "cmsPosts" && stored.type !== target.type) throw unavailable("target-type-mismatch");
  const resource = contentResource({ collection: target.collection, documentId: target.id, stored });
  const readable = authorizeContentRead(principal, { exists: target.snapshot.exists, resource });
  const editable = authorizeContentWrite(principal, {
    creating: !target.snapshot.exists, publishing: false,
    storedStatus: stored?.status, nextStatus: stored?.status ?? "draft", resource,
  });
  if (!readable.allowed) throw unavailable("read-forbidden");
  if (!editable.allowed) throw unavailable("edit-forbidden");
  return { type: target.type, id: target.id };
}

module.exports = { UNAVAILABLE_MESSAGE, normalizePublicPath, explicitTarget, resolveEditorTarget };
