import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readEnrollmentEdgeSecret } from "./lib/enrollment-edge-secret.mjs";

const require = createRequire(import.meta.url);
const { publicationTarget } = require("../functions/lib/publication-target.js");
const { createCurrentCodeTransport } = require("../functions/lib/current-public-code-source.js");
const { parsePublicReleaseChangeEnrollmentRequest } = require("../functions/lib/public-release-change-enrollment.js");

export async function checkDevCurrentCode({ rendererSha, readSecret, request }) {
  if (!/^[a-f0-9]{40}$/.test(rendererSha ?? "")) throw new Error("Development CODE source refused");
  const transport = createCurrentCodeTransport({ target: publicationTarget("development"), rendererSha, readSecret, request });
  const reference = await transport.readCurrentCodeReference();
  const current = await transport.readCurrentCode();
  if (!isDeepStrictEqual(reference, current.reference) ||
      createHash("sha256").update(current.bytes).digest("hex") !== reference.manifest.sha256) {
    throw new Error("Development CODE source refused");
  }
  return { schemaVersion: 1, projectId: "njpbs-site-dev", rendererSha,
    referenceRead: true, codeRead: true, publication: reference.publication,
    codeDigest: reference.manifest.sha256, codeBytes: reference.manifest.byteLength };
}

async function main() {
  const [mode, input, ...extra] = process.argv.slice(2);
  let rendererSha;
  if (extra.length) throw new Error();
  if (mode === "--renderer-sha") rendererSha = input;
  else if (mode === "--enrollment-request" && path.isAbsolute(input ?? "")) {
    const bytes = await readFile(input);
    if (bytes.length > 16_384) throw new Error();
    const request = parsePublicReleaseChangeEnrollmentRequest(JSON.parse(bytes.toString("utf8")));
    if (request.expected.projectId !== "njpbs-site-dev") throw new Error();
    rendererSha = request.expected.liveReleaseSha;
  } else throw new Error();
  if (!/^[a-f0-9]{40}$/.test(rendererSha ?? "")) throw new Error();
  const secret = await readEnrollmentEdgeSecret();
  process.stdout.write(JSON.stringify(await checkDevCurrentCode({ rendererSha, readSecret: () => secret })) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const rpcStatus = error?.rpcStatus;
    process.stderr.write(JSON.stringify({ status: "refused", code: "development-code-preflight-failed",
      ...(Number.isInteger(rpcStatus) && rpcStatus >= 100 && rpcStatus <= 599 ? { rpcStatus } : {}) }) + "\n");
    process.exitCode = 1;
  });
}
