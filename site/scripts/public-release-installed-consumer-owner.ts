import { randomBytes, createHash } from "node:crypto";
import { renderCommittedDeploymentSource, readDeploymentManifest } from "../../scripts/render-development-config.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import consumers from "../../functions/lib/public-release-installed-consumers.js";
import protocol from "../../functions/lib/public-release-pair.js";
import targets from "../../functions/lib/publication-target.js";
import preview from "../../functions/lib/cms-preview-pair.js";
import admission from "../../functions/lib/public-release-admission.js";
import { fingerprintInputs, fingerprintFunctionGraph, functionsInventoryIdentity } from "../../scripts/lib/cms-component-receipt.mjs";
import { createInstalledConsumerProvider, type InstalledConsumerProvider, type InstalledFunctionRecord } from "./public-release-installed-consumer-provider";
import { exact } from "./public-release-pair-reader-contract";
import { parseInstalledConsumerProbe } from "./public-release-installed-consumer-contract";

const execute = promisify(execFile), hash = protocol.publicReleaseDigest;
const PATHS = ["cmsDeploymentReceipts/functions", "cmsReaderCompatibilityReceipts/functions", "system/publicDeployment"];
const REQUIRED_EXPORTS = ["cmsGetPublicPage", "cmsSaveContent", "cmsTransitionContent", "onScheduledPublish"];
const prepared = new WeakMap<PreparedInstalledConsumers, Data>();
type TrustedSource = { inputFingerprint: string; functionGraph: unknown; files: { path: string; sha256: string }[] };
export type PreparedInstalledConsumers = Readonly<{ environment: "production" | "development"; sourceSha: string;
  sourceDigest: string; providerDigest: string; deploymentReceiptDigest: string; readerReceiptDigest: string; contractDigest: string }>;
