"use strict";
const { createHash } = require("node:crypto");
const { validDatasetId, validateDatasetRelease, DatasetError } = require("./datasets");
const { isDataFigureData } = require("./data-figure");
const { isDatasetFigures, createDatasetFigureResolver, renderDataFigure } = require("./dataset-figures");
const { visibleLayoutBlocks } = require("./content-layout");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const fail = message => { throw new DatasetError(message, 409); };
function figureBlocks(snapshot) {
  const blocks = snapshot?.blocks ?? [];
  if (!Array.isArray(blocks)) fail("Data figure blocks must use an array.");
  return visibleLayoutBlocks(blocks).filter(block => block.type === "data_figure");
}
function validateFrozenDatasetFigures(snapshot) {
  const blocks = figureBlocks(snapshot);
  const figures = snapshot?.datasetFigures;
  if (figures === undefined && !blocks.length) return;
  if (!isDatasetFigures(figures) || figures.figures.length !== blocks.length) fail("The frozen data figures are invalid.");
  const resolve = createDatasetFigureResolver(figures);
  let htmlBytes = 0;
  for (const block of blocks) {
    if (!isDataFigureData(block.data, true)) fail("Select an approved dataset for each data figure.");
    const binding = figures.figures.find(item => item.blockId === block.id && item.datasetId === block.data.datasetId);
    if (!binding || (!binding.withdrawn && !resolve(block.id, block.data))) fail("The frozen data figure does not match its block.");
    htmlBytes += Buffer.byteLength(renderDataFigure(block.id, block.data, resolve(block.id, block.data)));
    if (htmlBytes > 256 * 1024) fail("The rendered data figures exceed 256 KiB. Use fewer figures or shorter source notes.");
  }
}
async function readApprovedDatasetProjection({ firestore, transaction, datasetId, version }) {
  if (!validDatasetId(datasetId) || !isDataFigureData({ datasetId, version, display: "expanded" }, true)) fail("Select an approved dataset release.");
  const ref = firestore.doc(`cmsDatasets/${datasetId}`);
  const record = (await transaction.get(ref)).data();
  if (!record || record.archived) fail("This dataset is unavailable or archived.");
  const releaseId = version.mode === "pinned" ? version.releaseId : record.approvedReleaseId;
  if (!validDatasetId(releaseId)) fail("This dataset has no approved release.");
  const releaseRef = ref.collection("releases").doc(releaseId);
  const head = (await transaction.get(releaseRef)).data();
  if (!Number.isSafeInteger(head?.approvedRevision) || head.approvedRevision < 1) fail("This dataset release is not approved.");
  const approved = (await transaction.get(releaseRef.collection("revisions").doc(String(head.approvedRevision)))).data();
  if (!approved || approved.datasetId !== datasetId || approved.releaseId !== releaseId ||
      approved.revision !== head.approvedRevision || approved.digest !== head.approvedDigest || digest(approved.release) !== approved.digest) fail("This approved dataset release needs repair.");
  validateDatasetRelease(approved.release, { complete: true });
  const release = { ...approved.release };
  delete release.nextReviewOn;
  const reuse = approved.release.reuse;
  return { datasetId, releaseId, revision: approved.revision, digest: approved.digest, approvedAt: approved.approvedAt,
    release: { ...release, reuse: { display: reuse.display, exports: reuse.exports, note: reuse.note } } };
}
async function resolveDatasetFiguresInTransaction({ firestore, transaction, snapshot }) {
  const blocks = figureBlocks(snapshot);
  if (!blocks.length) return snapshot;
  if (blocks.length > 200) fail("Use at most 200 data figures.");
  const resolved = new Map();
  const figures = [];
  for (const block of blocks) {
    if (!isDataFigureData(block.data, true)) fail("Select an approved dataset for each data figure.");
    const lookup = `${block.data.datasetId}:${JSON.stringify(block.data.version)}`;
    if (!resolved.has(lookup)) resolved.set(lookup, await readApprovedDatasetProjection({ firestore, transaction,
      datasetId: block.data.datasetId, version: block.data.version }));
    const projection = resolved.get(lookup);
    figures.push({ blockId: block.id, datasetId: projection.datasetId, releaseId: projection.releaseId,
      revision: projection.revision, digest: projection.digest });
  }
  const releases = [...new Map([...resolved.values()].map(release => [`${release.datasetId}/${release.releaseId}/${release.revision}/${release.digest}`, release])).values()]
    .sort((a, b) => `${a.datasetId}/${a.releaseId}`.localeCompare(`${b.datasetId}/${b.releaseId}`));
  const next = { ...snapshot, datasetFigures: { figures: figures.sort((a, b) => a.blockId.localeCompare(b.blockId)), releases } };
  validateFrozenDatasetFigures(next);
  return next;
}
module.exports = { digest, figureBlocks, validateFrozenDatasetFigures,
  readApprovedDatasetProjection, resolveDatasetFiguresInTransaction };
