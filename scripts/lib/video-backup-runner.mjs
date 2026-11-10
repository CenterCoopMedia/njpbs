import backup from "../../functions/lib/video-backup.js";

const { inventoryPage, copyViewingCopy, MAX_PAGE } = backup;

function runKey(runId) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw Error("Invalid inventory run ID");
  return `runs/${runId}`;
}

// Call one step per independent job invocation. These functions do not install
// a schedule, initialize Firebase, resolve credentials or call the app workflow.
export function createVideoBackupRunner({ db, source, sourceBucket, destination, state,
  pageSize = MAX_PAGE, maxFileBytes, stagingDirectory, now = () => new Date().toISOString() }) {
  async function inventoryStep(runId) {
    const key = runKey(runId);
    const checkpoint = await state.read(`${key}/inventory`) || {
      schemaVersion: 1, runId, sourceBucket, startedAt: now(), pages: 0, after: null,
      scanned: 0, eligibleFiles: 0, eligibleBytes: 0, gapCount: 0, gapReasons: {}, complete: false,
    };
    if (checkpoint.sourceBucket !== sourceBucket) throw Error("Inventory source binding changed");
    if (checkpoint.complete) return checkpoint;
    const page = await inventoryPage({ db, source, sourceBucket, after: checkpoint.after, limit: pageSize });
    const gapReasons = { ...checkpoint.gapReasons };
    for (const gap of page.gaps) gapReasons[gap.reason] = (gapReasons[gap.reason] || 0) + 1;
    const receipt = { ...checkpoint, pages: checkpoint.pages + 1, after: page.nextCursor,
      scanned: checkpoint.scanned + page.scanned, eligibleFiles: checkpoint.eligibleFiles + page.eligibleFiles,
      eligibleBytes: checkpoint.eligibleBytes + page.eligibleBytes, gapCount: checkpoint.gapCount + page.gaps.length,
      gapReasons, complete: page.nextCursor === null, updatedAt: now() };
    // The cursor advances only after the full page is durable. Repeating after
    // a crash replaces the uncommitted page without double-counting totals.
    await state.write(`${key}/pages/${checkpoint.pages}`, page);
    await state.write(`${key}/inventory`, receipt);
    return receipt;
  }

  async function copyStep(runId, { verifyExisting = false } = {}) {
    if (typeof verifyExisting !== "boolean") throw Error("Invalid verification mode");
    const key = runKey(runId);
    const inventory = await state.read(`${key}/inventory`);
    if (!inventory?.complete) throw Error("Complete and report inventory before copying");
    if (inventory.sourceBucket !== sourceBucket) throw Error("Inventory source binding changed");
    let checkpoint = await state.read(`${key}/copy`);
    // An explicit call after a complete pass starts a retry pass of this exact
    // retained inventory, even if source documents were changed or deleted.
    if (!checkpoint || checkpoint.complete) checkpoint = { runId, page: 0, pass: (checkpoint?.pass || 0) + 1,
      verified: 0, reused: 0, failed: 0, verifiedBytes: 0, checkedFiles: 0, checkedBytes: 0,
      verifyExisting, complete: false };
    if (checkpoint.verifyExisting !== verifyExisting) throw Error("Finish the current pass before changing verification mode");
    const page = await state.read(`${key}/pages/${checkpoint.page}`);
    if (!page) throw Error("Inventory page missing");
    for (const entry of page.entries) {
      const result = await copyViewingCopy({ entry, source, destination, state, maxFileBytes, verifyExisting, stagingDirectory, now });
      if (result.status === "verified") {
        checkpoint.verified++;
        checkpoint.verifiedBytes += entry.sizeBytes;
        checkpoint.checkedBytes += result.checkedBytes;
        if (result.checkedBytes) checkpoint.checkedFiles++;
        if (result.reused) checkpoint.reused++;
      } else checkpoint.failed++;
    }
    checkpoint = { ...checkpoint, page: checkpoint.page + 1,
      complete: checkpoint.page + 1 === inventory.pages, updatedAt: now() };
    await state.write(`${key}/copy`, checkpoint);
    return checkpoint;
  }

  return {
    inventoryStep: runId => state.withLock(() => inventoryStep(runId)),
    copyStep: (runId, options) => state.withLock(() => copyStep(runId, options)),
    // Inventory completion always returns to the caller before a later tick can
    // transfer. New sweeps start at the beginning to discover newly ready copies
    // behind a previous cursor. Failed copies are retried on subsequent sweeps.
    tick: ({ allowCopy = false } = {}) => state.withLock(async () => {
      let cycle = await state.read("background") || { sequence: 1, phase: "inventory" };
      const runId = `sweep-${cycle.sequence}`;
      if (cycle.phase === "inventory") {
        const inventory = await inventoryStep(runId);
        if (inventory.complete) {
          cycle = { ...cycle, phase: "copy" };
          await state.write("background", cycle);
        }
        return { phase: "inventory", inventory };
      }
      if (!allowCopy) return { phase: "awaiting_copy", inventory: await state.read(`${runKey(runId)}/inventory`) };
      const copy = await copyStep(runId);
      if (copy.complete) await state.write("background", { sequence: cycle.sequence + 1, phase: "inventory" });
      return { phase: "copy", copy };
    }),
  };
}
