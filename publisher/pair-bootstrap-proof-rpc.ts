import type { PublicReleasePair } from "../packages/content-core/src/public-release";
import type { PairCanonicalProofBinding } from "./pair-terminal-rpc";
import protocol from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
import fence from "../functions/lib/public-release-bootstrap-admission.js";
import runtime from "../functions/lib/cms-publication-runtime-control.js";
import targets from "../functions/lib/publication-target.js";
import admission from "../functions/lib/public-release-admission-contract.js";
import media from "../functions/lib/public-release-pair-media.js";
import { isPublicPairRequestPath } from "../workers/src/public-release-view-reader";
import { originFor } from "../packages/content-core/src/public-release-routing";

type Authority = { pair: PublicReleasePair; read(path: string): Promise<Record<string, unknown> | null> };
const hash = protocol.publicReleaseDigest;
function observed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(observed);
  if (value && typeof value === "object") {
    if ("toMillis" in value && typeof value.toMillis === "function") {
      const millis = value.toMillis();
      if (!Number.isFinite(millis)) throw new Error("Bootstrap proof refused");
      return { timestampMillis: millis };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, observed(item)]));
  }
  return value;
}
const same = (a: unknown, b: unknown) => hash(observed(a)) === hash(observed(b));
const WRITER_PATH = "system/publicDeployment/releaseWriter/fence";
function exact(raw: unknown, fields: string[]): Record<string, any> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== fields.length ||
      fields.some(key => !Object.hasOwn(raw, key))) throw new Error("Bootstrap proof refused");
  return raw as Record<string, any>;
}
const CONTROL_PATHS = ["system/cmsPublicationRuntime", "system/noBuildPostAdmission", "system/publicDeployment/noBuildPosts/capability",
  "system/publicDeployment/noBuildPages/capability", "system/publicDeployment/noBuildRecords/capability",
  "system/publicDeployment/noBuildRecordFamilies/current", "system/publicReleaseChangeLog",
  "system/publicReleaseAdmissions/controls/adoption", "system/publicReleaseAdmissions"];

/** Only the bootstrap operator's own process calls this with code-level mode
 * enabled. No ordinary publisher binding, environment flag or request sets it.
 * Read-only epoch-one proof; it grants no object transport or admission. */
