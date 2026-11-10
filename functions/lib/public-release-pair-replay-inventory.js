"use strict";
const { createHash } = require("node:crypto");
const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const composite = require("./public-release-pair-composite-view");
const catalogs = require("./public-release-pair-catalog-images");
const capsules = require("./public-release-pair-replay-capsule");
const views = require("./public-release-pair-view");
const { exact, publicReleaseDigest: hash, digest, positive } = protocol;
const PAGE_SIZE = 256,
  LIMIT = 100_000;
const compare = views.comparePrivatePairArtifactPaths;
function refuse() {
  throw new protocol.PublicReleaseProtocolError();
}
function base(pair) {
  return work.publicReleasePairPath(pair.pairId);
}
function same(a, b) {
  return hash(a) === hash(b);
}
function path(value) {
  return (
    value === "/" ||
    (typeof value === "string" &&
      views.isPrivatePairArtifactPath(value.endsWith("/") ? value.slice(0, -1) : value))
  );
}
function reference(value, pair) {
  exact(value, ["identity", "claimDigest", "manifestDigest", "manifestBytes"]);
  const identity = views.parseViewIdentity(value.identity, pair);
  if (
    !digest(value.claimDigest) ||
    !digest(value.manifestDigest) ||
    !positive(value.manifestBytes) ||
    value.manifestBytes > views.VIEW_ROOT_BYTES_LIMIT
  )
    refuse();
  return {
    identity,
    claimDigest: value.claimDigest,
    manifestDigest: value.manifestDigest,
    manifestBytes: value.manifestBytes,
  };
}
async function pages(transaction, firestore, pair, category, digests) {
  if (
    !Array.isArray(digests) ||
    digests.length > 1024 ||
    !digests.every(digest) ||
    new Set(digests).size !== digests.length
  )
    refuse();
  const result = digests.length
    ? await transaction.getAll(...digests.map((id) => firestore.doc(`${base(pair)}/${category}/${id}`)))
    : [];
  return result.map((row, index) => {
    if (!row.exists || hash(row.data()) !== digests[index]) refuse();
    return row.data();
  });
}
function verifyReplayOutputReadback({ pair, reference: expected, cursor, outputs, staged }) {
  if (
    !Array.isArray(outputs) ||
    !outputs.length ||
    outputs.length > LIMIT ||
    !staged ||
    staged.schemaVersion !== 2 ||
    staged.status !== "staged" ||
    staged.pairDigest !== hash(pair) ||
    staged.manifestDigest !== expected.manifestDigest ||
    staged.manifestBytes !== expected.manifestBytes ||
    staged.claimDigest !== expected.claimDigest ||
    !same(staged.identity, expected.identity) ||
    !same(staged.cursor, cursor)
  )
    refuse();
  const proof = createHash("sha256")
    .update("private-pair-view-readback-v2\n")
    .update(expected.manifestDigest + "\n");
  const empty = createHash("sha256").update("").digest("hex");
  let previous = "",
    bytes = 0;
  const parsed = outputs.map((raw) => {
    const row = views.parsePublicReleasePairViewOutput(raw, pair, expected.identity, expected.claimDigest);
    if (
      compare(row.path, previous) <= 0 ||
      (row.status === 410 && (row.bytes !== 0 || row.bodyDigest !== empty))
    )
      refuse();
    previous = row.path;
    bytes += row.bytes;
    if (bytes > views.VIEW_TOTAL_BYTES_LIMIT) refuse();
    proof.update(
      JSON.stringify([row.path, row.status, hash(row.headers), row.bodyDigest, row.bytes, row.objectKey]) +
        "\n",
    );
    return row;
  });
  if (
    parsed.length !== staged.outputCount ||
    bytes !== staged.outputBytes ||
    proof.digest("hex") !== staged.readbackDigest
  )
    refuse();
  return parsed;
}
async function readReplayOutputInventory({
  firestore,
  transaction,
  pair,
  reference: expected,
  cursor,
  inventoryDigest,
  renderTargetProofDigest,
  requireRenderTargets = false,
}) {
  const row = await transaction.get(
    firestore.doc(`${base(pair)}/replayOutputInventories/${expected.manifestDigest}`),
  );
  const root = row.data();
  exact(root, [
    "schemaVersion",
    "pairDigest",
    "reference",
    "cursor",
    "inventoryDigest",
    "count",
    "pages",
    "renderTargetProofDigest",
    "catalogImages",
    "composite",
  ]);
  if (
    root.schemaVersion !== 2 ||
    root.pairDigest !== hash(pair) ||
    !same(root.reference, expected) ||
    !same(root.cursor, cursor) ||
    !digest(root.inventoryDigest) ||
    (inventoryDigest && root.inventoryDigest !== inventoryDigest) ||
    !positive(root.count) ||
    root.count > LIMIT
  )
    refuse();
  if (
    !(root.renderTargetProofDigest === null || digest(root.renderTargetProofDigest)) ||
    (requireRenderTargets && !digest(root.renderTargetProofDigest)) ||
    (renderTargetProofDigest && root.renderTargetProofDigest !== renderTargetProofDigest)
  )
    refuse();
  if (root.renderTargetProofDigest) {
    const target = (
      await transaction.get(firestore.doc(`${base(pair)}/renderTargets/${expected.manifestDigest}`))
    ).data();
    if (!target || hash(target) !== root.renderTargetProofDigest) refuse();
  }
  const loaded = await pages(transaction, firestore, pair, "replayOutputPages", root.pages),
    outputs = [];
  let previous = "";
  for (const [index, page] of loaded.entries()) {
    exact(page, ["schemaVersion", "pairDigest", "referenceDigest", "cursor", "index", "outputs"]);
    if (
      page.schemaVersion !== 2 ||
      page.pairDigest !== root.pairDigest ||
      page.referenceDigest !== hash(expected) ||
      !same(page.cursor, cursor) ||
      page.index !== index ||
      !Array.isArray(page.outputs) ||
      !page.outputs.length ||
      page.outputs.length > PAGE_SIZE
    )
      refuse();
    for (const raw of page.outputs) {
      if (!path(raw.path) || compare(raw.path, previous) <= 0 || outputs.length >= LIMIT) refuse();
      previous = raw.path;
      outputs.push(raw);
    }
  }
  if (outputs.length !== root.count || hash(outputs) !== root.inventoryDigest) refuse();
  const staged = (
    await transaction.get(firestore.doc(`${base(pair)}/views/${expected.manifestDigest}`))
  ).data();
  const verified = verifyReplayOutputReadback({ pair, reference: expected, cursor, outputs, staged });
  if (root.composite) {
    const payload = await capsules.readReplayNamespaceProof({ firestore, pair, descriptor: root.composite });
    if (payload.length !== 1) refuse();
    const manifest = assertReplayCompositeOutputs({
      pair,
      reference: expected,
      cursor,
      outputs: verified,
      manifest: payload[0],
    });
    await composite.assertReadPublicReleasePairCompositeInTransaction({
      firestore,
      transaction,
      pair,
      identity: expected.identity,
      claimDigest: expected.claimDigest,
      viewManifestDigest: expected.manifestDigest,
      manifest,
      manifestDigest: composite.publicReleasePairCompositeManifestDigest(manifest),
    });
  }
  return verified;
}
/** Native readback and the exact closed owner roster must describe the same
 * complete view. Unknown auxiliary rows never gain baseline-path authority. */
