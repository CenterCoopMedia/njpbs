"use strict";

const { appendFileSync } = require("node:fs");
const { initFirebase } = require("./update-publish-status.cjs");
const {
  reserveCmsPublishArtifact,
} = require("../functions/lib/cms-publish-artifact");

async function main() {
  const [queueId, buildBatchId, commitSha] = process.argv.slice(2);
  if (!/^[A-Za-z0-9]{20}$/.test(queueId ?? "")) {
    throw new Error("A valid publish queue id is required");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(buildBatchId ?? "")) {
    throw new Error("A valid public build batch id is required");
  }
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? "")) {
    throw new Error("A full lowercase source commit is required");
  }
  const artifact = await reserveCmsPublishArtifact({
    firestore: initFirebase(),
    queueId,
    buildBatchId,
    commitSha,
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `build_required=${artifact === null ? "false" : "true"}\n`,
    );
  }
  if (artifact === null) {
    console.log(`Publish queue ${queueId} is already successful`);
    return;
  }
  console.log(
    `Reserved CMS publish artifact ${artifact.buildBatchId} generation ${artifact.generation}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { main };
