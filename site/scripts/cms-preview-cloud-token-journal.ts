import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import {
  CmsPublicationTokenJournalError,
  type CmsPublicationJournalJob,
  type CmsPublicationTokenJournal,
} from "./cms-publication-token-journal.ts";

const COLLECTION = "cmsPreviewSerializerJournals";
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const CLAIM_TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function fail(message: string): never {
  throw new CmsPublicationTokenJournalError(message);
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function exactFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function projectJob(value: unknown): CmsPublicationJournalJob {
  if (!exactFields(value, ["queueId", "buildBatchId", "commitSha", "claimToken", "createdAt"]) ||
    !matches(value.queueId, QUEUE_ID) || value.buildBatchId !== `preview-${value.queueId}` ||
    !matches(value.commitSha, COMMIT_SHA) || !matches(value.claimToken, CLAIM_TOKEN) ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt) {
    fail("The CMS preview cloud token journal job is invalid");
  }
  return Object.freeze({
    queueId: value.queueId,
    buildBatchId: value.buildBatchId as string,
    commitSha: value.commitSha,
    claimToken: value.claimToken,
    createdAt: value.createdAt,
  });
}

function projectState(value: unknown, serializerId: string): CmsPublicationJournalJob | null {
  if (!exactFields(value, ["schemaVersion", "serializerId", "job"]) ||
    value.schemaVersion !== 1 || value.serializerId !== serializerId) {
    fail("The CMS preview cloud token journal is invalid");
  }
  return value.job === null ? null : projectJob(value.job);
}

function retiredState(value: unknown, serializerId: string): boolean {
  if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 2) return false;
  if (!exactFields(value, ["schemaVersion", "serializerId", "job", "retirement"]) || value.serializerId !== serializerId || value.job !== null ||
      !exactFields(value.retirement, ["pairId", "pairDigest", "closureDigest"]) || value.retirement.pairId !== serializerId ||
      !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(serializerId) ||
      ![value.retirement.pairDigest, value.retirement.closureDigest].every(part => typeof part === "string" && /^[a-f0-9]{64}$/.test(part))) {
    fail("The CMS preview journal retirement is invalid");
  }
  return true;
}

/** Server-only journal: persist the raw token before the caller claims a queue.
 * Firestore transactions retain one exact reservation across process restarts.
 */
export async function openCmsPreviewCloudTokenJournal({ firestore, serializerId }: {
  firestore: Firestore;
  serializerId: string;
}): Promise<CmsPublicationTokenJournal> {
  if (!matches(serializerId, SERIALIZER_ID)) {
    fail("The CMS preview cloud token journal serializer id is invalid");
  }
  const ref = firestore.collection(COLLECTION).doc(serializerId);
  const state = (job: CmsPublicationJournalJob | null) => ({ schemaVersion: 1, serializerId, job });
  const readSnapshot = (snapshot: { exists: boolean; data(): unknown }) =>
    snapshot.exists && !retiredState(snapshot.data(), serializerId) ? projectState(snapshot.data(), serializerId) : null;

  return Object.freeze({
    journalPath: `firestore:${COLLECTION}/${serializerId}`,
    read: async () => readSnapshot(await ref.get()),
    reserve: async (input: Parameters<CmsPublicationTokenJournal["reserve"]>[0]) => {
      if (!exactFields(input, ["queueId", "buildBatchId", "commitSha"]) ||
        !matches(input.queueId, QUEUE_ID) || input.buildBatchId !== `preview-${input.queueId}` ||
        !matches(input.commitSha, COMMIT_SHA)) {
        fail("The CMS preview cloud token reservation is invalid");
      }
      const candidate = projectJob({ ...input, claimToken: randomUUID(), createdAt: new Date().toISOString() });
      return firestore.runTransaction(async transaction => {
        const row = await transaction.get(ref);
        if (row.exists && retiredState(row.data(), serializerId)) fail("Preview token requires a retained incarnation");
        const job = readSnapshot(row);
        if (job) {
          if (job.queueId !== input.queueId || job.buildBatchId !== input.buildBatchId || job.commitSha !== input.commitSha) {
            fail("The CMS preview cloud token journal already has another job");
          }
          return { idempotent: true, job };
        }
        // A stopped incarnation cannot reserve a new token after the atomic
        // third-pair replacement. The selector read conflicts with that CAS.
        if (/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(serializerId)) {
          const pairs = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair.js");
          const runtime = (await transaction.get(firestore.doc(pairs.SELECTOR_PATH))).data();
          if (runtime?.schemaVersion === 2) {
            const selector = pairs.parseSelector(runtime);
            if (![selector.selectedPairId, selector.recoveryPairId].includes(serializerId)) fail("Preview token requires a retained incarnation");
          }
        }
        transaction.set(ref, state(candidate));
        return { idempotent: false, job: candidate };
      });
    },
    clear: async (input: Parameters<CmsPublicationTokenJournal["clear"]>[0]) => {
      if (!exactFields(input, ["queueId", "claimToken"]) ||
        !matches(input.queueId, QUEUE_ID) || !matches(input.claimToken, CLAIM_TOKEN)) {
        fail("The CMS preview cloud token journal clear request is invalid");
      }
      return firestore.runTransaction(async transaction => {
        const job = readSnapshot(await transaction.get(ref));
        if (!job) return { idempotent: true };
        if (job.queueId !== input.queueId || job.claimToken !== input.claimToken) {
          fail("The CMS preview cloud token journal clear request conflicts");
        }
        transaction.set(ref, state(null));
        return { idempotent: false };
      });
    },
  });
}
