"use strict";

const {
  selectActivePublicBuildBatch,
} = require("../functions/lib/pages-public-artifact");
const { initFirebase } = require("./update-publish-status.cjs");

async function main() {
  const [commitSha] = process.argv.slice(2);
  const selected = await selectActivePublicBuildBatch({
    firestore: initFirebase(),
    commitSha,
  });
  process.stdout.write(`${selected.buildBatchId}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { main };
