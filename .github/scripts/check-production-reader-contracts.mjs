import { deepStrictEqual, ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contractRecipe, writeFunctionsContracts } from "../../scripts/lib/functions-contracts.mjs";
import { publicPostRendererRelease, publicWorkerCandidateRendererContract } from "../../site/scripts/public-post-renderer-release.ts";
import { privatePairReaderDeployment, privatePairReaderInstallation, privatePairReaderCapabilities } from "../../workers/src/private-pair-reader-installation.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
const requireSite = createRequire(new URL("../../site/package.json", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const versionId = "11111111-1111-4111-8111-111111111111";

async function compatible(label, check) {
  try {
    await check();
  } catch (error) {
    throw new Error(`${label} is incompatible with production. Ship the reader first, then the writer. ${error.message}`);
  }
}

function candidateFromRelease(sha, env) {
  const seal = publicPostRendererRelease(sha, "production", env);
  const { variables, pageReaderVersion } = publicWorkerCandidateRendererContract(seal, sha);
  const { projectCloudflareWorkerVersion } = require("../../functions/lib/public-worker-candidate.js");
  const tag = "ci-contract";
  const message = "public release contract";
  const candidate = projectCloudflareWorkerVersion({
    id: versionId,
    metadata: { source: "wrangler", created_on: "2026-01-01T00:00:00Z" },
    annotations: { "workers/tag": tag, "workers/message": message, "workers/triggered_by": "version_upload" },
    resources: {
      script: {},
      script_runtime: { assets: { run_worker_first: true } },
      bindings: [
        ...Object.entries(variables).map(([name, text]) => ({ name, text, type: "plain_text" })),
        { name: "ASSETS", type: "assets" },
        { name: "CMS_API", type: "service", service: "njpbs-cms-api", entrypoint: "PublicContentEntrypoint" },
      ],
    },
  }, { tag, message });
  return { candidate, pageReaderVersion };
}

// Run the real transaction callbacks against local records.
function memoryTransaction() {
  const rows = new Map();
  const row = path => ({ exists: rows.has(path), data: () => rows.get(path) });
  const set = (path, data) => rows.set(path, data);
  const firestore = { doc: path => path };
  const transaction = { get: async path => row(path), getAll: async (...paths) => paths.map(row), create: set, set };
  return { firestore, transaction, rows };
}

async function checkCandidate(read, sha, env) {
  const { candidate, pageReaderVersion } = candidateFromRelease(sha, env);
  const post = read("no-build-post-state");
  const page = read("no-build-page-ownership");
  const record = read("no-build-record-capability");
  for (const [label, value, parse] of [
    ["Post", candidate.noBuildPost, post.candidateNoBuildContract],
    ["Page", candidate.noBuildPage, page.candidateNoBuildPageContract],
    ["Record", candidate.noBuildRecord, record.candidateNoBuildRecordContract],
  ]) {
    await compatible(`${label} candidate (${Object.keys(value ?? {}).join(", ")})`, () => {
      ok(value, "The writer omitted a candidate family.");
      deepStrictEqual(parse(value), value);
    });
  }
  await compatible(`Page reader marker version ${pageReaderVersion}`, async () => {
    const { preparePageReaderMarker } = require("../../functions/lib/page-reader-compatibility.js");
    const { firestore, transaction } = memoryTransaction();
    const identity = { firestore, transaction, role: "public", rendererSha: sha };
    const write = await preparePageReaderMarker({ ...identity, version: pageReaderVersion });
    write();
    deepStrictEqual(await read("page-reader-compatibility").readPageReaderVersion(identity), pageReaderVersion);
  });

  await checkCapabilities(read, sha, candidate);
}

async function checkCapabilities(read, sha, { noBuildPost, noBuildPage, noBuildRecord }) {
  const { writeNoBuildCandidateActivation } = require("../../functions/lib/no-build-post-publication.js");
  const { writeNoBuildPageCandidateActivation } = require("../../functions/lib/no-build-page-candidate.js");
  const { firestore, transaction, rows } = memoryTransaction();
  const identity = { commitSha: sha, generation: 1 };
  writeNoBuildCandidateActivation(transaction, firestore, { contract: noBuildPost }, identity);
  writeNoBuildPageCandidateActivation(transaction, firestore, { contract: noBuildPage, recordContract: noBuildRecord }, identity);
  const documents = [...rows].map(([path, data]) => ({ path, data }));
  await checkSourceBody(read, documents);
  const post = read("no-build-post-ownership");
  const page = read("no-build-page-ownership");
  const record = read("no-build-record-capability");
  for (const [path, parse] of [
    [post.CAPABILITY_PATH, () => post.readNoBuildPostCapability({ firestore, transaction })],
    [page.PAGE_CAPABILITY_PATH, () => page.readNoBuildPageCapability({ firestore, transaction })],
    [record.CAPABILITY_PATH, () => record.readRecordCapability({ firestore, transaction })],
  ]) {
    await compatible(path, async () => {
      ok(rows.has(path), "The writer omitted an activation capability.");
      deepStrictEqual(await parse(), rows.get(path));
    });
  }
}

async function checkSourceBody(read, documents) {
  const writer = require("../../functions/lib/public-release-source-body.js");
  const reader = read("public-release-source-body");
  await compatible("Public release source body", async () => {
    const { firestore, transaction } = memoryTransaction();
    const source = writer.makePublicReleaseSourceBody({
      kind: "post", id: "ci-contract", action: "dependency", sourceVersion: 1, snapshot: null, sourceDocuments: documents,
    });
    const write = await writer.preparePublicReleaseSourceBodies({ firestore, transaction, values: [source] });
    write();
    const body = await reader.readPublicReleaseSourceBody({ firestore, transaction, contentDigest: source.contentDigest });
    deepStrictEqual(body.documents, documents, "The writer dropped authority fields when constructing the source body.");
    for (const { path, data } of body.documents) {
      deepStrictEqual(reader.publicReleaseAuthorityDocument(path, data), data, `Production dropped authority fields at ${path}.`);
    }
  });
}

async function checkPair(production, sha) {
  const { publicReleaseDigest } = require("../../functions/lib/public-release-pair.js");
  const { releasePair } = require("../../tests/helpers/private-public-release-pair.js");
  const origin = "https://reader.example.org";
  const identity = { ...releasePair("a", sha), environment: "production" };
  const deployment = privatePairReaderDeployment(identity, origin);
  const pair = { ...identity, readerContractDigest: deployment.contractDigest,
    readerReceiptDigest: publicReleaseDigest(deployment),
    capabilityDigest: publicReleaseDigest(privatePairReaderCapabilities(sha)) };
  const seals = privatePairReaderInstallation(pair, origin);
  await compatible("Private pair reader seal", async () => {
    const { parseReaderSeals } = await import(pathToFileURL(join(production, "site/scripts/public-release-pair-reader-contract.ts")));
    deepStrictEqual(parseReaderSeals(seals, pair), seals);
  });
}

async function buildProductionContracts(production) {
  // Older releases store their compiled Functions contracts in the Git tree.
  if (!existsSync(join(production, contractRecipe))) return;
  const compiler = await import(pathToFileURL(join(production, "scripts/lib/functions-contracts.mjs")));
  const lock = JSON.parse(await readFile(join(production, "package-lock.json"), "utf8"));
  const esbuildVersion = lock.packages["node_modules/esbuild"].version;
  if (requireSite("esbuild").version === esbuildVersion) {
    await compiler.writeFunctionsContracts(production, requireSite);
  } else {
    execFileSync("npm", ["ci", "--ignore-scripts"], { cwd: join(production, "site"), stdio: "inherit" });
    await compiler.writeFunctionsContracts(production);
  }
}

async function check(ref) {
  const sha = git("rev-parse", "HEAD");
  const productionSha = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  const temp = await mkdtemp(join(tmpdir(), "njpbs-production-reader-"));
  try {
    const production = join(temp, "source");
    const archive = join(temp, "production.tar");
    await mkdir(production);
    git("archive", `--output=${archive}`, productionSha);
    execFileSync("tar", ["-xf", archive, "-C", production]);
    await buildProductionContracts(production);
    await writeFunctionsContracts(root, requireSite);
    const read = name => require(join(production, "functions/lib", `${name}.js`));
    console.log(`Checking public release writer ${sha} against production readers at ${productionSha}.`);
    await checkCandidate(read, sha, {});
    await checkCandidate(read, sha, { DATA_HUB_PUBLIC: "1" });
    await checkPair(production, sha);
    console.log("Production readers accepted the public release contracts.");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

await check(process.argv[2] ?? "origin/production");
