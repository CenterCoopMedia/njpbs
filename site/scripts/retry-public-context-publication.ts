import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";
import { assertCmsPublicationSourceCheckout } from "./cms-publication-runtime-guard";
import { assertProductionFirestoreRouting } from "./enqueue-cms-publication-baseline";

const require = createRequire(import.meta.url);
const { parseFirebaseServiceAccount } = require("../../scripts/bootstrap-public-deployment.cjs");
const { CURRENT_PATH, TRANSPORT, enqueuePublicContextInTransaction } = require("../../functions/lib/public-context-publication");
const { PUBLIC_CONTEXT_PATH, publicContextDigest } = require("../../functions/lib/public-context-revision");
const { ownsPublication } = require("../../functions/lib/publication-runtime-owner");
const { assertCmsPublicationCloudAdmission } = require("../../functions/lib/cms-publication-runtime-control");
const { assertPublicDeploymentPointer } = require("../../functions/lib/public-deployment");
interface RetryInput { operationId: string; sourceSha: string; contextRevision: number; apply: boolean }
function requireValue(value: unknown): asserts value { if (!value) throw new Error("Public context retry refused"); }

export function parsePublicContextRetryArguments(args: string[]): RetryInput {
  requireValue((args.length === 6 || args.length === 7 && args[6] === "--apply") &&
    args[0] === "--operation-id" && /^[A-Za-z0-9]{20}$/.test(args[1]) &&
    args[2] === "--source-sha" && /^[a-f0-9]{40}$/.test(args[3]) &&
    args[4] === "--context-revision" && /^[1-9][0-9]*$/.test(args[5]));
  const contextRevision = Number(args[5]);
  requireValue(Number.isSafeInteger(contextRevision));
  return { operationId: args[1], sourceSha: args[3], contextRevision, apply: args.length === 7 };
}

/** A guarded successor grants a new attempt budget. Exhausted preparations,
 * checkpoints and acceptance identities are never reset or relabeled. */
