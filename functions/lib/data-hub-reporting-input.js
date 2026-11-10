"use strict";
const { createHash } = require("node:crypto");
const { parseSpotlightReportingSnapshot } = require("./data-hub-reporting-sources");
/** The reporting pool shares the existing immutable Spotlight aggregate input. */
async function readRetainedReporting({ inputs, read }) {
  if (inputs == null) return undefined;
  if (inputs.schemaVersion !== 1 || !/^[A-Za-z0-9]{20}$/.test(inputs.operationId) ||
      inputs.runtime?.owner !== "cloudflare" || !/^[a-f0-9]{40}$/.test(inputs.runtime.release) ||
      !/^[a-f0-9]{64}$/.test(inputs.contentDigest) || !Number.isSafeInteger(inputs.checkedAt) || inputs.checkedAt < 1 ||
      !inputs.files || Object.keys(inputs.files).length !== 3) throw new Error("Reporting input identity is unavailable.");
  for (const name of ["launch-media-manager.json", "spotlight-news.json", "schedule.json"]) {
    const file = inputs.files[name];
    if (!file || file.key !== `post-background-v1/external-inputs/${inputs.operationId}/${name}` ||
        !/^[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16*1024*1024) {
      throw new Error("Reporting input receipt is invalid.");
    }
  }
  const file = inputs.files["spotlight-news.json"];
  const bytes = await read(file.key);
  if (!(bytes instanceof Uint8Array) || bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.digest) {
    throw new Error("Reporting input bytes changed.");
  }
  return parseSpotlightReportingSnapshot(JSON.parse(Buffer.from(bytes).toString("utf8")).dataHubReporting);
}
module.exports = { readRetainedReporting };
