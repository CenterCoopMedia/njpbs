// A Firestore commit that lands while its answer is lost: the first transaction
// whose committed request and journal match throws UNAVAILABLE afterwards.
export async function loseAnswer(db, { requestPath, journalPath, matches }, work) {
  const begin = db.runTransaction.bind(db);
  const read = async () => ({ request: (await db.doc(requestPath).get()).data(), job: (await db.doc(journalPath).get()).data()?.job ?? null });
  let lost = null;
  db.runTransaction = async (...args) => {
    const before = await read();
    const result = await begin(...args);
    const after = await read();
    if (lost === null && matches(before, after)) {
      lost = after;
      throw Object.assign(new Error("UNAVAILABLE after commit"), { code: 14 });
    }
    return result;
  };
  try { await work(); } catch (error) { if (error?.code !== 14) throw error; } finally { delete db.runTransaction; }
  return lost;
}

// What each write of the release runner changes.
export const releaseWrites = {
  claim: (before, after) => after.request.attempts === before.request.attempts + 1,
  settlement: (before, after) => before.request.refusalReceipt === undefined && after.request.refusalReceipt !== undefined,
  retry: (before, after) => before.request.failureReason === null && typeof after.request.failureReason === "string" && after.request.nextAttemptAt !== null,
  outcome: (before, after) => before.request.status !== "deployed" && after.request.status === "deployed",
  "next check": (before, after) => after.request.attempts === before.request.attempts && after.request.failureReason === null &&
    after.request.nextAttemptAt !== null && after.request.nextAttemptAt !== before.request.nextAttemptAt,
  close: (before, after) => ["pending", "failed"].includes(before.request.status) && before.request.nextAttemptAt !== null &&
    after.request.nextAttemptAt === null && after.request.refusalReceipt === undefined,
  "journal clear": (before, after) => before.job !== null && after.job === null && before.request.status === after.request.status,
};
