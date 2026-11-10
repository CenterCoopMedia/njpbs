import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import targets from "../../functions/lib/publication-target.js";
import admission from "../../functions/lib/public-release-admission.js";
import activation from "../../functions/lib/public-release-content-activation.js";
import terminal from "../../functions/lib/public-release-terminal.js";
import work from "../../functions/lib/public-release-pair-work.js";
import serving from "../../functions/lib/public-release-serving.js";
import { readPublicReleasePairOutput } from "../../workers/src/public-release-view-reader";
import { openStagedPublicReleasePairCodePack } from "./public-release-pair-code-pack-executor";
import { openStagedPublicReleasePairComposite } from "./public-release-pair-composite-storage";
import type { PairViewStore } from "./public-release-pair-view-storage";
import type { PublicReleaseCanonicalIngress } from "./public-release-publication-terminal";
import { artifactFiles, assertPreparedPublicWorkerArtifact, verifyPreparedPublicWorkerArtifact } from "../src/lib/public-worker-artifact";

export const PUBLICATION_TIMING_GATE_MS = 10_000;
const SAMPLE_DEADLINE_MS = 60_000;
const BODY_LIMIT = 16 * 1024 * 1024;
const POLL_MS = 100;
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function refuse(code: string): never { throw new PublicationTimingRefusal(code); }
export class PublicationTimingRefusal extends Error {
  constructor(readonly code: string) { super(`Publication timing refused: ${code}`); }
}

export type PublicationTimingCase = Readonly<{
  operationId: string;
  sourceVersion: number;
  snapshotDigest: string;
  path: string;
  status: 200 | 302 | 308 | 410;
}>;
export type PublicationTimingCensus = Readonly<{
  artifactDigest: string;
  publicationReceiptDigest: string;
  htmlPaths: readonly string[];
  htmlPathsDigest: string;
}>;
export type PublicationTimingObservation = Readonly<{
  selector: PublicReleaseSelector;
  original: PublicationTimingCase;
  admissionDigest: string;
  activationReceiptDigest: string;
  terminalReceiptDigest: string | null;
  censusDigest: string;
  /** Digest from the actual selected immutable view, never a response header. */
  bodyDigest: string;
  contentType: string | null;
  response: Response;
  /** A fresh authority read AFTER consuming the canonical response body. */
  readSelector(): Promise<PublicReleaseSelector>;
}>;

/** The integration owner must bind the real original source dispatch, actual
 * remote capture/render/stage/activation and private ingress.prove transport.
 * The CLI admits only the repository adapter, which currently refuses missing
 * installations. This interface is not qualification or deployment authority.
 */
export type PublicationTimingTransport = Readonly<{
  preflight(input: { pair: PublicReleasePair; census: PublicationTimingCensus }): Promise<void>;
  publish(input: PublicationTimingCase, signal: AbortSignal): Promise<void>;
  observe(input: PublicationTimingCase, signal: AbortSignal): Promise<PublicationTimingObservation | null>;
}>;
export type PublicationTimingSample = Readonly<{
  operationId: string;
  status: "complete" | "refused" | "interrupted";
  elapsedMs: number | null;
  canonicalElapsedMs: number | null;
  withinGate: boolean;
  reason: string | null;
  admissionDigest: string | null;
  activationReceiptDigest: string | null;
  terminalReceiptDigest: string | null;
  selectorDigest: string | null;
  bodyDigest: string | null;
}>;

export function parsePublicationTimingCase(value: PublicationTimingCase): PublicationTimingCase {
  if (!value || Object.keys(value).sort().join(",") !== "operationId,path,snapshotDigest,sourceVersion,status" ||
      typeof value.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.operationId) ||
      !Number.isSafeInteger(value.sourceVersion) || value.sourceVersion < 1 ||
      !isDigest(value.snapshotDigest) || ![200, 302, 308, 410].includes(value.status) || typeof value.path !== "string" ||
      !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(value.path) ||
      value.path.split("/").some(part => part === "." || part === "..")) refuse("case-invalid");
  return Object.freeze({ ...value });
}
function assertDevelopment(pair: PublicReleasePair) {
  pair = protocol.parsePublicReleasePair(pair);
  if (pair.environment !== "development") refuse("non-production-target-required");
  return pair;
}

/** Setup is outside the sample clock. Verify actual retained artifact bytes;
 * a count supplied in a packet cannot stand in for the complete HTML census.
 */
