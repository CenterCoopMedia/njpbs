"use strict";

const { reservePublicBuildBatch } = require(
  "../functions/lib/public-deployment-coordinator",
);
const { initFirebase } = require("./update-publish-status.cjs");

async function main() {
  const [buildBatchId, commitSha] = process.argv.slice(2);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(buildBatchId ?? "")) {
    throw new Error("A valid public build batch id is required");
  }
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? "")) {
    throw new Error("A full lowercase source commit is required");
  }
  const { batch } = await reservePublicBuildBatch({
    firestore: initFirebase(),
    buildBatchId,
    commitSha,
  });
  console.log(
    `Reserved public artifact ${batch.buildBatchId} generation ${batch.generation}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { main };