function assertReplayCompositeOutputs({ pair, reference, cursor, outputs, manifest: rawManifest }) {
  const manifest = composite.parsePublicReleasePairCompositeManifest(
    rawManifest,
    pair,
    reference.identity,
    cursor,
  );
  if (manifest.members.length !== outputs.length) refuse();
  for (const [index, member] of manifest.members.entries()) {
    const output = outputs[index];
    if (
      member.path !== output.path ||
      member.status !== output.status ||
      member.mime !== output.headers["content-type"] ||
      member.size !== output.bytes ||
      member.sha256 !== output.bodyDigest ||
      output.headers["x-njpbs-renderer-sha"] !== pair.commitSha
    )
      refuse();
  }
  return manifest;
}
async function readReplayCodePackInventory({ firestore, transaction, pair, codePackView, baseline }) {
  const row = await transaction.get(
      firestore.doc(`${base(pair)}/replayCodePacks/${pair.codeAssetManifestDigest}`),
    ),
    root = row.data();
  exact(root, [
    "schemaVersion",
    "pairDigest",
    "codeAssetManifestDigest",
    "codePackView",
    "sourceInputs",
    "sourceInputsDigest",
    "count",
    "pages",
  ]);
  if (
    root.schemaVersion !== 2 ||
    root.pairDigest !== hash(pair) ||
    root.codeAssetManifestDigest !== pair.codeAssetManifestDigest ||
    !same(root.codePackView, codePackView) ||
    !positive(root.count) ||
    root.count > LIMIT
  )
    refuse();
  const loaded = await pages(transaction, firestore, pair, "replayCodePackPages", root.pages),
    members = [];
  let previous = "";
  for (const [index, page] of loaded.entries()) {
    exact(page, ["schemaVersion", "pairDigest", "index", "members"]);
    if (
      page.schemaVersion !== 2 ||
      page.pairDigest !== root.pairDigest ||
      page.index !== index ||
      !Array.isArray(page.members) ||
      !page.members.length ||
      page.members.length > PAGE_SIZE
    )
      refuse();
    for (const member of page.members) {
      exact(member, ["path", "mime", "size", "sha256", "family", "source", "dynamic"]);
      if (
        !path(member.path) ||
        member.path.endsWith("/") ||
        compare(member.path, previous) <= 0 ||
        members.length >= LIMIT ||
        typeof member.mime !== "string" ||
        !member.mime ||
        !Number.isSafeInteger(member.size) ||
        member.size < 0 ||
        member.size > views.BODY_BYTES_LIMIT ||
        !digest(member.sha256) ||
        typeof member.family !== "string" ||
        !["compiled", "static", "aggregate"].includes(member.source) ||
        typeof member.dynamic !== "boolean"
      )
        refuse();
      previous = member.path;
      // This key order is owned by the source code-pack protocol.
      members.push({
        path: member.path,
        mime: member.mime,
        size: member.size,
        sha256: member.sha256,
        family: member.family,
        source: member.source,
        dynamic: member.dynamic,
      });
    }
  }
  if (
    members.length !== root.count ||
    createHash("sha256").update(JSON.stringify(members)).digest("hex") !== pair.codeAssetManifestDigest
  )
    refuse();
  exact(root.sourceInputs, [
    "schemaVersion",
    "logBaselineDigest",
    "sourceMemberCensusDigest",
    "baselineCursor",
  ]);
  const sourceInput = members.find((member) => member.path === "/_pair-compiled/pair-source-inputs.json");
  const expectedInputBytes =
    JSON.stringify({
      schemaVersion: 1,
      logBaselineDigest: baseline.logBaselineDigest,
      sourceMemberCensusDigest: baseline.sourceInventoryDigest,
      baselineCursor: {
        baselineDigest: baseline.cursor.baselineDigest,
        sequence: baseline.cursor.sequence,
        lastDigest: baseline.cursor.lastDigest,
      },
    }) + "\n";
  const expectedInputDigest = createHash("sha256").update(expectedInputBytes).digest("hex");
  if (
    !sourceInput ||
    sourceInput.size !== Buffer.byteLength(expectedInputBytes) ||
    sourceInput.sha256 !== expectedInputDigest ||
    sourceInput.sha256 !== root.sourceInputsDigest ||
    !digest(root.sourceInputsDigest) ||
    root.sourceInputs.schemaVersion !== 1 ||
    root.sourceInputs.logBaselineDigest !== baseline.logBaselineDigest ||
    root.sourceInputs.sourceMemberCensusDigest !== baseline.sourceInventoryDigest ||
    !same(root.sourceInputs.baselineCursor, baseline.cursor)
  )
    refuse();
  return new Map(members.map((member) => [member.path, member]));
}
/** Exact catalog additions keep the actual OLD catalog authority. The copied
 * inventory is chunked; the owner guard binds its digest to original H/G. */
