"use strict";

/** Reuse reads only within one transaction callback. A Firestore retry gets a
 * fresh cache, and the final receipt transaction never reuses the IO snapshot. */
function settingsProofTransaction(transaction) {
  const documents = new Map();
  const queries = [];
  function get(reference) {
    if (typeof reference.path === "string") {
      if (!documents.has(reference.path)) documents.set(reference.path, transaction.get(reference));
      return documents.get(reference.path);
    }
    const prior = queries.find(entry => entry.reference.isEqual(reference));
    if (prior) return prior.read;
    const read = transaction.get(reference);
    queries.push({ reference, read });
    return read;
  }
  function getAll(...references) {
    // Preserve SDK options such as a field mask if a future caller adds one.
    if (!references.length || references.some(reference => typeof reference?.path !== "string")) return transaction.getAll(...references);
    const missing = [...new Map(references.filter(reference => !documents.has(reference.path))
      .map(reference => [reference.path, reference])).values()];
    if (missing.length) {
      const read = transaction.getAll(...missing);
      missing.forEach((reference, index) => documents.set(reference.path, read.then(rows => rows[index])));
    }
    return Promise.all(references.map(reference => documents.get(reference.path)));
  }
  return new Proxy(transaction, { get(object, name) {
    if (name === "get") return get;
    if (name === "getAll") return getAll;
    const value = Reflect.get(object, name, object);
    return typeof value === "function" ? value.bind(object) : value;
  } });
}

/** Wait for a complete bounded batch before returning or failing. The caller
 * still validates every source and writes only the complete family receipt. */
async function readSettingsInputs(values, read) {
  const results = [];
  for (let offset = 0; offset < values.length; offset += 8) {
    const batch = await Promise.allSettled(values.slice(offset, offset + 8).map(read));
    const failed = batch.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    results.push(...batch.map(result => result.value));
  }
  return results;
}

module.exports = { settingsProofTransaction, readSettingsInputs };