type Data = { firestore: Firestore; paths: string[]; digests: string[]; preparedAt: number; clock(): number };
function refuse(): never { throw new Error("Installed public release consumers are not proven"); }
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function pointer(value: unknown) {
  const parsed = protocol.parseVersionedPublicDeployment(value);
  const { updatedAt: _stamp, ...identity } = parsed as typeof parsed & { updatedAt?: unknown };
  return identity;
}
async function committedSource(sourceSha: string, cwd: string): Promise<TrustedSource> {
  const files = [];
  const manifest = readDeploymentManifest(cwd, sourceSha);
  for (const path of consumers.INSTALLED_CONSUMER_FILES) {
    const { stdout } = await execute("git", ["show", `${sourceSha}:functions/${path}`], { cwd, encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
    if (!stdout.length) refuse();
    const rendered = renderCommittedDeploymentSource(`functions/${path}`, stdout.toString("utf8"), process.env, manifest);
    files.push({ path, sha256: createHash("sha256").update(rendered).digest("hex") });
  }
  const [inputFingerprint, functionGraph] = await Promise.all([
    fingerprintInputs(sourceSha, "functions", { cwd }), fingerprintFunctionGraph(sourceSha, { cwd }),
  ]);
  if (!digest(inputFingerprint) || !functionGraph) refuse();
  return { files, inputFingerprint, functionGraph };
}
function archive(row: InstalledFunctionRecord) {
  const source = row.buildConfig.sourceProvenance.resolvedStorageSource ?? row.buildConfig.source.storageSource;
  if (!source || typeof source.bucket !== "string" || !source.bucket || typeof source.object !== "string" || !source.object ||
      typeof source.generation !== "string" || !/^[1-9]\d{0,18}$/.test(source.generation)) refuse();
  return source;
}
function cohort(inventory: InstalledFunctionRecord[], projectId: string, revision: string) {
  const rows = REQUIRED_EXPORTS.map(name => {
    const found = inventory.filter(row => row.name === `projects/${projectId}/locations/us-central1/functions/${name}`);
    if (found.length !== 1) refuse();
    const row = found[0];
    if (row.state !== "ACTIVE" || row.environment !== "GEN_2" || row.buildConfig.entryPoint !== name ||
        row.serviceConfig.allTrafficOnLatestRevision !== true || typeof row.serviceConfig.revision !== "string" ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(row.serviceConfig.revision.split("/").at(-1) ?? "")) refuse();
    archive(row); return row;
  });
  if (rows[0].serviceConfig.revision!.split("/").at(-1) !== revision) refuse();
}
function assertGraph(raw: unknown) {
  const graph = exact(raw, ["version", "globalFingerprint", "exports"]);
  if (graph.version !== 2 || !digest(graph.globalFingerprint) || !graph.exports || typeof graph.exports !== "object" || Array.isArray(graph.exports)) refuse();
  for (const name of REQUIRED_EXPORTS) {
    const row = exact((graph.exports as Record<string, unknown>)[name], ["fingerprint", "preview"]);
    if (!digest(row.fingerprint) || typeof row.preview !== "boolean") refuse();
  }
}

type DeploymentOptions = {
  firestore: Firestore; environment: "production" | "development"; sourceSha: string;
  provider?: Pick<InstalledConsumerProvider, "readInventory" | "readProbe">; cwd?: string;
  readSource?: (sha: string, cwd: string) => Promise<TrustedSource>; clock?: () => number;
};
async function inspectConsumerDeployment({ deployment, compatible, sourceSha, projectId, provider, cwd, readSource }: {
  deployment: any; compatible: any; sourceSha: string; projectId: string;
  provider: Pick<InstalledConsumerProvider, "readInventory" | "readProbe">; cwd: string;
  readSource: (sha: string, cwd: string) => Promise<TrustedSource>;
}) {
  const source = await readSource(sourceSha, cwd), reader = preview.currentReader(compatible, "functions");
  assertGraph(source.functionGraph);
  if (!digest(source.inputFingerprint) || source.files.length !== consumers.INSTALLED_CONSUMER_FILES.length) refuse();
  if (deployment?.schemaVersion !== 1 || deployment.component !== "functions" || deployment.state !== "complete" ||
      deployment.mutation?.sourceSha !== sourceSha || deployment.mutation.inputFingerprint !== source.inputFingerprint ||
      !deployment.mutation.functionGraph || hash(deployment.mutation.functionGraph) !== hash(source.functionGraph) || reader.sourceSha !== sourceSha ||
      reader.inputFingerprint !== source.inputFingerprint || reader.configurationFingerprint !== deployment.mutation.configurationFingerprint ||
      hash(reader.providerIdentities) !== hash(deployment.mutation.providerIdentities)) refuse();
  const inventory = await provider.readInventory(), nonce = randomBytes(32).toString("hex");
  const observed = parseInstalledConsumerProbe(await provider.readProbe(inventory, nonce), nonce);
  // Batches can have distinct immutable archives. The current trusted receipt
  // binds each live archive/revision to the graph computed from committed git;
  // no provider-supplied source fingerprint substitutes for that owner.
  if (hash(observed.files) !== hash(source.files) || observed.sourceDigest !== hash(source.files) ||
      observed.flags.PUBLIC_RELEASE_READERS_ENABLED !== true || observed.flags.PUBLIC_RELEASE_COMPOSED_READERS_ENABLED !== true ||
      hash(functionsInventoryIdentity(inventory)) !== hash(deployment.mutation.providerIdentities)) refuse();
  cohort(inventory, projectId, observed.revision);
  // Detect a provider deployment crossing the probe before accepting a handle.
  const after = await provider.readInventory();
  if (hash(after) !== hash(inventory)) refuse();
  return { observed, inventory };
}

/** Read-only deployment evidence, before contract installation. This serialized
 * report is never an opaque controls proof and grants no control write. */
export async function readInstalledPublicReleaseConsumerDeployment({ firestore, environment, sourceSha,
  provider = createInstalledConsumerProvider({ environment }), cwd = process.cwd(), readSource = committedSource, clock = Date.now,
}: DeploymentOptions) {
  const target = targets.publicationTarget(environment);
  targets.assertPublicationDatabase({ projectId: (firestore as unknown as { projectId?: string }).projectId }, target);
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) refuse();
  const startedAt = clock(), refs = PATHS.slice(0, 2).map(path => firestore.doc(path));
  const [deployment, compatible] = (await firestore.getAll(...refs)).map(row => row.data());
  const { observed, inventory } = await inspectConsumerDeployment({ deployment, compatible, sourceSha,
    projectId: target.projectId, provider, cwd, readSource });
  const after = (await firestore.getAll(...refs)).map(row => row.data()), finishedAt = clock();
  if (hash(after[0]) !== hash(deployment) || hash(after[1]) !== hash(compatible) || !Number.isFinite(startedAt) ||
      !Number.isFinite(finishedAt) || finishedAt < startedAt || finishedAt - startedAt > 60_000) refuse();
  return Object.freeze({ environment, sourceSha, sourceDigest: observed.sourceDigest, providerDigest: hash(inventory),
    deploymentReceiptDigest: hash(deployment), readerReceiptDigest: hash(compatible), probe: observed });
}

/** Opaque preparation from actual provider reads and trusted committed bytes.
 * Serialized hashes and success flags cannot be used at the late SDK guard. */
export async function prepareInstalledPublicReleaseConsumers({ firestore, environment, sourceSha, contractDigest,
  provider = createInstalledConsumerProvider({ environment }), cwd = process.cwd(), readSource = committedSource, clock = Date.now }: {
  firestore: Firestore; environment: "production" | "development"; sourceSha: string; contractDigest: string;
  provider?: Pick<InstalledConsumerProvider, "readInventory" | "readProbe">; cwd?: string;
  readSource?: (sha: string, cwd: string) => Promise<TrustedSource>; clock?: () => number;
}): Promise<PreparedInstalledConsumers> {
  const target = targets.publicationTarget(environment);
  targets.assertPublicationDatabase({ projectId: (firestore as unknown as { projectId?: string }).projectId }, target);
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !digest(contractDigest)) refuse();
  const startedAt = clock(), paths = [...PATHS, `${admission.CONTRACTS}/${contractDigest}`];
  const snapshots = await firestore.getAll(...paths.map(path => firestore.doc(path)));
  const [deployment, compatible, root, contract] = snapshots.map(row => row.data());
  pointer(root); const parsedContract = exact(contract, ["schemaVersion", "families", "features"]);
  if (parsedContract.schemaVersion !== 2 || hash(parsedContract) !== contractDigest) refuse();
  const { observed, inventory } = await inspectConsumerDeployment({ deployment, compatible, sourceSha,
    projectId: target.projectId, provider, cwd, readSource });
  const preparedAt = clock();
  if (!Number.isFinite(startedAt) || !Number.isFinite(preparedAt) || preparedAt < startedAt || preparedAt - startedAt > 60_000) refuse();
  const handle = Object.freeze({ environment, sourceSha, contractDigest, sourceDigest: observed.sourceDigest,
    providerDigest: hash(inventory), deploymentReceiptDigest: hash(deployment), readerReceiptDigest: hash(compatible) });
  prepared.set(handle, { firestore, paths, digests: [hash(deployment), hash(compatible), hash(pointer(root)), hash(contract)], preparedAt: startedAt, clock });
  return handle;
}
export async function assertInstalledPublicReleaseConsumersInTransaction({ firestore, transaction, proof, environment, contractDigest, before }: {
  firestore: Firestore; transaction: Transaction; proof: PreparedInstalledConsumers;
  environment: "production" | "development"; contractDigest: string; before: unknown;
}) {
  const data = prepared.get(proof), now = data?.clock();
  if (!data || data.firestore !== firestore || proof.environment !== environment || proof.contractDigest !== contractDigest ||
      now === undefined || !Number.isFinite(now) || now < data.preparedAt || now - data.preparedAt > 60_000 ||
      hash(pointer(before)) !== data.digests[2]) refuse();
  const rows = await transaction.getAll(...data.paths.map(path => firestore.doc(path)));
  const values = rows.map(row => row.data()); values[2] = pointer(values[2]);
  if (values.some((value, index) => hash(value) !== data.digests[index])) refuse();
  assertInstalledPublicReleaseConsumersFresh(proof);
  return proof;
}

/** Read-free final freshness check after the source guard has budgeted its
 * final reads. Only this module's original opaque preparation is accepted. */
export function assertInstalledPublicReleaseConsumersFresh(proof: PreparedInstalledConsumers) {
  const data = prepared.get(proof), now = data?.clock();
  if (!data || now === undefined || !Number.isFinite(now) || now < data.preparedAt || now - data.preparedAt > 60_000) refuse();
}