async function applyReplayCatalogImages({
  firestore,
  transaction,
  pair,
  artifacts,
  outputs,
  reference,
  cursor,
  overlay,
}) {
  const inventory = (
    await transaction.get(firestore.doc(`${base(pair)}/replayOutputInventories/${reference.manifestDigest}`))
  ).data();
  if (!inventory || !same(inventory.reference, reference) || !same(inventory.cursor, cursor)) refuse();
  if (!inventory.catalogImages) return outputs;
  const sealed = await capsules.readReplayNamespaceProof({
    firestore,
    pair,
    descriptor: inventory.catalogImages,
  });
  if (sealed.length !== 1) refuse();
  const manifest = catalogs.parsePublicReleasePairCatalogImages(sealed[0], pair, reference.identity, cursor);
  await catalogs.assertReadPublicReleasePairCatalogImagesInTransaction({
    firestore,
    transaction,
    pair,
    identity: reference.identity,
    claimDigest: reference.claimDigest,
    viewManifestDigest: reference.manifestDigest,
    manifest,
    manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  });
  catalogs.assertPublicReleasePairCatalogBaseline(manifest, { members: [...artifacts.values()] });
  const actual = new Map(outputs.map((row) => [row.path, row]));
  for (const member of manifest.members) {
    const row = actual.get(member.path);
    if (
      !row ||
      row.status !== 200 ||
      row.bodyDigest !== member.sha256 ||
      row.bytes !== member.size ||
      row.headers["content-type"] !== member.mime
    )
      refuse();
    if (!artifacts.has(member.path))
      overlay.set(member.path, { path: member.path, view: reference, bodyDigest: member.sha256 });
  }
  const names = new Set(manifest.members.map((member) => member.path));
  return outputs.filter((row) => !names.has(row.path));
}
function selectReplayOutputs({
  content,
  overlay,
  artifacts,
  outputs,
  reference: view,
  baseline = false,
  compositeVerified = false,
}) {
  for (const output of outputs) {
    const artifact = artifacts.get(output.path);
    if (artifact) {
      if (output.status !== 200) refuse();
      const sameMime = output.headers["content-type"] === artifact.mime;
      if (!sameMime && (!artifact.dynamic || !compositeVerified)) refuse();
      if (baseline) {
        if (sameMime && output.bodyDigest === artifact.sha256 && output.bytes === artifact.size) continue;
        if (!compositeVerified || !artifact.dynamic) refuse();
      }
      if (!artifact.dynamic) refuse();
      overlay.set(output.path, { path: output.path, view, bodyDigest: output.bodyDigest });
      continue;
    }
    if (
      !output.path.endsWith("/") ||
      output.path.startsWith("/_pair-compiled/") ||
      output.headers["content-type"] !== "text/html; charset=utf-8"
    )
      refuse();
    if (baseline && content.has(output.path)) refuse();
    content.set(output.path, { path: output.path, view, bodyDigest: output.bodyDigest });
  }
}
function replaySelectionManifest({ pair, kind, cursor, members }) {
  if (!["content", "code-pack-overlay"].includes(kind) || members.size > LIMIT) refuse();
  const sorted = [...members.values()].sort((a, b) => compare(a.path, b.path)),
    pages = [];
  for (let start = 0; start < sorted.length; start += PAGE_SIZE) {
    const rows = sorted.slice(start, start + PAGE_SIZE);
    const page = {
      schemaVersion: 2,
      pairDigest: hash(pair),
      kind,
      cursor,
      index: pages.length,
      members: rows,
    };
    pages.push({
      digest: hash(page),
      count: rows.length,
      firstPath: rows[0].path,
      lastPath: rows.at(-1).path,
    });
  }
  return { schemaVersion: 2, kind, pairDigest: hash(pair), cursor, pages, count: sorted.length };
}
async function readReplaySelectionMembers({ firestore, transaction, pair, kind, cursor, selectionDigest }) {
  const row = await transaction.get(firestore.doc(`${base(pair)}/replaySelections/${selectionDigest}`)),
    receipt = row.data();
  exact(receipt, ["root", "readbackDigest"]);
  const root = receipt.root;
  if (
    !digest(receipt.readbackDigest) ||
    hash(root) !== selectionDigest ||
    root.pairDigest !== hash(pair) ||
    root.schemaVersion !== 2 ||
    root.kind !== kind ||
    !same(root.cursor, cursor) ||
    !Array.isArray(root.pages) ||
    root.pages.length > 391
  )
    refuse();
  const loaded = await pages(
      transaction,
      firestore,
      pair,
      "replaySelectionPages",
      root.pages.map((page) => page.digest),
    ),
    selected = new Map();
  for (const [index, page] of loaded.entries()) {
    exact(page, ["schemaVersion", "pairDigest", "kind", "cursor", "index", "members"]);
    if (
      page.schemaVersion !== 2 ||
      page.pairDigest !== hash(pair) ||
      page.kind !== kind ||
      !same(page.cursor, cursor) ||
      page.index !== index ||
      !Array.isArray(page.members) ||
      !page.members.length ||
      page.members.length > PAGE_SIZE
    )
      refuse();
    for (const member of page.members) {
      exact(member, ["path", "view", "bodyDigest"]);
      const view = reference(member.view, pair);
      if (
        !path(member.path) ||
        (kind === "content" && !member.path.endsWith("/")) ||
        !digest(member.bodyDigest) ||
        view.identity.contextSequence > cursor.sequence ||
        selected.has(member.path)
      )
        refuse();
      selected.set(member.path, { path: member.path, view, bodyDigest: member.bodyDigest });
    }
  }
  if (hash(replaySelectionManifest({ pair, kind, cursor, members: selected })) !== selectionDigest) refuse();
  return selected;
}
module.exports = {
  verifyReplayOutputReadback,
  assertReplayCompositeOutputs,
  readReplayOutputInventory,
  readReplayCodePackInventory,
  selectReplayOutputs,
  applyReplayCatalogImages,
  replaySelectionManifest,
  readReplaySelectionMembers,
};
