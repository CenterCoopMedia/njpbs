"use strict";
const { isDeepStrictEqual } = require("node:util");
const { DatasetError } = require("./datasets");
const { digest } = require("./dataset-dependencies");
function editorialSnapshotDigest(snapshot) {
  const editorial = { ...snapshot };
  delete editorial.datasetFigures;
  return digest(editorial);
}
/** Dependency work changes the frozen projection, never a saved editorial draft. */
function assertSameSourceRefresh(before, after) {
  if (!before?.published || !after?.published) throw new DatasetError("The published dataset owner is unavailable.", 409);
  const withoutDependency = value => {
    const snapshot = { ...value.published };
    delete snapshot.datasetFigures;
    const working = { ...value };
    for (const key of ["published", "publishBuildPending", "publishBuildQueueId"]) delete working[key];
    return { working, snapshot };
  };
  if (!isDeepStrictEqual(withoutDependency(before), withoutDependency(after))) {
    throw new DatasetError("Dataset refresh cannot change saved editorial content.", 409);
  }
}
module.exports = { assertSameSourceRefresh, editorialSnapshotDigest };
