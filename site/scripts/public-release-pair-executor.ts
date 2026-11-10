import { projectPublicReleasePairStaticArtifact, publicReleasePairStaticAliasTargets, recomputePublicReleasePairStaticArtifact } from "./public-release-pair-static-artifact";
import { writePublicReleasePairStaticTarget, recordPublicReleasePairStaticTargetClaim } from "./public-release-pair-static-target-storage";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { exact } from "./public-release-pair-reader-contract";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import input from "../../functions/lib/public-release-pair-input.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import views from "../../functions/lib/public-release-pair-view.js";
import { openPublicReleasePairInput } from "./public-release-pair-input-storage";
import { openPublicReleasePairRenderPlans } from "./public-release-pair-render-plans";
import { writePublicReleasePairView, type PairViewStore } from "./public-release-pair-view-storage";
import { stagePublicReleasePairView } from "./public-release-pair-view-staging";
import { verifyPublicReleasePairRenderer } from "./public-release-pair-renderer-release.mjs";
import { privatePreviewSandbox } from "./process-cms-preview";
import { PAIR_REPLAY_PROVENANCE_FILE, isPublicReleasePairProjection, projectPublicReleasePairReplay,
  parsePublicReleasePairReplayTargetReceipt, type PairReplayContext } from "./public-release-pair-replay";
import { writePublicReleasePairReplayProof, preparePublicReleasePairReplayReadback } from "./public-release-pair-replay-storage";
import { PAIR_CODE_PACK_FILE } from "./public-release-pair-code-pack";
import { executePublicReleasePairCodePack, stagePublicReleasePairCodePack } from "./public-release-pair-code-pack-executor";
import { openPublicReleasePairCompositeAuthority, stagePublicReleasePairComposite } from "./public-release-pair-composite-storage";
import { deriveFrozenPublicReleasePairCatalogImages } from "./public-release-pair-catalog-image-storage";
import { publicReleasePairRequiredBaselineMembers } from "./public-release-pair-aggregate-outputs";
import { restorePublicReleasePairPagefindEngine } from "./public-release-pair-pagefind-engine";
import { restorePublicReleasePairSemanticEngine } from "./public-release-pair-semantic-engine";
import composite from "../../functions/lib/public-release-pair-composite-view.js";
import type { PairCompositeMember } from "../../functions/lib/public-release-pair-composite-view";
import { readPublicReleasePairOutputFile } from "./public-release-pair-output-file";
import { publicReleasePairExecutionRenewal } from "./public-release-pair-execution-renewal";
import { publicReleasePairSemanticReuse } from "./public-release-pair-semantic-reuse";
import { derivePublicReleasePairAuthors } from "./public-release-pair-author";
import { materializePublicReleasePairInput } from "./public-release-pair-materialize";
import { withPublicReleasePairVerifiedReads } from "./public-release-pair-verified-read";
import type { PairPublicationActivation } from "./public-release-pair-activation-outbox";
import { createPairPreviewContextSideWriter, retainPairPreviewContext, type PairPreviewContextOutput } from "./public-release-pair-preview-context";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const compiled = path.join(repository, "site/.public-post-renderer");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }

/** Only H's frozen file set enters the existing offline OS sandbox. Neither
 * SDK handles, credentials, a claim token nor the parent's environment enter it. */