export async function openPublicationTimingCensus(input: { distDirectory: string; preparedArtifact: unknown }): Promise<PublicationTimingCensus> {
  const prepared = await verifyPreparedPublicWorkerArtifact({ ...input,
    preparedArtifact: assertPreparedPublicWorkerArtifact(input.preparedArtifact) });
  const files = await artifactFiles(input.distDirectory);
  if (sha256(JSON.stringify({ schemaVersion: 1, digestAlgorithm: "sha256", files })) !== prepared.artifactDigest) refuse("verified-census-changed");
  const htmlPaths = files.filter(file => file.path.endsWith(".html")).map(file =>
    `/${file.path.replace(/(?:^|\/)index\.html$/, match => match.startsWith("/") ? "/" : "")}`).sort();
  if (!htmlPaths.length || new Set(htmlPaths).size !== htmlPaths.length) refuse("census-invalid");
  return Object.freeze({ artifactDigest: prepared.artifactDigest, publicationReceiptDigest: prepared.publicationReceiptDigest,
    htmlPaths: Object.freeze(htmlPaths), htmlPathsDigest: protocol.publicReleaseDigest(htmlPaths) });
}

async function consumeProof(response: Response, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return hash.digest("hex");
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await bounded(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) refuse("proof-body-too-large");
      hash.update(value);
    }
    return hash.digest("hex");
  } finally { await reader.cancel().catch(() => {}); }
}

async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new PublicationTimingRefusal("sample-deadline-or-cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function verifyObservation(pair: PublicReleasePair, census: PublicationTimingCensus,
  input: PublicationTimingCase, observed: PublicationTimingObservation, signal: AbortSignal) {
  const selector = protocol.parsePublicReleaseSelector(observed.selector);
  const response = observed.response;
  if (protocol.publicReleaseDigest(observed.original) !== protocol.publicReleaseDigest(input) ||
      protocol.publicReleaseDigest(selector.selectedPair) !== protocol.publicReleaseDigest(protocol.publicReleasePairReference(pair)) ||
      observed.censusDigest !== census.htmlPathsDigest ||
      ![observed.admissionDigest, observed.activationReceiptDigest, observed.bodyDigest].every(isDigest)) refuse("publication-identity-mismatch");
  if (response.status !== input.status || response.headers.get("content-type") !== observed.contentType ||
      response.headers.get("publication-refresh") === "pending" || response.headers.get("x-njpbs-publication-refresh") === "pending") refuse("canonical-proof-unavailable");
  const expected = {
    "x-njpbs-publication-origin": targets.publicationTarget("development").workerName,
    "x-njpbs-release-epoch": String(selector.epoch),
    "x-njpbs-release-pair": pair.pairId,
    "x-njpbs-content-head-sha256": selector.contentHead.manifestDigest,
    "x-njpbs-selector-sha256": protocol.publicReleaseDigest(selector),
    "x-njpbs-publication-operation": input.operationId,
    "x-njpbs-source-version": String(input.sourceVersion),
    "x-njpbs-snapshot-sha256": input.snapshotDigest,
    "x-njpbs-renderer-sha": pair.commitSha,
    "x-njpbs-html-sha256": observed.bodyDigest,
  };
  for (const [header, value] of Object.entries(expected)) if (response.headers.get(header) !== value) refuse("canonical-proof-identity-mismatch");
  const bodyDigest = await consumeProof(response, signal);
  if (bodyDigest !== observed.bodyDigest || input.status === 410 && bodyDigest !== sha256("")) refuse("canonical-byte-mismatch");
  const after = protocol.parsePublicReleaseSelector(await bounded(observed.readSelector(), signal));
  if (protocol.publicReleaseDigest(after) !== protocol.publicReleaseDigest(selector)) refuse("authority-changed-during-proof");
  if (observed.terminalReceiptDigest !== null && !isDigest(observed.terminalReceiptDigest)) refuse("terminal-receipt-invalid");
  return { selectorDigest: protocol.publicReleaseDigest(selector), bodyDigest };
}

function failedSample(operationId: string, reason: string, elapsedMs: number | null): PublicationTimingSample {
  return { operationId, status: elapsedMs === null ? "interrupted" : "refused", elapsedMs, canonicalElapsedMs: null, withinGate: false,
    reason, admissionDigest: null, activationReceiptDigest: null, terminalReceiptDigest: null, selectorDigest: null, bodyDigest: null };
}