export async function retryPublicContextPublication({ firestore, input }: { firestore: Firestore; input: RetryInput }) {
  requireValue(/^[A-Za-z0-9]{20}$/.test(input.operationId) && /^[a-f0-9]{40}$/.test(input.sourceSha) &&
    Number.isSafeInteger(input.contextRevision) && input.contextRevision > 0 && typeof input.apply === "boolean");
  const successorId = randomUUID().replaceAll("-", "").slice(0, 20);
  const runtime = { owner: "cloudflare", release: input.sourceSha };
  const contextDigest = publicContextDigest(input.contextRevision);
  return firestore.runTransaction(async transaction => {
    const [current, queue, context, deployment, control] = await transaction.getAll(firestore.doc(CURRENT_PATH),
      firestore.doc(`cmsPublishQueue/${input.operationId}`), firestore.doc(PUBLIC_CONTEXT_PATH),
      firestore.doc("system/publicDeployment"), firestore.doc("system/cmsPublicationRuntime"));
    const job = queue.data();
    requireValue(job);
    requireValue(current.data()?.operationId === input.operationId && ownsPublication(current.data(), runtime) &&
      current.data()?.contextRevision === input.contextRevision && current.data()?.contextDigest === contextDigest &&
      job?.transport === TRANSPORT && job.status === "failed" && ownsPublication(job, runtime) &&
      ownsPublication({ runtime: job.backgroundRuntime }, runtime) && job.publicContext?.contextRevision === input.contextRevision &&
      job.publicContext?.contextDigest === contextDigest && context.data()?.schemaVersion === 1 &&
      context.data()?.revision === input.contextRevision && deployment.data()?.state === "idle");
    const pointer = assertPublicDeploymentPointer(deployment.data());
    requireValue(pointer.activeCommitSha === input.sourceSha);
    assertCmsPublicationCloudAdmission(control.data(), { commitSha: input.sourceSha });
    const outputs: string[] = require("../../functions/lib/no-build-record-namespace").contextOutputs(job.publicContext);
    const states = await transaction.getAll(...outputs.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
    const taskPaths = states.map((row, index) => row.data()?.taskPath ?? `cmsPublishQueue/${input.operationId}/backgroundOutputs/${outputs[index]}`);
    requireValue(taskPaths.every(value => /^cmsPublishQueue\/[A-Za-z0-9_-]{1,200}\/backgroundOutputs\/[A-Za-z0-9_-]+$/.test(value)));
    const familyQueueIds = [...new Set(taskPaths.map(value => value.split("/")[1]))].filter(id => id !== input.operationId);
    const work = await transaction.getAll(firestore.doc(`cmsPublishQueue/${input.operationId}/backgroundPreparation/${contextDigest}`),
      ...taskPaths.map(value => firestore.doc(value)));
    const familyPreparations = familyQueueIds.length ? await transaction.getAll(...familyQueueIds.map(id =>
      firestore.doc(`cmsPublishQueue/${id}/backgroundPreparation/${contextDigest}`))) : [];
    // This operator fences only its own exhausted preparation. A Post or other
    // selected family's claimant must be settled by that operation's owner.
    requireValue(familyPreparations.every(row => !row.exists || ownsPublication(row.data(), runtime) &&
      row.data()?.status !== "building" && row.data()?.claim == null));
    const now = Date.now();
    requireValue(work.every(row => {
      if (!row.exists) return true;
      const data = row.data();
      if (!ownsPublication(data, runtime)) return false;
      if (data?.status !== "building" && data?.claim == null) return true;
      return typeof data?.nextAttemptAt === "number" && Number.isFinite(data.nextAttemptAt) &&
        data.nextAttemptAt >= 0 && data.nextAttemptAt <= now;
    }));
    const successor = await enqueuePublicContextInTransaction({ transaction, firestore, operationId: successorId, runtime,
      reason: job.publicContext.reason, contextRevision: input.contextRevision });
    if (input.apply) {
      // Fencing an expired claimant settles the old lease; it does not grant
      // that exhausted preparation another attempt or change its frozen input.
      const preparation = work[0];
      if (preparation.exists && (preparation.data()?.status === "building" || preparation.data()?.claim != null)) {
        transaction.update(preparation.ref, { status: "failed", claim: null, nextAttemptAt: null });
      }
      successor.write();
      transaction.update(firestore.doc(`cmsPublishQueue/${successorId}`), { retryOfQueueId: input.operationId });
    }
    return { applied: input.apply, operationId: input.operationId, successorId, sourceSha: input.sourceSha,
      contextRevision: input.contextRevision, contextDigest };
  });
}

export async function main(args = process.argv.slice(2)) {
  let app: App | undefined;
  try {
    assertProductionFirestoreRouting(process.env);
    const input = parsePublicContextRetryArguments(args);
    await assertCmsPublicationSourceCheckout(input.sourceSha);
    // The reviewed production operator convention passes the credential on FD3.
    // Read only at the authentication boundary, never into output or arguments.
    const credential = parseFirebaseServiceAccount(readFileSync(3, "utf8"));
    app = firebaseAdminRuntime.initializeApp({ projectId: "njpbs-site", credential: firebaseAdminRuntime.cert(credential) },
      "public-context-retry-operator");
    const result = await retryPublicContextPublication({ firestore: firebaseAdminRuntime.getFirestore(app), input });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("Public context retry refused; verify the exact current failed operation, source, context and leases.\n" +
      "An apply may already have committed. Before retrying, re-read system/publicDeployment/aggregateContexts/current, then use its operationId to read cmsPublishQueue/<operationId>. " +
      "Check retryOfQueueId against the original --operation-id and verify the expected source and context. If they match, recover that successor without applying again.\n");
    process.exitCode = 1;
  } finally { if (app) await firebaseAdminRuntime.deleteApp(app); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
