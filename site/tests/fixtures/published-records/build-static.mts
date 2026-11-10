import { build } from "astro";
import { installRetainedPublicImages } from "../../../scripts/retained-public-images";
import "./clock.mjs";
const manifest = process.env.RECORD_IMAGE_MANIFEST;
const buildBatchId = process.env.RECORD_IMAGE_BUILD_BATCH;
const commitSha = process.env.RECORD_IMAGE_RENDERER_SHA;
if (!manifest || !buildBatchId || !commitSha) throw new Error("Missing record image fixture identity");
const previous = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Record image fixture attempted outbound network"); };
const restore = await installRetainedPublicImages(manifest, { buildBatchId, commitSha });
process.env.CMS_RETAINED_IMAGES_READY = "1";
try { await build({ configFile: "astro.public-record-fixtures.config.mjs", logLevel: "silent" }); }
finally { restore(); globalThis.fetch = previous; }