export function createPublicReleasePairExecutor({ firestore, store, pair: rawPair, clock = Date.now, publication, previewContextOutput, originalRecovery }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; clock?: () => number; publication?: PairPublicationActivation;
  previewContextOutput?: (input: PairPreviewContextOutput) => Promise<unknown>;
  originalRecovery?: { enabled: boolean; limit?: number; capture?: import("./public-release-original-work-recovery").OriginalWorkRecoveryOptions["capture"] };
}) {
  const pair = protocol.parsePublicReleasePair(rawPair);
  work.assertPrivatePairResources(pair);
  const base = work.publicReleasePairPath(pair.pairId);
  const semanticReuse = publicReleasePairSemanticReuse(pair, async () => (await firestore.doc("system/publicDeployment").get()).data());
  if (originalRecovery?.enabled === true && typeof publication?.activate !== "function") refuse();
  const beforePoll = originalRecovery?.enabled === true ? async ({ signal }: { signal?: AbortSignal }) => {
    const [root, adopted] = await firestore.getAll(firestore.doc("system/publicDeployment"), firestore.doc("system/publicReleaseAdmissions/controls/adoption"));
    if (root.data()?.schemaVersion !== 2 || adopted.data()?.enabled !== true) return;
    protocol.parseStoredPublicReleaseSelector(root.data());
    exact(adopted.data(), ["schemaVersion", "enabled"]);
    if (adopted.data()?.schemaVersion !== 2) refuse();
    const owner = await import("./public-release-original-work-recovery");
    await owner.recoverDueOriginalPublicReleaseWork({ firestore, store, pair, now: clock, signal,
      capture: originalRecovery.capture, limit: originalRecovery.limit ?? 1 });
  } : undefined;
  const openFrozenInput = async (identity: PairTaskIdentity, signal?: AbortSignal, readStore = store) => {
    const scope = input.parsePublicReleasePairInputScope({ kind: identity.kind, sourceOperationId: identity.sourceOperationId,
      sourceVersion: identity.sourceVersion, snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence });
    const authority = await firestore.runTransaction(transaction => work.assertPublicReleasePairInputOwnerInTransaction({
      firestore, transaction, pair, scope, inputManifestDigest: identity.inputManifestDigest }), { readOnly: true });
    if (!authority.receipt) refuse();
    return openPublicReleasePairInput({ firestore, store: readStore, pair, identity,
      expectedSource: authority.receipt.source, expectedCursor: authority.receipt.cursor, signal });
  };
  const previewContext = createPairPreviewContextSideWriter<PairPreviewContextOutput>(async original => {
    // Use a separately opened immutable read handle. The task's lease signal and
    // temporary sandbox directory end when normal publication completes.
    const frozen = await openFrozenInput(original.identity);
    if (protocol.publicReleaseDigest(frozen.root) !== protocol.publicReleaseDigest(original.root)) refuse();
    const write = previewContextOutput ?? (input => retainPairPreviewContext({ firestore, ...input }));
    return write({ ...original, root: frozen.root, readFrozenFile: frozen.readFile });
  });
  const stage = async ({ identity, claimDigest, manifestDigest, signal }: {
    identity: PairTaskIdentity; claimDigest: string; manifestDigest: string; signal?: AbortSignal;
  }) => withPublicReleasePairVerifiedReads(store, async store => {
    const frozen = await openFrozenInput(identity, signal, store);
    let semanticBytes: Uint8Array | undefined;
    if (frozen.root.entryFiles.includes(PAIR_CODE_PACK_FILE)) {
      await stagePublicReleasePairCodePack({ firestore, store, pair, identity, claimDigest, viewManifestDigest: manifestDigest, signal });
    } else if (frozen.root.files.some(file => file.name === PAIR_CODE_PACK_FILE)) {
      const staged = await stagePublicReleasePairComposite({ firestore, store, pair, identity, claimDigest, viewManifestDigest: manifestDigest, signal });
      semanticBytes = staged.semanticBytes;
    } else {
      const replay = await preparePublicReleasePairReplayReadback({ firestore, store, pair, identity, claimDigest,
        viewManifestDigest: manifestDigest, signal });
      await stagePublicReleasePairView({ firestore, store, pair, identity, claimDigest, manifestDigest, signal, verify: replay });
      await replay.persist();
    }
    signal?.throwIfAborted();
    await semanticReuse.staged(identity, claimDigest, semanticBytes);
    if (publication && ["accepted", "recovery"].includes(identity.kind)) {
      const { handoffPublicReleasePairActivation, recoverPublicReleasePairActivations } = await import("./public-release-pair-activation-outbox");
      const { taskId, activationRequired } = await handoffPublicReleasePairActivation({ firestore, store, pair, identity, claimDigest, manifestDigest, signal });
      if (activationRequired) await recoverPublicReleasePairActivations({ firestore, store, pair, publication, taskId, signal, now: clock });
      return;
    }
    // The outbox and receipt were created atomically. G has now revalidated
    // their owner and actual bytes; deleting only this exact task is safe.
    await firestore.doc(`${base}/staging/${protocol.publicReleaseDigest(identity)}`).delete();
  });
  const receiptOf = (value: Record<string, any>, taskId: string) => {
    if (value.schemaVersion !== 2 || value.taskId !== taskId || protocol.publicReleaseDigest(value.identity) !== taskId ||
        !/^[a-f0-9]{64}$/.test(value.claimDigest) || !/^[a-f0-9]{64}$/.test(value.manifestDigest)) refuse();
    const identity = views.parseViewIdentity(value.identity, pair);
    return { schemaVersion: 2, taskId, identity, claimDigest: value.claimDigest as string, manifestDigest: value.manifestDigest as string };
  };
  const recoverStaging = async (signal?: AbortSignal) => {
    // A bad view cannot starve unrelated due work. Keep the original immutable
    // receipt, back off twice, then quarantine it for explicit exact-byte repair.
    // Process one bounded snapshot per wake. A slow unavailable object cannot
    // become due again inside this same recovery pass and monopolize draining.
    {
      signal?.throwIfAborted();
      await work.readPublicReleasePairWork({ firestore, pair });
      if ((await firestore.doc("system/billing").get()).data()?.disabled === true) return;
      const pending = await firestore.collection(`${base}/staging`).where("nextAttemptAt", "<=", clock()).limit(20).get();
      if (pending.empty) return;
      for (const row of pending.docs) {
        const value = row.data();
        try {
          if (Object.keys(value).sort().join(",") !== "attempts,claimDigest,identity,lastFailure,manifestDigest,nextAttemptAt,schemaVersion,taskId" ||
              !Number.isInteger(value.attempts) || value.attempts < 0 || value.attempts > 2 ||
              !Number.isSafeInteger(value.nextAttemptAt) || value.nextAttemptAt < 0) refuse();
          await stage({ ...receiptOf(value, row.id), signal });
        } catch (error) {
          signal?.throwIfAborted();
          // Global authority/billing loss stops recovery without consuming an
          // individual view's retries. A per-view byte/owner failure is bounded.
          await work.readPublicReleasePairWork({ firestore, pair });
          if ((await firestore.doc("system/billing").get()).data()?.disabled === true) return;
          const failureCode = error instanceof work.PairExecutionError ? error.code :
            error instanceof protocol.PublicReleaseProtocolError ? "reader-mismatch" : "storage-unavailable";
          await firestore.runTransaction(async transaction => {
            const before = await transaction.get(row.ref);
            if (!before.exists || protocol.publicReleaseDigest(before.data()) !== protocol.publicReleaseDigest(value)) return;
            if (failureCode === "storage-unavailable") {
              transaction.set(row.ref, { ...value, nextAttemptAt: clock() + 60_000, lastFailure: failureCode });
              return;
            }
            const attempts = Number.isInteger(value.attempts) && value.attempts >= 0 && value.attempts < 3 ? value.attempts + 1 : 3;
            if (attempts < 3) transaction.set(row.ref, { ...value, attempts, nextAttemptAt: clock() + 60_000 * attempts, lastFailure: failureCode });
            else {
              transaction.set(firestore.doc(`${base}/stagingFailures/${row.id}`), { ...value, attempts,
                nextAttemptAt: null, lastFailure: failureCode, status: "quarantined", failedAt: clock() });
              transaction.delete(row.ref);
            }
          });
        }
      }
    }
  };
  const recover = async (signal?: AbortSignal) => {
    await recoverStaging(signal);
    if (publication) {
      const { recoverPublicReleasePairActivations } = await import("./public-release-pair-activation-outbox");
      await recoverPublicReleasePairActivations({ firestore, store, pair, publication, signal, now: clock });
    }
  };
  const retryQuarantined = async (taskId: string, signal?: AbortSignal) => {
    if (!/^[a-f0-9]{64}$/.test(taskId)) refuse();
    const ref = firestore.doc(`${base}/stagingFailures/${taskId}`), row = await ref.get();
    if (row.exists && row.data()!.status !== "quarantined") refuse();
    // A lost successful response is resolved through the same immutable
    // completion receipt. G rechecks every byte even on an idempotent retry.
    const receipt = row.exists ? row.data() : (await firestore.doc(`${base}/receipts/${taskId}`).get()).data();
    if (!receipt) refuse();
    await stage({ ...receiptOf(receipt, taskId), signal });
    signal?.throwIfAborted();
    if (row.exists) await ref.delete();
  };
  const execute = async ({ identity: rawIdentity, outputPrefix, renew: renewLease, signal }: {
    identity: PairTaskIdentity; outputPrefix: string; renew(): Promise<{ leaseUntil: number }>; signal: AbortSignal;
  }) => withPublicReleasePairVerifiedReads(store, async store => {
    const started = performance.now(), timings: Record<string, number> = {};
    let marked = started, leaseRenewals = 0;
    const mark = (name: string) => { const now = performance.now(); timings[name] = now - marked; marked = now; };
    const renew = publicReleasePairExecutionRenewal(async () => { leaseRenewals++; return renewLease(); }, signal);
    const identity = views.parseViewIdentity(rawIdentity, pair);
    const claimDigest = outputPrefix.split("/").at(-2)!;
    if (outputPrefix !== views.publicReleasePairViewPrefix(pair, identity, claimDigest)) refuse();
    const semanticPriorBytes = await semanticReuse.begin(identity, claimDigest);
    const frozen = await openFrozenInput(identity, signal, store);
    await renew(); mark("inputAuthorityMs");
    if (frozen.root.entryFiles.includes(PAIR_CODE_PACK_FILE)) {
      return executePublicReleasePairCodePack({ firestore, store, pair, identity, claimDigest, frozen, renew, signal });
    }
    const sourceStarted = performance.now();
    const preparation = await Promise.allSettled([
      (async () => {
        const plans = await openPublicReleasePairRenderPlans(frozen.root, frozen.readFile), plan = plans.plan;
        const full = frozen.root.files.some(file => file.name === PAIR_CODE_PACK_FILE);
        const sourceOwner = { firestore, store, pair, identity, signal };
        const source = full ? await openPublicReleasePairCompositeAuthority(sourceOwner) : null;
        const catalog = source ? await deriveFrozenPublicReleasePairCatalogImages(sourceOwner, source) : null;
        if (source && protocol.publicReleaseDigest(source.frozen.root) !== protocol.publicReleaseDigest(frozen.root)) refuse();
        const authors = source ? await derivePublicReleasePairAuthors({ pair, identity, root: frozen.root,
          checkpoint: renew, readFrozenFile: frozen.readFile }) : null;
        const staticInput = source?.staticSource?.source ? source.staticSource : null;
        const staticProjection = staticInput?.source ? projectPublicReleasePairStaticArtifact({ pair, identity, source: staticInput.source,
          documents: staticInput.documents, renderedAt: plan.renderedAt }) : null;
        const staticAliases = staticProjection ? [...publicReleasePairStaticAliasTargets(staticProjection.receipt)].flatMap(([path, target]) => {
          const output = plan.expectedOutputs.find(output => output.path === path), author = authors?.routes.find(route => route.path === path);
          const status = output?.status ?? author?.status;
          if (status === 200) return [];
          if (status !== 308) refuse();
          return [{ path, ...target }];
        }).sort((a, b) => a.path < b.path ? -1 : 1) : null;
        timings.sourceAuthorityMs = performance.now() - sourceStarted;
        return { plans, plan, full, source, catalog, authors, staticInput, staticAliases };
      })(),
      (async () => {
        const started = performance.now();
        try { await verifyPublicReleasePairRenderer(compiled, pair); }
        catch { throw new work.PairExecutionError("byte-mismatch"); }
        finally { timings.compiledVerificationMs = performance.now() - started; }
      })(),
    ] as const);
    if (preparation[0].status === "rejected") throw preparation[0].reason;
    if (preparation[1].status === "rejected") throw preparation[1].reason;
    const { plans, plan, full, source, catalog, authors, staticInput, staticAliases } =
      preparation[0].value;
    mark("sourceAndCompiledWallMs");
    const job = await mkdtemp(path.join(os.tmpdir(), "njpbs-pair-"));
    try {
      const inputs = path.join(job, "inputs"), dist = path.join(job, "dist");
      await mkdir(inputs, { mode: 0o700 });
      const baselineFiles: Array<{ path: string; file: string; bytes: number; digest: string }> = [];
      const baselineDirectory = path.join(job, "baseline"), nativePagefind = path.join(job, "pagefind"), nativeSemantic = path.join(job, "semantic");
      const materialization = await Promise.allSettled([
        (async () => {
          if (!source) return;
          const started = performance.now();
          const members = publicReleasePairRequiredBaselineMembers(source.baseline.manifest,
            new Set([...plan.routes.map(route => route.path), ...authors!.routes.map(route => route.path)]));
          await mkdir(baselineDirectory, { mode: 0o700 });
          for (const member of members) {
            const bytes = await source.baseline.readMember(member.path), file = `${baselineFiles.length}.bin`;
            await writeFile(path.join(baselineDirectory, file), bytes, { mode: 0o600, flag: "wx" });
            baselineFiles.push({ path: member.path, file, bytes: bytes.length, digest: member.sha256 }); await renew();
          }
          timings.baselineMaterializationMs = performance.now() - started;
        })(),
        (async () => {
          if (!source) return;
          const started = performance.now();
          await restorePublicReleasePairPagefindEngine(compiled, nativePagefind); await renew();
          timings.pagefindRestoreMs = performance.now() - started;
        })(),
        (async () => {
          if (!source) return;
          const started = performance.now();
          await restorePublicReleasePairSemanticEngine(compiled, nativeSemantic); await renew();
          timings.semanticRestoreMs = performance.now() - started;
        })(),
        (async () => {
          const started = performance.now();
          await materializePublicReleasePairInput({ files: frozen.root.files, directory: inputs, read: frozen.readFile, checkpoint: renew, signal });
          timings.inputMaterializationMs = performance.now() - started;
        })(),
      ]);
      for (const result of materialization) if (result.status === "rejected") throw result.reason;
      mark("materializationWallMs");
      const semanticPrior = source && semanticPriorBytes ? { bytes: semanticPriorBytes.length, digest: hash(semanticPriorBytes) } : null;
      if (semanticPrior) await writeFile(path.join(job, "semantic-prior.json"), semanticPriorBytes!, { mode: 0o600, flag: "wx" });
      await writeFile(path.join(job, "job.json"), JSON.stringify({ pair, identity, root: frozen.root, ...(source ? { baselineFiles } : {}), ...(semanticPrior ? { semanticPrior } : {}), ...(staticAliases ? { staticAliases } : {}) }), { mode: 0o600, flag: "wx" });
      mark("jobManifestMs");
      const provenanceFile = frozen.root.files.find(file => file.name === PAIR_REPLAY_PROVENANCE_FILE);
      const provenance = provenanceFile ? json(await readFile(path.join(inputs, PAIR_REPLAY_PROVENANCE_FILE))) : null;
      const readLocalFrozenFile = async (name: string) => {
        signal.throwIfAborted();
        const file = frozen.root.files.find(file => file.name === name);
        if (!file) refuse();
        const bytes = await readFile(path.join(inputs, file.name));
        if (bytes.length !== file.bytes || hash(bytes) !== file.digest) throw new work.PairExecutionError("byte-mismatch");
        return new Uint8Array(bytes);
      };
      const replayContext = async (route: typeof plan.routes[number]): Promise<PairReplayContext> => {
        const inputFile = frozen.root.files.find(file => file.name === route.inputFile);
        if (!inputFile || !provenanceFile) refuse();
        const request = json(await readLocalFrozenFile(route.inputFile));
        const homeSources = typeof request?.homeSourcesFile === "string" ? json(await readLocalFrozenFile(request.homeSourcesFile)) : undefined;
        return { pair, identity, route, provenance, request, homeSources, readFrozenFile: readLocalFrozenFile,
          inputDigest: inputFile.digest, provenanceDigest: provenanceFile.digest, renderedAt: plan.renderedAt };
      };
      for (const route of plan.routes) if (isPublicReleasePairProjection(route.renderer)) {
        // Fail under this original claim with the named frozen-input error,
        // before a sandbox exit could obscure it as a generic render failure.
        try { await projectPublicReleasePairReplay(await replayContext(route)); }
        catch (error) {
          signal.throwIfAborted();
          if (error instanceof work.PairExecutionError) throw error;
          throw new work.PairExecutionError("render-failed");
        }
        await renew();
      }
      mark("projectionPreflightMs");
      const sandbox = await privatePreviewSandbox({ CMS_OFFLINE_BUILD: "1", CMS_PREVIEW_INPUT_PATH: path.join(job, "job.json") }, dist);
      const args = sandbox.args.slice(0, -1);
      if (source) args.push("--ro-bind", baselineDirectory, "/pair/baseline", "--ro-bind", nativePagefind, "/pair/pagefind", "--ro-bind", nativeSemantic, "/pair/semantic",
        "--ro-bind", path.join(compiled, "runtime/semantic/encoder.mjs"), "/pair/semantic-encoder.mjs");
      if (semanticPrior) args.push("--ro-bind", path.join(job, "semantic-prior.json"), "/pair/semantic-prior.json");
      args.push("--ro-bind", inputs, "/pair/inputs", "--ro-bind", await realpath(process.execPath), "/pair/node", "--", "/pair/node", path.join(compiled, "runtime/pair.mjs"));
      await renew();
      // Renew on a real long-running render, and abort the child on a lost
      // lease. The lease wrapper also stops an uncooperative executor.
      let renewal: Promise<unknown> | undefined, renewalFailure: unknown;
      const childSignal = new AbortController();
      const abort = () => childSignal.abort();
      signal.addEventListener("abort", abort, { once: true });
      const timer = setInterval(() => {
        if (!renewal) renewal = renew().catch(error => { renewalFailure = error; childSignal.abort(); }).finally(() => { renewal = undefined; });
      }, 15_000);
      try {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const child = spawn("/usr/bin/bwrap", args, {
            env: { PATH: "/usr/bin:/bin", NODE_ENV: "production", CMS_OFFLINE_BUILD: "1", TZ: "America/New_York" },
            cwd: path.join(repository, "site"), signal: childSignal.signal, timeout: 120_000,
            killSignal: "SIGKILL", stdio: "ignore",
          });
          let failed = false;
          child.once("error", () => { failed = true; });
          // Wait for close even after abort, before removing the job directory.
          child.once("close", code => !failed && code === 0 ? resolve() : reject(new work.PairExecutionError("render-failed")));
        });
      } finally {
        clearInterval(timer); signal.removeEventListener("abort", abort); await renewal;
      }
      if (renewalFailure) throw renewalFailure;
      signal.throwIfAborted();
      mark("sandboxMs");
      // Both source-owned plans must agree for every shared route. Their input
      // file digests may differ, but bytes, redirects and NEW target ownership
      // must be identical before any G object can be written.
      for (const overlap of plans.overlaps) {
        const before = `${overlap.ordinaryIndex}`, after = `aggregate-${overlap.aggregateIndex}`;
        const [left, right] = await Promise.all([readPublicReleasePairOutputFile(path.join(dist, `${before}.body`), views.BODY_BYTES_LIMIT),
          readPublicReleasePairOutputFile(path.join(dist, `${after}.body`), views.BODY_BYTES_LIMIT)]);
        if (hash(left) !== hash(right)) throw new work.PairExecutionError("byte-mismatch");
        const ordinaryRoute = plans.ordinaryPlan.routes[overlap.ordinaryIndex], aggregateRoute = plans.aggregatePlan!.routes[overlap.aggregateIndex];
        const expected = plans.ordinaryPlan.expectedOutputs[overlap.ordinaryIndex];
        if ([302, 308].includes(expected.status)) {
          const [a, b] = await Promise.all([readPublicReleasePairOutputFile(path.join(dist, `${before}.location`), 2048),
            readPublicReleasePairOutputFile(path.join(dist, `${after}.location`), 2048)]);
          if (hash(a) !== hash(b)) throw new work.PairExecutionError("byte-mismatch");
        }
        if (isPublicReleasePairProjection(ordinaryRoute.renderer) !== isPublicReleasePairProjection(aggregateRoute.renderer)) refuse();
        if (isPublicReleasePairProjection(ordinaryRoute.renderer)) {
          const [a, b] = await Promise.all([readPublicReleasePairOutputFile(path.join(dist, `${before}.target.json`), 64 * 1024),
            readPublicReleasePairOutputFile(path.join(dist, `${after}.target.json`), 64 * 1024)]);
          const oldTarget = parsePublicReleasePairReplayTargetReceipt(json(a), await replayContext(ordinaryRoute));
          const newTarget = parsePublicReleasePairReplayTargetReceipt(json(b), await replayContext(aggregateRoute));
          if (protocol.publicReleaseDigest(oldTarget.target) !== protocol.publicReleaseDigest(newTarget.target)) throw new work.PairExecutionError("byte-mismatch");
        }
        await renew();
      }
      mark("overlapVerificationMs");
      // Paths are fixed ordinal filenames, never supplied by the child.
      const outputSeals = new Map<string, { bodyDigest: string; status: number }>();
      let homeSourceBytes: Uint8Array | undefined;
      const routeOutput = async (index: number) => {
        signal.throwIfAborted();
        const expected = plan.expectedOutputs[index], selected = plans.selected[index], ordinal = `${selected.filePrefix}${selected.index}`, file = path.join(dist, `${ordinal}.body`);
        const bytes = await readPublicReleasePairOutputFile(file, views.BODY_BYTES_LIMIT);
        if (expected.path === "/_home-sources.json" && expected.status === 200) homeSourceBytes = new Uint8Array(bytes);
        const headers: Record<string, string> = { "content-type": expected.contentType, "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha };
        if ([302, 308].includes(expected.status)) headers.location = new TextDecoder("utf-8", { fatal: true }).decode(
          await readPublicReleasePairOutputFile(path.join(dist, `${ordinal}.location`), 2048));
        if (expected.status === 302) headers["x-robots-tag"] = "noindex, nofollow";
        if (expected.contentType.startsWith("text/html") && expected.status === 200) headers["x-njpbs-html-sha256"] = hash(bytes);
        if (isPublicReleasePairProjection(plan.routes[index].renderer)) outputSeals.set(expected.path, { bodyDigest: hash(bytes), status: expected.status });
        await renew(); return { path: expected.path, status: expected.status, headers, bytes };
      };
      type Descriptor = { member: PairCompositeMember; read(): Promise<Awaited<ReturnType<typeof routeOutput>>> };
      const descriptors: Descriptor[] = [];
      let metrics: unknown;
      let staticTarget: Awaited<ReturnType<typeof writePublicReleasePairStaticTarget>> | null = null;
      if (source && catalog) {
        for (let index = 0; index < plan.routes.length; index++) {
          const output = await routeOutput(index);
          descriptors.push({ member: { path: output.path, role: "route", kind: plan.routes[index].renderer, status: output.status,
            mime: output.headers["content-type"], size: output.bytes.length, sha256: hash(output.bytes), sourceDependencyDigest: source.authority.sourceDependencyDigest },
          read: () => routeOutput(index) });
        }
        const auxiliary = json(await readPublicReleasePairOutputFile(path.join(dist, "auxiliary.json"), views.BODY_BYTES_LIMIT));
        if (!auxiliary || Object.keys(auxiliary).sort().join() !== "actions,metrics,schemaVersion" || auxiliary.schemaVersion !== 1 ||
            !Array.isArray(auxiliary.actions) || auxiliary.actions.length > views.VIEW_OUTPUT_LIMIT) refuse();
        metrics = auxiliary.metrics;
        for (let index = 0; index < auxiliary.actions.length; index++) {
          const action = auxiliary.actions[index], file = `aux-${index}.body`;
          if (!action || Object.keys(action).sort().join() !== ["path", "role", "kind", "status", "mime", "size", "sha256", "file",
            ...(Object.hasOwn(action, "owner") ? ["owner"] : []), ...(Object.hasOwn(action, "location") ? ["location"] : [])].sort().join() || action.file !== file) refuse();
          const { file: _file, location, ...member } = action;
          const read = async () => {
            const bytes = await readPublicReleasePairOutputFile(path.join(dist, file), views.BODY_BYTES_LIMIT);
            if (bytes.length !== action.size || hash(bytes) !== action.sha256) throw new work.PairExecutionError("byte-mismatch");
            if (action.path === "/_home-sources.json" && action.status === 200) homeSourceBytes = new Uint8Array(bytes);
            const headers: Record<string, string> = { "content-type": action.mime, "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha };
            if (action.status === 308) headers.location = location;
            if (action.status === 200 && action.mime.startsWith("text/html")) headers["x-njpbs-html-sha256"] = action.sha256;
            await renew(); return { path: action.path, status: action.status, headers, bytes };
          };
          await read(); descriptors.push({ member: { ...member, sourceDependencyDigest: source.authority.sourceDependencyDigest }, read });
        }
        for (const image of catalog.manifest.members) descriptors.push({ member: { path: image.path, role: "catalog", kind: "catalog-image", status: 200,
          mime: image.mime, size: image.size, sha256: image.sha256, sourceDependencyDigest: source.authority.sourceDependencyDigest },
        read: async () => { const bytes = await catalog.readMember(image.path); await renew(); return { path: image.path, status: 200 as const,
          headers: { "content-type": image.mime, "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha }, bytes }; } });
        if (staticInput?.source && staticAliases) {
          const raw = json(await readPublicReleasePairOutputFile(path.join(dist, "static-aliases.json"), views.BODY_BYTES_LIMIT));
          if (!raw || Object.keys(raw).sort().join() !== "aliases,schemaVersion" || raw.schemaVersion !== 1 || !Array.isArray(raw.aliases) || raw.aliases.length !== staticAliases.length) refuse();
          const aliases = raw.aliases.map((alias: any, index: number) => {
            const expected = staticAliases[index], file = `static-alias-${index}.body`;
            if (!alias || Object.keys(alias).sort().join() !== "bytes,canonicalPath,digest,file,path" || alias.path !== expected.path ||
                alias.canonicalPath !== expected.canonicalPath || alias.file !== file || !Number.isSafeInteger(alias.bytes) || alias.bytes < 1 ||
                alias.bytes > views.BODY_BYTES_LIMIT || !/^[a-f0-9]{64}$/.test(alias.digest)) refuse();
            return { path: alias.path as string, async read() {
              const bytes = await readPublicReleasePairOutputFile(path.join(dist, file), views.BODY_BYTES_LIMIT);
              if (bytes.length !== alias.bytes || hash(bytes) !== alias.digest) throw new work.PairExecutionError("byte-mismatch");
              await renew(); return bytes;
            } };
          });
          const actual = await recomputePublicReleasePairStaticArtifact({ pair, identity, source: staticInput.source, documents: staticInput.documents,
            renderedAt: plan.renderedAt, baseline: source.baseline.manifest, readBaseline: path => source.baseline.readMember(path),
            outputs: descriptors.map(descriptor => ({ path: descriptor.member.path, read: descriptor.read })), aliases,
            directory: path.join(job, "static-target"), verifyReceipts: false, signal, progress: renew });
          for (const [path, bytes, kind] of [["/_publication.json", actual.publicationBytes, "publication"], ["/_content-status.json", actual.statusBytes, "content-status"]] as const) {
            if (descriptors.some(descriptor => descriptor.member.path === path)) refuse();
            const digest = hash(bytes), mime = "application/json; charset=utf-8";
            descriptors.push({ member: { path, role: "auxiliary", kind, status: 200, mime, size: bytes.length, sha256: digest,
              sourceDependencyDigest: source.authority.sourceDependencyDigest }, read: async () => {
              signal.throwIfAborted(); await renew(); return { path, status: 200 as const,
                headers: { "content-type": mime, "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha }, bytes };
            } });
          }
          staticTarget = await writePublicReleasePairStaticTarget({ firestore, store, pair, identity, claimDigest, signal }, staticInput.source, actual, aliases);
          await renew();
        }
        descriptors.sort((a, b) => views.comparePrivatePairArtifactPaths(a.member.path, b.member.path));
      }
      const compositeManifest = source ? composite.parsePublicReleasePairCompositeManifest({ schemaVersion: 1, kind: "pair-composite-manifest",
        pairDigest: protocol.publicReleaseDigest(pair), inputManifestDigest: identity.inputManifestDigest, cursor: frozen.root.cursor,
        authority: { ...source.authority, ...(staticTarget ? { staticTargetDigest: staticTarget.descriptor.digest } : {}) }, members: descriptors.map(descriptor => descriptor.member) }, pair, identity, frozen.root.cursor) : undefined;
      async function* outputs() {
        if (source) {
          for (let offset = 0; offset < descriptors.length;) {
            let end = offset, bytes = 0;
            do { bytes += descriptors[end++].member.size; }
            while (end < descriptors.length && end - offset < 4 && bytes + descriptors[end].member.size <= views.BODY_BYTES_LIMIT);
            const batch = await Promise.allSettled(descriptors.slice(offset, end).map(descriptor => descriptor.read()));
            for (const result of batch) if (result.status === "rejected") throw result.reason;
            for (const result of batch) if (result.status === "fulfilled") yield result.value;
            offset = end;
          }
        }
        else { for (let index = 0; index < plan.expectedOutputs.length; index++) yield await routeOutput(index); }
      }
      const rendered = await writePublicReleasePairView({ store, pair, identity, claimDigest, cursor: frozen.root.cursor, outputs: outputs(), signal,
        deriveNamespaces: full, catalogImages: catalog?.manifest, compositeManifest });
      if (staticTarget) await recordPublicReleasePairStaticTargetClaim({ firestore, store, pair, identity, claimDigest,
        viewManifestDigest: rendered.manifestDigest, signal }, staticTarget.descriptor);
      async function* targets() {
        for (let index = 0; index < plan.routes.length; index++) {
          const route = plan.routes[index], selected = plans.selected[index], ordinal = `${selected.filePrefix}${selected.index}`;
          if (!isPublicReleasePairProjection(route.renderer)) continue;
          const context = await replayContext(route);
          const receipt = parsePublicReleasePairReplayTargetReceipt(json(await readPublicReleasePairOutputFile(
            path.join(dist, `${ordinal}.target.json`), 64 * 1024)), context);
          const seal = outputSeals.get(route.path); if (!seal) refuse();
          await renew();
          yield { receipt, ...seal };
        }
      }
      await writePublicReleasePairReplayProof({ firestore, store, pair, identity, claimDigest,
        viewManifestDigest: rendered.manifestDigest, targets: targets(), signal });
      if (homeSourceBytes && frozen.root.files.some(file => file.name === "source-census.json")) {
        // Additive private evidence only. Neither this optional write, its
        // rejection nor an unresolved provider can hold publication/head work.
        previewContext({ pair, identity, claimDigest, viewManifestDigest: rendered.manifestDigest,
          root: frozen.root, readFrozenFile: frozen.readFile, homeSourceBytes, renderedAt: plan.renderedAt });
      }
      mark("outputManifestMs");
      return { ...rendered, ...(source ? { metrics: { ...(metrics && typeof metrics === "object" ? metrics : {}),
        parent: { ...timings, leaseRenewals, totalMs: performance.now() - started } } } : {}) };
    } finally { await rm(job, { recursive: true, force: true }); }
  });
  return { execute, stage, recover, retryQuarantined, ...(beforePoll ? { beforePoll } : {}) };
}
