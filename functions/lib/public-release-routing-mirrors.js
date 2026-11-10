"use strict";
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const view = require("./public-release-pair-view");
const changes = require("./public-release-change-log");
const codec = require("./public-release-routing-mirror-codec");
const bytes = require("./public-release-view-read");
const sourceBody = require("./public-release-source-body");
const { assertPublicationDatabase, publicationTarget } = require("./publication-target");
const LEASE_MS = 300_000;
const RENEW_AFTER_MS = 30_000;
const READ_LIMIT = 500;
const fail = () => { throw new codec.RoutingMirrorError(); };
const normalize = value => JSON.parse(JSON.stringify(value));
const visible = document => require("./public-video-references").publiclyVisible(document);
function trackedReads(original) {
  let count = 0; const docs = new Map();
  const bill = rows => { count += rows; if (count > READ_LIMIT) throw new codec.RoutingMirrorError("authority-budget-exceeded"); };
  const docKey = ref => typeof ref?.path === "string" && ref.path.split("/").length % 2 === 0 ? ref.path : null;
  const transaction = new Proxy(original, { get(target, name) {
    if (name === "get") return async ref => {
      const key = docKey(ref); if (key && docs.has(key)) return docs.get(key);
      const row = await target.get(ref); bill(Number.isSafeInteger(row.size) ? Math.max(1, row.size) : 1);
      if (key) docs.set(key, row); return row;
    };
    if (name === "getAll") return async (...refs) => {
      if (refs.some(ref => !docKey(ref))) { const rows = await target.getAll(...refs); bill(rows.length); return rows; }
      const missing = [...new Map(refs.filter(ref => !docs.has(ref.path)).map(ref => [ref.path, ref])).values()];
      if (missing.length) { const rows = await target.getAll(...missing); bill(rows.length); rows.forEach((row, index) => docs.set(missing[index].path, row)); }
      return refs.map(ref => docs.get(ref.path));
    };
    const value = Reflect.get(target, name, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { transaction, count: () => count };
}
function authorityScope(root, pair, control, head, cursor) {
  const pointer = { ...p.parseVersionedPublicDeployment(root) }; delete pointer.updatedAt;
  return p.publicReleaseDigest({ pointer, pair, control, head, cursor });
}
function routeReceipt(family, id, state, canonicalPath, path, ownerPath, document, original = state) {
  return { kind: state.visible ? family === "record" || path === canonicalPath || path === "/_home-sources.json" ? "serve" : "redirect" : "gone",
    family, id, operationId: state.operationId, sourceVersion: state.sourceVersion,
    snapshotDigest: state.snapshotDigest ?? require("./no-build-page-ownership").digest(document.published), canonicalPath, ownerPath,
    ...(family === "post" ? { sourcePath: `cmsPosts/${id}`, sourceDigest: p.publicReleaseDigest(normalize({ published: document.published, publiclyVisible: visible(document) })) } : {}),
    owner: sourceBody.publicReleaseAuthorityDocument(ownerPath, original) };
}
async function ownedRoutes(firestore, transaction) {
  const pages = require("./no-build-page-ownership"), posts = require("./no-build-post-ownership"), records = require("./no-build-record-ownership");
  const [pageRows, postRows, recordRows, legacy, pageClaims, recordClaims] = await Promise.all([
    transaction.get(firestore.collection(pages.PAGE_OWNER_COLLECTION).limit(501)),
    transaction.get(firestore.collection(posts.OWNER_COLLECTION).limit(501)),
    transaction.get(firestore.collection(records.RECORD_OWNER_COLLECTION).limit(501)),
    transaction.get(firestore.doc(posts.LEGACY_STATE_PATH)),
    transaction.get(firestore.collection(pages.PAGE_ROUTE_COLLECTION).limit(501)),
    transaction.get(firestore.collection(records.RECORD_ROUTE_COLLECTION).limit(501)),
  ]);
  const paths = new Map(), ids = new Set();
  const claimMaps = [pageClaims, recordClaims].map(rows => new Map(rows.docs.map(row => {
    const value = row.data(); if (!codec.routePath(value.path) && !(value.path === "/_home-sources.json" && value.pageId === "home" && value.schemaVersion === 1)) fail();
    return [value.path, value];
  })));
  const add = (family, id, state, owned, canonical, ref, document, original = state) => {
    const key = `${family}:${id}`; if (ids.has(key)) fail(); ids.add(key);
    for (const path of owned) {
      if (path === "/_home-sources.json") continue;
      if (!codec.routePath(path) || paths.has(path)) fail();
      if (family !== "post") {
        const claim = claimMaps[family === "page" ? 0 : 1].get(path);
        if (claim?.schemaVersion !== 1 || claim.path !== path || (family === "page" ? claim.pageId !== id : claim.documentId !== id || claim.family !== state.family)) fail();
      }
      paths.set(path, routeReceipt(family, id, state, canonical, path, ref, document, original));
    }
  };
  for (const row of pageRows.docs) {
    const state = pages.validateNoBuildPageState(row.data()); if (!state || state.pageId !== row.id) fail();
    const document = (await transaction.get(firestore.doc(`cmsPages/${state.pageId}`))).data(); pages.assertPageOwnerSnapshot(state, document);
    add("page", state.pageId, state, state.ownedPaths, state.path, row.ref.path, document);
  }
  const legacyState = posts.validateState(legacy.data());
  for (const row of [...postRows.docs, ...(legacyState ? [legacy] : [])]) {
    const original = posts.validateState(row.data()); if (!original || row !== legacy && original.postId !== row.id) fail();
    const document = (await transaction.get(firestore.doc(`cmsPosts/${original.postId}`))).data();
    const current = await require("./no-build-post-static-return").currentStaticInput({ firestore, transaction, state: original });
    const state = { ...original, sourceVersion: current.sourceVersion, visible: current.visible, slug: current.slug,
      ownedSlugs: current.ownedSlugs, snapshotDigest: pages.digest(document.published) };
    if (original.mode !== "static" && original.snapshotDigest && original.snapshotDigest !== state.snapshotDigest) fail();
    add("post", state.postId, state, state.ownedSlugs.map(slug => `/posts/${slug}/`), `/posts/${state.slug}/`, row.ref.path, document, original);
  }
  for (const row of recordRows.docs) {
    const state = records.validateNoBuildRecordState(row.data()); if (!state || state.documentId !== row.id) fail();
    const document = (await transaction.get(firestore.doc(`cmsPosts/${state.documentId}`))).data(); records.assertRecordOwnerSnapshot(state, document);
    add("record", state.documentId, state, state.ownedPaths, state.canonicalPath, row.ref.path, document);
  }
  for (const map of claimMaps) for (const path of map.keys()) if (path !== "/_home-sources.json" && !paths.has(path)) fail();
  return paths;
}
async function stagedLocator({ firestore, transaction, pair, locator, sequence }) {
  codec.locator(locator, pair);
  const record = (await transaction.get(firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/views/${locator.manifestDigest}`))).data();
  if (!record || record.schemaVersion !== 2 || record.status !== "staged" || record.pairDigest !== locator.pairDigest ||
      record.manifestDigest !== locator.manifestDigest || !codec.same(record.identity, locator.identity) || record.claimDigest !== locator.claimDigest ||
      record.manifestBytes !== locator.manifestBytes || record.taskId !== p.publicReleaseDigest(locator.identity) ||
      record.cursor?.sequence !== locator.identity.contextSequence || record.cursor.sequence > sequence ||
      record.manifestKey !== `${view.publicReleasePairViewPrefix(pair, locator.identity, locator.claimDigest)}views/${locator.manifestDigest}.json`) fail();
  return record;
}
async function targetProof({ firestore, transaction, pair, ref, stage, route, path }) {
  if (route.kind !== "serve" || path === "/_home-sources.json") return null;
  const proof = (await transaction.get(firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/renderTargets/${ref.manifestDigest}`))).data();
  if (!proof || proof.schemaVersion !== 1 || proof.status !== "staged" || proof.pairDigest !== ref.pairDigest ||
      !codec.same(proof.identity, ref.identity) || proof.taskId !== stage.taskId || proof.claimDigest !== ref.claimDigest ||
      proof.viewManifestDigest !== ref.manifestDigest || proof.inputManifestDigest !== ref.identity.inputManifestDigest ||
      proof.snapshotDigest !== ref.identity.snapshotDigest || !codec.same(proof.cursor, stage.cursor) || !Number.isSafeInteger(proof.targetCount) || proof.targetCount < 1) fail();
  p.exact(proof.descriptor, ["digest", "key", "bytes"]);
  if (!p.digest(proof.descriptor.digest) || !Number.isSafeInteger(proof.descriptor.bytes) || proof.descriptor.bytes < 1 ||
      proof.descriptor.bytes > view.VIEW_ROOT_BYTES_LIMIT || proof.descriptor.key !== view.publicReleasePairViewObjectKey(pair, ref.identity, ref.claimDigest, proof.descriptor.digest)) fail();
  return proof.descriptor;
}
/** Actual SDK census; cached document snapshots remain in the SAME read-only
 * transaction and the500 budget counts every real SDK document/query read. */
async function collectPublicReleaseRoutingMirrors({ firestore, pairs: rawPairs, indexes, priorNamespaces, fallbackPaths = [], minimumSequence = 0, signal }) {
  const pairs = rawPairs.map(p.parsePublicReleasePair); if (!pairs.length || pairs.length > 2 || pairs.some(pair => pair.environment !== pairs[0].environment)) fail();
  for (const pair of pairs) work.assertPrivatePairResources(pair);
  assertPublicationDatabase(firestore, publicationTarget(pairs[0].environment));
  if (!Array.isArray(fallbackPaths) || fallbackPaths.length > 100_000 || fallbackPaths.some(path => !codec.routePath(path))) fail();
  const replay = require("./public-release-serving-replay"), prepared = [];
  for (const pair of pairs) { try { prepared.push(await replay.prepareComposedPairRead({ firestore, pair })); } catch { prepared.push(null); } }
  signal?.throwIfAborted();
  return firestore.runTransaction(async original => {
    const tracker = trackedReads(original), transaction = tracker.transaction;
    const [root, log, ...pairRows] = await transaction.getAll(firestore.doc("system/publicDeployment"), firestore.doc("system/publicReleaseChanges"),
      ...pairs.flatMap(pair => { const base = work.publicReleasePairPath(pair.pairId); return [firestore.doc(base), firestore.doc(`${base}/controls/runtime`), firestore.doc(`${base}/heads/current`)]; }));
    const pointer = p.parseVersionedPublicDeployment(root.data()), head = changes.parsePublicReleaseChangeHead(log.data());
    if (pointer.state !== "idle" || head.sequence < minimumSequence) fail();
    const cursor = { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest };
    const owned = await ownedRoutes(firestore, transaction), result = [];
    for (const [index, pair] of pairs.entries()) {
      const base = work.publicReleasePairPath(pair.pairId), [stored, control, row] = pairRows.slice(index * 3, index * 3 + 3).map(value => value.data());
      if (!codec.same(p.parsePublicReleasePair(stored), pair) || control?.schemaVersion !== 2 || control.pairId !== pair.pairId || !["candidate", "retained", "retired"].includes(control.status)) fail();
      const candidates = new Set([...owned.keys(), ...fallbackPaths, ...(priorNamespaces[index]?.routes.map(route => route.path) ?? [])]);
      for (const member of indexes[index]?.members ?? []) if (["fallbackAsset", "wiki"].includes(member.family) && !member.dynamic && member.path.endsWith("/index.html")) candidates.add(member.path.slice(0, -10));
      const routes = [], selectedViews = new Map(); let proof = null;
      const contentHead = row?.contentHead;
      const readyHead = row?.schemaVersion === 2 && row.pairDigest === p.publicReleaseDigest(pair) && contentHead?.pairId === pair.pairId && contentHead.contextSequence === head.sequence;
      if (readyHead && prepared[index] && codec.same(prepared[index].contentHead, contentHead) && codec.same(prepared[index].changes, head)) {
        try { proof = await prepared[index].readWitness({ firestore, transaction, pair, headCursor: cursor, witnessDigest: contentHead.viewId }); }
        catch (error) { if (error instanceof codec.RoutingMirrorError && error.code === "authority-budget-exceeded") throw error; proof = null; }
      }
      for (const path of [...candidates].sort()) {
        if (!codec.routePath(path)) fail(); const route = owned.get(path) ?? { kind: "unowned" };
        let current = null;
        if (readyHead && control.status === "retained" && !["gone", "redirect"].includes(route.kind)) {
          try {
            const direct = (await transaction.get(firestore.doc(`${base}/views/${contentHead.manifestDigest}`))).data();
            let composition = null, locator;
            if (direct?.status === "staged") locator = { pairDigest: direct.pairDigest, identity: direct.identity, claimDigest: direct.claimDigest,
              manifestDigest: direct.manifestDigest, manifestBytes: direct.manifestBytes };
            else if (proof) {
              composition = await replay.readComposedPairArtifactInTransaction({ firestore, transaction, pair, contentHead, changes: head, path,
                readWitness: async options => { for (const ref of options.selectedViews ?? []) selectedViews.set(p.publicReleaseDigest(ref), ref); return proof; } });
              locator = composition.locator;
            }
            if (locator && !composition?.absent) {
              const stage = await stagedLocator({ firestore, transaction, pair, locator, sequence: head.sequence });
              const proofLocator = composition?.proofLocator ?? locator;
              const proofStage = codec.same(proofLocator, locator) ? stage : await stagedLocator({ firestore, transaction, pair, locator: proofLocator, sequence: head.sequence });
              current = { locator, artifactPath: composition?.artifactPath ?? path, expectedBodyDigest: composition?.expectedBodyDigest ?? null,
                proofLocator, targetProof: await targetProof({ firestore, transaction, pair, ref: proofLocator, stage: proofStage, route, path }),
                route, path, contentHead };
            }
          } catch (error) { if (error instanceof codec.RoutingMirrorError && error.code === "authority-budget-exceeded") throw error; current = null; }
        }
        routes.push({ path, route, current });
      }
      if (proof && selectedViews.size) await prepared[index].readWitness({ firestore, transaction, pair, headCursor: cursor,
        witnessDigest: contentHead.viewId, selectedViews: [...selectedViews.values()] });
      result.push({ pair, status: control.status, routes, contentHead: contentHead ?? null,
        sourceDigest: authorityScope(root.data(), pair, control, row ?? null, cursor) });
    }
    signal?.throwIfAborted();
    return { sequence: head.sequence, cursor, pairs: result, readCount: tracker.count(),
      authorityDigest: p.publicReleaseDigest({ root: normalize(root.data()), cursor, pairs: result }) };
  }, { readOnly: true });
}
function publicHeaders(raw) {
  return Object.fromEntries(Object.entries(raw).filter(([name]) => !name.toLowerCase().startsWith("x-njpbs-") && name.toLowerCase() !== "publication-refresh"));
}
function sourceIdentity(route) { return route.kind === "unowned" ? null : Object.fromEntries(["family", "id", "operationId", "sourceVersion", "snapshotDigest"].map(key => [key, route[key]])); }
async function seedPublicReleaseRoutingCodeAssets({ store, pair: rawPair, index, dryRun = true, signal }) {
  const pair = p.parsePublicReleasePair(rawPair), parsed = codec.parseCodeIndex(index, pair), key = `${codec.prefix(pair)}code-assets-v1.json`;
  signal?.throwIfAborted(); const prior = await codec.existingJson(store, key);
  if (!dryRun) await codec.writeJson(store, key, parsed, prior, true);
  return { dryRun, pairDigest: p.publicReleaseDigest(pair), indexDigest: p.publicReleaseDigest(parsed) };
}
async function syncPublicReleaseRoutingMirrors({ firestore, store, pairs, operationId, minimumSequence, fallbackPaths = [], dryRun = true, now = Date.now, signal,
  collect = collectPublicReleaseRoutingMirrors }) {
  if (typeof operationId !== "string" || !Number.isSafeInteger(minimumSequence) || minimumSequence < 0) fail();
  pairs = pairs.map(p.parsePublicReleasePair); const indexes = [], priorNamespaces = [];
  for (const pair of pairs) {
    try { indexes.push(codec.parseCodeIndex(await codec.readJson(store, `${codec.prefix(pair)}code-assets-v1.json`), pair)); } catch { indexes.push(null); }
    try { priorNamespaces.push(codec.parseNamespace(await codec.readJson(store, `${codec.prefix(pair)}namespace-v1.json`), pair, 0)); } catch { priorNamespaces.push(null); }
  }
  const before = await collect({ firestore, pairs, indexes, priorNamespaces, fallbackPaths, minimumSequence, signal });
  const records = [], receipts = [], writes = [];
  for (const [index, pair] of pairs.entries()) {
    const state = before.pairs[index], routes = [], pendingContent = [], expiresAt = now() + LEASE_MS;
    if (!codec.same(state.pair, pair)) fail();
    for (const entry of state.routes) {
      const { path, route, current } = entry;
      if (route.kind === "gone" || route.kind === "redirect") {
        routes.push({ path, state: route.kind === "gone" ? "gone" : "redirect", canonicalPath: route.canonicalPath, body: null }); continue;
      }
      let body = null;
      if (current) {
        try {
          signal?.throwIfAborted();
          const output = await bytes.readPublicReleasePairOutput({ store, pair, locator: current.locator, path: current.artifactPath });
          if (!output || current.expectedBodyDigest && current.expectedBodyDigest !== output.bodyDigest) fail();
          if (route.kind === "unowned" && [308, 410].includes(output.status)) {
            routes.push({ path, state: output.status === 410 ? "gone" : "redirect", canonicalPath: output.headers.location ?? path, body: null }); continue;
          }
          if (output.status !== 200) fail();
          let proofOutput = output;
          // An owned equal-byte baseline needs its current H/target proof.
          // Unowned static code-pack HTML (including Wiki) is already sealed
          // by the actual certified baseline G and may not be in head G.
          if (route.kind === "serve" && !codec.same(current.proofLocator, current.locator)) {
            proofOutput = await bytes.readPublicReleasePairOutput({ store, pair, locator: current.proofLocator, path });
            if (!proofOutput || proofOutput.status !== output.status || proofOutput.bytes !== output.bytes || proofOutput.bodyDigest !== output.bodyDigest ||
                !codec.same(publicHeaders(proofOutput.headers), publicHeaders(output.headers)) || !Buffer.from(proofOutput.body).equals(Buffer.from(output.body))) fail();
          }
          if (route.kind === "serve" && !await bytes.verifyPairRouteTarget({ store, pair,
            decision: { ...current, composition: { proofLocator: current.proofLocator } }, output: proofOutput })) fail();
          body = { locator: current.locator, artifactPath: current.artifactPath, bodyDigest: output.bodyDigest, bytes: output.bytes,
            mime: output.headers["content-type"], source: sourceIdentity(route), verifiedSequence: before.sequence, validUntil: expiresAt };
        } catch { body = null; }
      }
      if (!body) {
        pendingContent.push(path);
        const previous = priorNamespaces[index]?.routes.find(value => value.path === path && value.state === "fallback")?.body;
        if (previous && previous.validUntil > now()) body = previous; // Never refresh a stale body's original lease.
      }
      routes.push({ path, state: "fallback", canonicalPath: route.kind === "unowned" ? path : route.canonicalPath, body });
    }
    const namespace = codec.parseNamespace({ schemaVersion: 2, pairDigest: p.publicReleaseDigest(pair), revision: before.sequence + 1,
      validUntil: expiresAt, sourceDigest: state.sourceDigest, routes }, pair, now());
    records.push({ namespace, lifecycle: { schemaVersion: 1, pairDigest: namespace.pairDigest, status: state.status, validUntil: expiresAt } });
    receipts.push({ pairDigest: namespace.pairDigest, revision: namespace.revision, pendingContent,
      namespaceDigest: p.publicReleaseDigest(namespace), tombstonePaths: routes.filter(route => route.state === "gone").map(route => route.path) });
  }
  if (!dryRun) {
    try {
      for (const [index, pair] of pairs.entries()) {
        signal?.throwIfAborted(); const key = codec.prefix(pair), record = records[index];
        const prior = await codec.existingJson(store, `${key}namespace-v1.json`);
        if (prior) {
          const value = codec.parseNamespace(prior.value, pair, 0);
          if (value.revision > record.namespace.revision) fail();
          if (value.revision === record.namespace.revision) {
            const routeIdentity = route => ({ path: route.path, state: route.state, canonicalPath: route.canonicalPath });
            if (!codec.same(value.routes.map(routeIdentity), record.namespace.routes.map(routeIdentity))) fail();
            for (const previous of value.routes) {
              const next = record.namespace.routes.find(route => route.path === previous.path)?.body;
              if (previous.body && next && next.verifiedSequence < previous.body.verifiedSequence) fail();
              if (previous.body && next && next.verifiedSequence === previous.body.verifiedSequence &&
                  !codec.same([next.bodyDigest, next.bytes, next.mime, next.source],
                    [previous.body.bodyDigest, previous.body.bytes, previous.body.mime, previous.body.source])) fail();
            }
          }
        }
        writes.push({ key: `${key}namespace-v1.json`, ...(await codec.writeJson(store, `${key}namespace-v1.json`, record.namespace, prior)) });
        const lifecycle = await codec.existingJson(store, `${key}lifecycle-v1.json`, 4096);
        if (lifecycle?.value.status === "retired" && record.lifecycle.status !== "retired") fail();
        await codec.writeJson(store, `${key}lifecycle-v1.json`, record.lifecycle, lifecycle);
      }
      const after = await collect({ firestore, pairs, indexes, priorNamespaces, fallbackPaths, minimumSequence, signal });
      if (after.authorityDigest !== before.authorityDigest) fail();
    } catch (error) {
      // Expire only our own still-current writes, never a newer writer's data.
      for (const written of writes) await codec.writeJson(store, written.key, { ...written.value, validUntil: 1 }, written).catch(() => {});
      throw error;
    }
  }
  return { schemaVersion: 1, dryRun, operationId, sequence: before.sequence, authorityDigest: before.authorityDigest, pairs: receipts };
}
module.exports = { collectPublicReleaseRoutingMirrors, syncPublicReleaseRoutingMirrors, seedPublicReleaseRoutingCodeAssets,
  ROUTING_MIRROR_LEASE_MS: LEASE_MS, ROUTING_MIRROR_RENEW_AFTER_MS: RENEW_AFTER_MS };

/** Metadata-only heartbeat: renew only an unchanged actual source/capsule and
 * already-current bodies. No old editorial body gets a new lease on trust. */
async function renewPublicReleaseRoutingMirrorLeases({ firestore, store, pairs, now = Date.now, signal }) {
  pairs = pairs.map(p.parsePublicReleasePair); if (!pairs.length || pairs.length > 2) fail();
  assertPublicationDatabase(firestore, publicationTarget(pairs[0].environment));
  const read = () => firestore.runTransaction(async transaction => {
    const [root, log, ...rows] = await transaction.getAll(firestore.doc("system/publicDeployment"), firestore.doc("system/publicReleaseChanges"),
      ...pairs.flatMap(pair => { const base = work.publicReleasePairPath(pair.pairId); return [firestore.doc(base), firestore.doc(`${base}/controls/runtime`), firestore.doc(`${base}/heads/current`)]; }));
    const head = changes.parsePublicReleaseChangeHead(log.data()), cursor = { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest };
    return pairs.map((pair, index) => { const [stored, control, selected] = rows.slice(index * 3, index * 3 + 3).map(row => row.data());
      if (!codec.same(p.parsePublicReleasePair(stored), pair) || control?.status !== "retained") fail();
      return { pair, sequence: head.sequence, sourceDigest: authorityScope(root.data(), pair, control, selected ?? null, cursor) };
    });
  }, { readOnly: true });
  let before; const written = []; let pending = false;
  try {
    before = await read();
    for (const state of before) {
      signal?.throwIfAborted(); const prefix = codec.prefix(state.pair);
      const prior = await codec.existingJson(store, `${prefix}namespace-v1.json`);
      if (!prior) { pending = true; continue; } let namespace;
      try { namespace = codec.parseNamespace(prior.value, state.pair, now()); }
      catch { pending = true; continue; }
      if (namespace.revision !== state.sequence + 1 || namespace.sourceDigest !== state.sourceDigest ||
          namespace.routes.some(route => route.state === "fallback" && (!route.body || route.body.verifiedSequence !== state.sequence || route.body.validUntil <= now()))) { pending = true; continue; }
      const lifecycle = await codec.existingJson(store, `${prefix}lifecycle-v1.json`, 4096);
      if (lifecycle?.value.status !== "retained" || lifecycle.value.pairDigest !== p.publicReleaseDigest(state.pair) || lifecycle.value.validUntil <= now()) { pending = true; continue; }
      if (namespace.validUntil - now() > LEASE_MS - RENEW_AFTER_MS) continue;
      const validUntil = now() + LEASE_MS;
      const next = { ...namespace, validUntil, routes: namespace.routes.map(route => ({ ...route,
        body: route.body ? { ...route.body, validUntil } : null })) };
      written.push({ key: `${prefix}namespace-v1.json`, prior, ...await codec.writeJson(store, `${prefix}namespace-v1.json`, next, prior) });
      written.push({ key: `${prefix}lifecycle-v1.json`, prior: lifecycle,
        ...await codec.writeJson(store, `${prefix}lifecycle-v1.json`, { ...lifecycle.value, validUntil }, lifecycle) });
    }
    if (!codec.same(before, await read())) fail();
    return { state: pending ? "pending" : "renewed", pairs: before.map(state => ({ pairDigest: p.publicReleaseDigest(state.pair), sequence: state.sequence })) };
  } catch {
    // A failed extension must preserve the originally verified remaining
    // lease. Conditional rollback cannot overwrite a newer publication.
    for (const value of written.reverse()) await codec.writeJson(store, value.key, value.prior.value, value).catch(() => {});
    return { state: "pending" };
  }
}
module.exports.renewPublicReleaseRoutingMirrorLeases = renewPublicReleaseRoutingMirrorLeases;