export async function pairBootstrapProofRpc(request: Request, authority: Authority, ingress: PairCanonicalProofBinding): Promise<Response> {
  const refuse = () => new Response(null, { status: 403 });
  let response: Response | undefined;
  try {
    const url = new URL(request.url), pair = protocol.parsePublicReleasePair(authority.pair);
    if (request.method !== "GET" || url.protocol !== "http:" || url.hostname !== "pair-terminal.internal" || url.port ||
        url.username || url.password || url.hash || url.pathname !== "/bootstrap-prove" ||
        [...url.searchParams.keys()].sort().join(",") !== "digest,path,status" || !ingress || typeof ingress.prove !== "function") return refuse();
    work.assertPrivatePairResources(pair);
    const path = url.searchParams.get("path")!, digest = url.searchParams.get("digest")!, status = Number(url.searchParams.get("status"));
    if (!isPublicPairRequestPath(path) || path.startsWith("/_pair-") || !/^[a-f0-9]{64}$/.test(digest) ||
        String(status) !== url.searchParams.get("status") || ![200, 302, 308, 410].includes(status)) return refuse();
    const base = work.publicReleasePairPath(pair.pairId);
    const initialPaths = ["system/publicDeployment", fence.BOOTSTRAP_ADMISSION_FENCE_PATH];
    const initial = await Promise.all(initialPaths.map(path => authority.read(path)));
    const selector = protocol.parseStoredPublicReleaseSelector(initial[0]);
    const closed = fence.parseBootstrapAdmissionFence(initial[1]);
    if (selector.epoch !== 1 || selector.state !== "idle" || selector.mediaLifecycleReady !== true || closed.status !== "closed" ||
        selector.switchOperationId !== closed.operationId || !same(selector.selectedPair, protocol.publicReleasePairReference(pair))) return refuse();
    const operationId = closed.operationId;
    const paths = [...initialPaths, WRITER_PATH, `${fence.BOOTSTRAP_ADMISSION_ATTEMPTS}/${operationId}`,
      `system/publicDeployment/bootstrapSelectors/${operationId}`, `system/publicReleaseAdmissions/bootstrapControls/${operationId}`,
      "system/publicReleaseChanges/enrollment/initial", "system/publicReleaseChanges", "system/publicDeployment/pairMedia/current",
      "cmsDeploymentReceipts/functions", "cmsReaderCompatibilityReceipts/functions", "system/billing", base, `${base}/controls/runtime`, ...CONTROL_PATHS,
      `${admission.CONTRACTS}/${selector.admittedContractDigest}`, `${base}/heads/current`];
    const rows: Array<Record<string, any> | null> = await Promise.all(paths.map(path => authority.read(path)));
    if (!same(rows[0], initial[0]) || !same(rows[1], initial[1]) || rows[11]?.disabled === true ||
        !same(rows[2], { schemaVersion: 2, operationId, attemptDigest: closed.attemptDigest }) ||
        !same(protocol.parsePublicReleasePair(rows[12]), pair) ||
        !same(rows[13], { schemaVersion: 2, pairId: pair.pairId, status: "retained" })) return refuse();
    const attempt = exact(rows[3], ["schemaVersion", "operationId", "environment", "legacyPointerDigest"]);
    const legacy = { schemaVersion: 1, ...Object.fromEntries(["mediaLifecycleReady", "state", "activeGeneration", "activeDeploymentId",
      "activeCommitSha", "lastReservedGeneration", "newestEligibleGeneration", "newestEligibleBuildBatchId"].map(key => [key, rows[0]![key]])) };
    if (attempt.schemaVersion !== 2 || attempt.operationId !== operationId || attempt.environment !== pair.environment ||
        hash(attempt) !== closed.attemptDigest || attempt.legacyPointerDigest !== hash(legacy)) return refuse();
    const receipt = exact(rows[4], ["schemaVersion", "kind", "operationId", "attemptDigest", "sourceDigest", "selectorDigest", "storedSelectorDigest", "mediaDigest", "selector"]);
    if (receipt.schemaVersion !== 2 || receipt.kind !== "public-release-bootstrap" || receipt.operationId !== operationId ||
        typeof receipt.attemptDigest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.attemptDigest) || receipt.sourceDigest !== selector.priorSelectorDigest ||
        receipt.selectorDigest !== hash(selector) || typeof receipt.storedSelectorDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(receipt.storedSelectorDigest) || !same(protocol.parsePublicReleaseSelector(receipt.selector), selector) ||
        receipt.mediaDigest !== hash(media.parsePairMedia(rows[8], selector)) || hash(rows[23]) !== selector.admittedContractDigest ||
        !same(rows[24], { schemaVersion: 2, pairDigest: hash(pair), contentHead: selector.contentHead })) return refuse();
    const controls = exact(rows[5], ["schemaVersion", "kind", "attempt", "attemptDigest", "enrollmentReceiptDigest", "installed", "before", "after"]);
    const installed = controls.installed, liveControls = rows.slice(14, 23), pins = runtime.parseCmsPublicationRuntimeControl(liveControls[0]);
    const serializerId = targets.publicationTarget(pair.environment).serializerId;
    if ([pins, pins.cloud].some(pin => pin?.phase !== "ready" || pin.commitSha !== pair.commitSha || pin.serializerId !== serializerId) ||
        liveControls.slice(2, 5).some(capability => capability?.servingEnabled !== true || capability.rendererSha !== pair.commitSha ||
          capability.generation !== selector.activeGeneration) || !same(admission.parseAdmissionHead(liveControls[8]), admission.initialAdmissionHead())) return refuse();
    if (controls.schemaVersion !== 2 || controls.kind !== "public-release-bootstrap-controls" || hash(controls.attempt) !== controls.attemptDigest ||
        controls.attempt?.operationId !== operationId || !same(controls.attempt?.pair, pair) ||
        controls.attempt?.admittedContractDigest !== selector.admittedContractDigest || !same(controls.after, liveControls) ||
        controls.enrollmentReceiptDigest !== hash(rows[6]) || rows[6]?.kind !== "initial-public-release-change-enrollment" ||
        !same(rows[6]?.initialHead, rows[7]) || rows[7]?.sequence !== 0 ||
        !same(liveControls[7], { schemaVersion: 2, enabled: false }) || liveControls[6]?.enabled !== false ||
        rows[9]?.state !== "complete" || rows[9]?.mutation?.sourceSha !== installed?.sourceSha ||
        hash(rows[9]) !== installed?.deploymentReceiptDigest || hash(rows[10]) !== installed?.readerReceiptDigest ||
        installed?.contractDigest !== selector.admittedContractDigest) return refuse();
    response = await ingress.prove(new Request(`${originFor(pair.environment)}${path}`, { method: "GET", redirect: "manual", signal: request.signal }),
      digest, { status: status as 200 | 302 | 308 | 410 });
    // selectorDigest seals every authoritative root field. storedSelectorDigest
    // also contains the SDK Timestamp's representation, which this REST reader
    // cannot reproduce. Compare decoded timestamps across the proof separately.
    const after = await Promise.all(paths.map(path => authority.read(path)));
    if (!same(rows, after)) { await response.body?.cancel(); return refuse(); }
    return response;
  } catch { await response?.body?.cancel().catch(() => {}); return refuse(); }
}
