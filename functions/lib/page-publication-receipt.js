"use strict";

function confirmedPageReceipt(stored) {
  const settlement = stored?.publishBuildSettlement;
  const receipt = settlement?.pageReceipt;
  const visible = stored?.publiclyVisible === true || stored?.publiclyVisible === undefined && stored?.status === "published";
  if (settlement?.status !== "success" || stored?.publishBuildPending === true ||
      !Number.isSafeInteger(receipt?.sourceVersion) || receipt.sourceVersion < 1 ||
      settlement.sourceVersion !== stored?.published?.sourceVersion ||
      settlement.operation !== (visible ? "publish" : "withdraw") ||
      !/^[A-Za-z0-9]{20}$/.test(receipt?.operationId ?? "") || receipt.sourceVersion !== settlement.sourceVersion ||
      receipt.visible !== visible || (visible ? stored.publicSourceVersion !== receipt.sourceVersion : stored.publicSourceVersion !== null)) return null;
  return { operationId: receipt.operationId, sourceVersion: receipt.sourceVersion, visible: receipt.visible };
}

module.exports = { confirmedPageReceipt };
