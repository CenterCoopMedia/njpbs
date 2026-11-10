"use strict";

const p = require("./public-release-pair");
const MAX_ROWS = 5000;
function refuse() { throw new Error("Retained reader source changed"); }
const fingerprint = row => row.docs
  ? p.publicReleaseDigest(row.docs.map(doc => ({ path: doc.ref.path, data: doc.data() })))
  : p.publicReleaseDigest(row.exists ? row.data() : null);

function reference(firestore, target) {
  p.exact(target, ["kind", "path", "steps"]);
  if (!["document", "query"].includes(target.kind) || typeof target.path !== "string" ||
      !/^[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)*$/.test(target.path) ||
      target.path.split("/").some(part => [".", ".."].includes(part)) ||
      !Array.isArray(target.steps) || target.steps.length > 12) refuse();
  if (target.kind === "document") {
    if (target.steps.length) refuse();
    return firestore.doc(target.path);
  }
  let query = firestore.collection(target.path), bound = MAX_ROWS + 1;
  for (const step of target.steps) {
    p.exact(step, ["method", "args"]);
    if (!["where", "orderBy", "limit", "select"].includes(step.method) || !Array.isArray(step.args)) refuse();
    if (step.method === "limit") bound = step.args[0];
    query = query[step.method](...step.args);
  }
  return query.limit(Math.min(bound, MAX_ROWS + 1));
}

// These are real SDK reads in the owner's original transaction. Recording the
// queries as well as their rows catches a new competing route/owner on replay.
function recordReaderSourceReads({ firestore, transaction }) {
  const records = new Map();
  const read = async target => {
    const row = await transaction.get(reference(firestore, target));
    if (row.size > MAX_ROWS || records.size >= 256) refuse();
    const digest = fingerprint(row), key = p.publicReleaseDigest(target);
    if (records.has(key) && records.get(key).digest !== digest) refuse();
    records.set(key, { target, digest });
    return row;
  };
  function doc(path) {
    return { path, id: path.split("/").at(-1), sourceTarget: { kind: "document", path, steps: [] },
      collection: name => query(`${path}/${name}`), get: () => read({ kind: "document", path, steps: [] }) };
  }
  function query(path, steps = []) {
    const target = { kind: "query", path, steps };
    return { path, sourceTarget: target, doc: id => doc(`${path}/${id}`), get: () => read(target),
      ...Object.fromEntries(["where", "orderBy", "limit", "select"].map(method => [method,
        (...args) => query(path, [...steps, { method, args }])])) };
  }
  const get = ref => read(ref.sourceTarget ?? { kind: "document", path: ref.path, steps: [] });
  return { firestore: { projectId: firestore.projectId, doc, collection: query },
    transaction: { get, getAll: (...refs) => Promise.all(refs.map(get)) },
    readset: () => [...records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([, row]) => row).filter(row => row.target.path !== "system/publicDeployment") };
}

module.exports = { recordReaderSourceReads };