/** One client monotonic clock spans original dispatch, capture, remote I/O,
 * rendering, staging, activation, exact canonical bytes and terminal readback.
 * Preflight and journal writes are setup; no server clocks are added together.
 */
export async function timePublicReleasePairPublication({ pair: rawPair, census, input: rawInput, transport, signal,
  now = () => performance.now() }: {
  pair: PublicReleasePair; census: PublicationTimingCensus; input: PublicationTimingCase;
  transport: PublicationTimingTransport; signal?: AbortSignal; now?: () => number;
}): Promise<PublicationTimingSample> {
  const pair = assertDevelopment(rawPair), input = parsePublicationTimingCase(rawInput);
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(SAMPLE_DEADLINE_MS)]);
  const started = now();
  let canonicalElapsedMs: number | null = null;
  try {
    deadline.throwIfAborted();
    await bounded(transport.publish(input, deadline), deadline);
    for (;;) {
      deadline.throwIfAborted();
      const observed = await bounded(transport.observe(input, deadline), deadline);
      if (!observed) { await delay(POLL_MS, undefined, { signal: deadline }); continue; }
      try {
        const proof = await verifyObservation(pair, census, input, observed, deadline);
        canonicalElapsedMs ??= now() - started;
        if (observed.terminalReceiptDigest === null) { await delay(POLL_MS, undefined, { signal: deadline }); continue; }
        const elapsedMs = now() - started;
        if (!Number.isFinite(elapsedMs) || elapsedMs < 0) refuse("monotonic-clock-invalid");
        return { operationId: input.operationId, status: "complete", elapsedMs, canonicalElapsedMs,
          withinGate: canonicalElapsedMs <= PUBLICATION_TIMING_GATE_MS, reason: null,
          admissionDigest: observed.admissionDigest, activationReceiptDigest: observed.activationReceiptDigest,
          terminalReceiptDigest: observed.terminalReceiptDigest, ...proof };
      } finally { if (observed.response.body && !observed.response.body.locked) await observed.response.body.cancel().catch(() => {}); }
    }
  } catch (error) {
    return failedSample(input.operationId, error instanceof PublicationTimingRefusal ? error.code :
      deadline.aborted ? "sample-deadline-or-cancelled" : "publication-transport-refused", now() - started);
  }
}

export function publicationTimingSummary(samples: readonly PublicationTimingSample[]) {
  if (new Set(samples.map(sample => sample.operationId)).size !== samples.length) refuse("sample-operation-repeated");
  const complete = samples.filter(sample => sample.status === "complete");
  if (complete.some(sample => !Number.isFinite(sample.canonicalElapsedMs) || sample.canonicalElapsedMs! < 0 ||
      !Number.isFinite(sample.elapsedMs) || sample.elapsedMs! < sample.canonicalElapsedMs! ||
      ![sample.admissionDigest, sample.activationReceiptDigest, sample.terminalReceiptDigest, sample.selectorDigest, sample.bodyDigest].every(isDigest))) refuse("completed-sample-invalid");
  const elapsed = complete.map(sample => sample.canonicalElapsedMs!).sort((a, b) => a - b);
  const quantile = (p: number) => elapsed.length ? elapsed[Math.ceil(p * elapsed.length) - 1] : null;
  return Object.freeze({ sampleCount: samples.length, completedCount: complete.length,
    failedCount: samples.length - complete.length, p50Ms: quantile(0.5), p95Ms: quantile(0.95),
    maxMs: elapsed.at(-1) ?? null, gateMs: PUBLICATION_TIMING_GATE_MS,
    metric: "Original dispatch to complete canonical-byte proof; terminal readback is separately elapsedMs",
    pollIntervalMs: POLL_MS,
    percentileMethod: "nearest rank", p95Resolution: "At least 20 complete samples are required for a gate result",
    gatePassed: samples.length >= 20 && complete.length === samples.length && elapsed.every(ms => ms <= PUBLICATION_TIMING_GATE_MS) });
}

/** Create the durable start marker before dispatch. If this client crashes,
 * its monotonic clock is lost: retain an interrupted sample and never publish
 * that operation again. Recovery of the publication belongs to its real owner.
 */
export async function runPublicationTimingSession({ pair: rawPair, census, cases, outputDirectory, transport }: {
  pair: PublicReleasePair; census: PublicationTimingCensus; cases: readonly PublicationTimingCase[];
  outputDirectory: string; transport?: PublicationTimingTransport;
}) {
  const pair = assertDevelopment(rawPair), inputs = cases.map(parsePublicationTimingCase);
  if (!inputs.length || inputs.length > 100 || new Set(inputs.map(input => input.operationId)).size !== inputs.length ||
      !isDigest(census.artifactDigest) || !isDigest(census.publicationReceiptDigest) || !census.htmlPaths.length ||
      protocol.publicReleaseDigest(census.htmlPaths) !== census.htmlPathsDigest) refuse("session-packet-invalid");
  const installed = transport ?? await openInstalledPublicationTimingTransport();
  await installed.preflight({ pair, census });
  const packet = { schemaVersion: 1, pair, census, cases: inputs }, packetDigest = protocol.publicReleaseDigest(packet);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const lock = path.join(outputDirectory, "client.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid, packetDigest }), { flag: "wx", mode: 0o600 });
  try {
    const packetPath = path.join(outputDirectory, "packet.json");
    let existing: unknown;
    try { existing = JSON.parse(await readFile(packetPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing !== undefined && protocol.publicReleaseDigest(existing) !== packetDigest) refuse("session-packet-changed");
    if (existing === undefined) await writeFile(packetPath, JSON.stringify(packet), { flag: "wx", mode: 0o600 });
    const samples: PublicationTimingSample[] = [];
    for (const input of inputs) {
      const key = protocol.publicReleaseDigest(input), startPath = path.join(outputDirectory, `${key}.started.json`),
        samplePath = path.join(outputDirectory, `${key}.sample.json`);
      let previous: PublicationTimingSample | undefined;
      try { previous = JSON.parse(await readFile(samplePath, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (previous) { samples.push(previous); continue; }
      let interrupted = false;
      try { await writeFile(startPath, JSON.stringify({ packetDigest, inputDigest: key, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; interrupted = true; }
      const sample = interrupted ? failedSample(input.operationId, "prior-client-clock-lost", null) :
        await timePublicReleasePairPublication({ pair, census, input, transport: installed });
      await writeFile(samplePath, JSON.stringify(sample), { flag: "wx", mode: 0o600 });
      samples.push(sample);
    }
    const report = { schemaVersion: 1, kind: "pair-publication-timing", grantsNothing: true, packetDigest,
      measuredAt: new Date().toISOString(), census, samples, summary: publicationTimingSummary(samples) };
    await writeFile(path.join(outputDirectory, `report-${randomUUID()}.json`), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return report;
  } finally { await unlink(lock); }
}

export const publicationTimingMissingBindings = Object.freeze([
  "installed-private-publisher", "isolated-development-ingress",
  "original-source-dispatch", "per-publication-activation", "canonical-terminal-settlement",
]);

/** The rehearsal setup owns dispatch and installed runtime checks. These are
 * live process bindings, never packet-supplied receipts or serialized success.
 * The timing observer has no activation, settlement or storage writer.
 */
export type InstalledPublicationTimingSetup = Readonly<{
  /** Actual development SDK client, or the explicitly isolated demo client. */
  firestore: Firestore;
  /** Actual immutable H/G object reader; the observer has no storage writer. */
  store: Pick<PairViewStore, "get">;
  /** Existing private canonical GET proof RPC, including 200/308/410 bytes. */
  ingress: PublicReleaseCanonicalIngress;
  /** Verify publisher/ingress and continuation bindings without warming them. */
  assertInstalled(pair: PublicReleasePair): Promise<void>;
  /** Dispatch the original source transaction; refuse any idempotent replay. */
  dispatch(input: PublicationTimingCase, signal: AbortSignal): Promise<void>;
}>;

const same = (left: unknown, right: unknown) => protocol.publicReleaseDigest(left) === protocol.publicReleaseDigest(right);

/** Disabled calls do not touch the setup. Only the existing rehearsal owner
 * supplies the installed publisher/ingress and original source transaction.
 */
export async function openInstalledPublicationTimingTransport(options?: {
  enabled?: boolean; setup: InstalledPublicationTimingSetup;
}): Promise<PublicationTimingTransport> {
  if (options?.enabled !== true) refuse("installed-publication-timing-bindings-missing");
  const setup = options.setup;
  if (!setup || typeof setup.assertInstalled !== "function" || typeof setup.dispatch !== "function" ||
      typeof setup.ingress?.prove !== "function" || typeof setup.store?.get !== "function") refuse("installed-publication-timing-bindings-missing");
  const { firestore, ingress } = setup;
  const store: PairViewStore = { get: key => setup.store.get(key),
    put: async () => refuse("timing-observer-store-read-only") };
  let session: { pair: PublicReleasePair; census: PublicationTimingCensus } | undefined;
  const dispatched = new Map<string, PublicationTimingCase>();
  const current = () => {
    if (!session) refuse("timing-preflight-required");
    return session;
  };
  const readSelector = async () => (await serving.readPublicReleaseSelector({ firestore, environment: "development" })).selector;
  const assertPair = async (pair: PublicReleasePair) => {
    work.assertPublicReleasePairDatabase(firestore, pair);
    const [registered, control, billing] = await firestore.getAll(firestore.doc(work.publicReleasePairPath(pair.pairId)),
      firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`), firestore.doc("system/billing"));
    if (!same(protocol.parsePublicReleasePair(registered.data()), pair) || control.data()?.schemaVersion !== 2 ||
        control.data()?.pairId !== pair.pairId || control.data()?.status !== "retained" || billing.data()?.disabled === true ||
        !same((await readSelector()).selectedPair, protocol.publicReleasePairReference(pair))) refuse("installed-timing-pair-unavailable");
  };
  return Object.freeze({
    async preflight({ pair: rawPair, census }: { pair: PublicReleasePair; census: PublicationTimingCensus }) {
      const pair = assertDevelopment(rawPair);
      if (session && (!same(pair, session.pair) || !same(census, session.census))) refuse("timing-preflight-changed");
      // Check database identity before either installed setup callback can run.
      work.assertPublicReleasePairDatabase(firestore, pair);
      await setup.assertInstalled(pair);
      await assertPair(pair);
      const baseline = await openStagedPublicReleasePairCodePack({ firestore, store, pair });
      await baseline.verifyAll();
      const publication = await baseline.readMember("/_publication.json");
      const htmlPaths = baseline.manifest.members.filter(member => member.mime.startsWith("text/html"))
        .map(member => member.path.replace(/\/index\.html$/, "/")).sort();
      if (sha256(publication) !== census.publicationReceiptDigest || JSON.parse(new TextDecoder().decode(publication)).artifactDigest !== census.artifactDigest ||
          !same(htmlPaths, census.htmlPaths) || protocol.publicReleaseDigest(htmlPaths) !== census.htmlPathsDigest) refuse("installed-timing-census-mismatch");
      session = { pair, census: Object.freeze({ ...census, htmlPaths: Object.freeze([...census.htmlPaths]) }) };
    },
    async publish(raw: PublicationTimingCase, signal: AbortSignal) {
      const { pair } = current(), input = parsePublicationTimingCase(raw);
      signal.throwIfAborted();
      await assertPair(pair);
      const rows = await firestore.getAll(firestore.doc(`${admission.ADMISSIONS}/operations/${input.operationId}`),
        firestore.doc(`cmsPublishQueue/${input.operationId}`));
      if (dispatched.has(input.operationId) || rows.some(row => row.exists)) refuse("timing-original-dispatch-repeated");
      // Record before the call: an ambiguous dispatch never gets a second send.
      dispatched.set(input.operationId, input);
      signal.throwIfAborted();
      await setup.dispatch(input, signal);
    },
    async observe(raw: PublicationTimingCase, signal: AbortSignal): Promise<PublicationTimingObservation | null> {
      const { pair, census } = current(), input = parsePublicationTimingCase(raw);
      if (!same(dispatched.get(input.operationId) ?? null, input)) refuse("timing-original-dispatch-required");
      signal.throwIfAborted();
      const state = await firestore.runTransaction(async transaction => {
        const [acceptedRow, queueRow, activationRow, terminalRow] = await transaction.getAll(
          firestore.doc(`${admission.ADMISSIONS}/operations/${input.operationId}`), firestore.doc(`cmsPublishQueue/${input.operationId}`),
          firestore.doc(activation.activationPath(pair, input.operationId)), firestore.doc(`${terminal.TERMINAL_RECEIPTS}/${input.operationId}`));
        if (!acceptedRow.exists && !queueRow.exists) return null;
        const accepted = admission.parseAdmission(acceptedRow.data()), queue = queueRow.data();
        admission.assertQueue(queue, accepted);
        if (accepted.operationId !== input.operationId || accepted.source.sourceVersion !== input.sourceVersion ||
            accepted.source.snapshotDigest !== input.snapshotDigest || !same(accepted.pair, protocol.publicReleasePairReference(pair)) ||
            accepted.pairDigest !== protocol.publicReleaseDigest(pair)) refuse("timing-original-admission-mismatch");
        if (!activationRow.exists) {
          if (terminalRow.exists || !["pending", "publishing"].includes(queue?.status)) refuse("timing-original-publication-failed");
          return null;
        }
        const activated = activation.parseContentActivationRecord(activationRow.data(), activationRow.data()!.attempt);
        const execution = terminal.parseCompletedPairPublicationExecution(queue?.execution);
        if (!same(activated.admission, accepted) || !same(activated.attempt.pair, pair) ||
            activated.attempt.originalView.claimDigest !== execution.claimDigest || activated.attempt.originalView.manifestDigest !== execution.manifestDigest ||
            !same(activated.attempt.originalView.identity, execution.identity)) refuse("timing-original-activation-mismatch");
        await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair,
          taskId: execution.taskId, claimDigest: execution.claimDigest, manifestDigest: execution.manifestDigest });
        const receipt = terminalRow.exists ? await terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction,
          operationId: input.operationId, admissionDigest: protocol.publicReleaseDigest(accepted) }) : null;
        if (receipt ? receipt.outcome !== "success" || receipt.activation.kind !== "pair-publication" ||
            receipt.activation.receiptDigest !== protocol.publicReleaseDigest(activated) : !["pending", "publishing"].includes(queue?.status)) refuse("timing-original-terminal-mismatch");
        return { accepted, activated, execution, receipt };
      }, { readOnly: true });
      if (!state) return null;
      const composite = await openStagedPublicReleasePairComposite({ firestore, store, pair, identity: state.execution.identity,
        claimDigest: state.execution.claimDigest, viewManifestDigest: state.execution.manifestDigest, signal });
      // Exhaust actual original H/G through its existing full-census owner.
      await composite.verifyAll();
      const selection = await serving.readPublicReleaseSelector({ firestore, environment: "development" });
      if (!same(selection.selector.selectedPair, protocol.publicReleasePairReference(pair)) ||
          selection.selector.contentHead.contextSequence < state.accepted.changeSequence) refuse("timing-selected-pair-changed");
      const decision = await serving.readPublicReleaseDecision({ firestore, environment: "development", pair,
        selection, path: input.path, composedReadersEnabled: true });
      if (decision.kind !== "decision" || decision.route.kind === "unowned" || decision.route.operationId !== input.operationId ||
          decision.route.sourceVersion !== input.sourceVersion || decision.route.snapshotDigest !== input.snapshotDigest) refuse("timing-selected-route-mismatch");
      // The private ingress owner verifies route targets and any separate
      // proofLocator. This immutable read supplies the independent body oracle.
      const selected = decision.route.kind === "serve" ? await readPublicReleasePairOutput({ store, pair, locator: decision.locator,
        path: decision.composition?.artifactPath ?? input.path }) : null;
      const status = decision.route.kind === "gone" ? 410 : decision.route.kind === "redirect" ? 308 : selected?.status;
      if (status !== input.status) refuse("timing-selected-status-mismatch");
      const bodyDigest = selected?.bodyDigest ?? sha256("");
      const response = await ingress.prove(new Request(`${targets.publicationTarget("development").origin}${input.path}`,
        { method: "GET", redirect: "manual", signal }), bodyDigest, { status: input.status });
      if (!["no-store", "private, no-store"].includes(response.headers.get("cache-control") ?? "") ||
          response.headers.get("location") !== (decision.route.kind === "redirect" ? decision.route.canonicalPath : status === 302 ? selected?.headers.location : null) ||
          status === 302 && response.headers.get("x-robots-tag") !== "noindex, nofollow") {
        await response.body?.cancel(); refuse("timing-canonical-response-mismatch");
      }
      return { selector: selection.selector, original: input, admissionDigest: protocol.publicReleaseDigest(state.accepted),
        activationReceiptDigest: protocol.publicReleaseDigest(state.activated), terminalReceiptDigest: state.receipt ? protocol.publicReleaseDigest(state.receipt) : null,
        censusDigest: census.htmlPathsDigest, bodyDigest, contentType: selected?.headers["content-type"] ?? null,
        response, readSelector };
    },
  });
}
