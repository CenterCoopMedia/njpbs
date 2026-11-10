"use strict";

const { publishedBlockResourceError } = require("./lib/published-resource-check");

const { preparePublicReleaseProducerInTransaction, publicContentChange, publicReleaseProducerOperation } = require("./lib/public-release-producer");
const { assertLegacyPublicQueueAdmissionInTransaction } = require("./lib/public-release-legacy-queue-admission");

const { CMS_EDGE_ORIGIN_SECRET } = require("./lib/cms-edge");

const { resolveDatasetFiguresInTransaction } = require("./lib/dataset-dependencies");
const { prepareDatasetUsageWrites } = require("./lib/dataset-usage");
const { DatasetError } = require("./lib/datasets");
const { assertNoBuildContentScheduleInTransaction, prepareNoBuildContentPublication } = require("./lib/no-build-content-publication");
const { TRANSPORT } = require("./lib/no-build-post-publication");
const { readNoBuildPageOwner } = require("./lib/no-build-page-ownership");
const { publicPageDefinition } = require("./lib/public-page-contract");
const { selectsNoBuildPage } = require("./lib/no-build-family-admission");
const PAGE_TRANSPORT = "page-no-build-v1";
const { readNoBuildFamilyAdmission, selectsNoBuildPost } = require("./lib/no-build-family-admission");
const { readNoBuildPostOwner } = require("./lib/no-build-post-ownership");
const { bumpPublicContextRevision } = require("./lib/public-context-revision");
const { newDevGithubQueueFields } = require("./lib/dev-publication-queue");

const { contentVersion } = require("./lib/content-version");

const { FieldValue } = require("firebase-admin/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const {
  AUDIT_COLLECTIONS,
  adminLogEntry,
  versionHistoryEntry,
} = require("./lib/audit");
const { parseBlocks } = require("./lib/content-blocks");
const {
  validateContentFieldValues,
} = require("./lib/content-document-contract");
const { validateSection } = require("./lib/editor-section-contract");
const { documentSizeError } = require("./lib/document-size");
const {
  normalizeLegacyPostDate,
  validateKnownMetadata,
} = require("./lib/content-metadata");
const { editorTemplateForPage } = require("./lib/public-page-contract");
const { applyFirstPublish } = require("./lib/editorial-dates");
const {
  PublishSnapshotError,
  createPublishedSnapshot,
} = require("./lib/publish-snapshot");
const { recordKindHasPublicRoute } = require("./lib/public-record-kinds");
const {
  MediaUsageError,
  collectPublishedMediaUsage,
  collectWorkingMediaUsage,
  prepareMediaUsageWrite,
} = require("./lib/media-usage");
const {
  PUBLISH_BUILD_PENDING_FIELD,
  PUBLISH_BUILD_QUEUE_FIELD,
  settleBuildQueue,
} = require("./lib/publish-build-state");
const { parsePublishInstant: canonicalInstant } = require("./lib/publish-instant");
const { readFrozenLibraryPublicationMessage, frozenLibraryPublicationMessage } = require("./lib/frozen-library-publication");
const { buildFreeRefusalInTransaction, buildFreeRefusalMessage } = require("./lib/build-free-refusal");
const { readSerializerPublicationControlInTransaction } = require("./lib/serializer-publication-control");
const { withFrozenCredits } = require("./lib/story-credit-directory");
const { PublicVideoError, withPublicVideos } = require("./lib/public-video");
const {
  assertSerializerPublicationAdmissionInTransaction,
  readCmsPublicationRuntimeControlInTransaction,
} = require("./lib/cms-publication-runtime-control");

const { routePurgeSecretNames } = require("./lib/post-route-purge");
const { publishSecretBindings } = require("./lib/cms-publish-credentials");

const SCHEDULED_COLLECTIONS = ["cmsPages", "cmsPosts"];
const SCHEDULER_ACTOR = "system:scheduler";
// Each content record has its own transaction. This cap bounds the one build
// request made after those transactions; the next minute drains the rest.
const MAX_SCHEDULED_CHANGES_PER_RUN = 100;
// Blocked or concurrently changed rows do not consume the build cap. Bound the
// scan so a broken backlog cannot make one scheduled invocation unbounded.
const MAX_SCHEDULED_CANDIDATE_READS_PER_RUN = 200;
const SCHEDULED_FAILURE_REASONS = {
  invalidContent: "Some required content is missing or incorrect.",
  media: "A media file is missing or is not ready to publish.",
  oversized: "This content is too large to publish.",
  unsupportedType: "This content type cannot be published on a schedule.",
  noBuild: "This Post cannot use its scheduled build-free publication. Check its settings, then schedule it again.",
};

class ScheduledCandidateRejection extends Error {
  constructor(message, editorMessage = SCHEDULED_FAILURE_REASONS.invalidContent) {
    super(message);
    this.name = "ScheduledCandidateRejection";
    this.editorMessage = editorMessage;
  }
}
class ScheduledReadinessRequired extends Error {}

function samePublishAtValue(left, right) {
  if (Object.is(left, right)) return true;
  if (
    left !== null &&
    typeof left === "object" &&
    typeof left.isEqual === "function"
  ) {
    return left.isEqual(right);
  }
  return false;
}

function isDue(document, nowMilliseconds) {
  if (
    document?.status !== "scheduled" ||
    document.deleted ||
    !Number.isFinite(nowMilliseconds)
  ) {
    return false;
  }
  const publishAt = canonicalInstant(document.publishAt);
  return publishAt !== null && publishAt <= nowMilliseconds;
}

function isPendingBuild(document) {
  return (
    document?.status === "published" &&
    document?.[PUBLISH_BUILD_PENDING_FIELD] === true &&
    !document?.[PUBLISH_BUILD_QUEUE_FIELD] &&
    !document.deleted &&
    Number.isInteger(document?.published?.sourceVersion) &&
    document.published.sourceVersion > 0
  );
}

// cmsPosts stores several record kinds, and only those with a reviewed public
// route have published-snapshot support (#923: Post and Program today). A
// scheduled library-only record is a deterministic blocker: it is checked inside
// the transaction and either stays scheduled or moves to a visible failure, so a
// full window of unsupported kinds cannot hide a later valid record behind the
// bounded due query.
function isSupportedScheduledRecord(collection, document) {
  if (collection === "cmsPosts") return recordKindHasPublicRoute(document?.type);
  return true;
}

async function defaultAssertPublishReady(fields) {
  const { assertPublishReady } = require("./publish");
  return assertPublishReady(fields);
}

async function defaultAssertPublishedMediaSafe(fields) {
  const { assertPublishedMediaSafe } = require("./lib/published-media-safety");
  return assertPublishedMediaSafe(fields);
}

async function defaultReconcileStalePublishRows(fields) {
  const { reconcileStalePublishRows } = require("./lib/publish-reconcile");
  return reconcileStalePublishRows(fields);
}

async function defaultEnqueuePublish(fields) {
  const { enqueuePublishBuild } = require("./publish");
  return enqueuePublishBuild(fields);
}

function createScheduledPublishRunner(deps = {}) {
  const {
    firestore = db,
    assertPublishReadyFn = defaultAssertPublishReady,
    assertPublishedMediaSafeFn = defaultAssertPublishedMediaSafe,
    reconcileStaleFn = defaultReconcileStalePublishRows,
    enqueuePublishFn = defaultEnqueuePublish,
    versionHistoryEntryFn = versionHistoryEntry,
    adminLogEntryFn = adminLogEntry,
    parseBlocksFn = parseBlocks,
    validateSectionFn = validateSection,
    documentSizeErrorFn = documentSizeError,
    withFrozenCreditsFn = withFrozenCredits,
    withPublicVideosFn = withPublicVideos,
    now = () => new Date().toISOString(),
    log = logger,
    sourceBinding,
  } = deps;

  return async () => {
    const scoped = sourceBinding === undefined ? null : require("./lib/public-release-rehearsal-schedule")
      .readRehearsalScheduledSourceBinding(sourceBinding, firestore);
    // The run's entry instant. It bounds the due query and decides which records are
    // due; it is deliberately not what any record is stamped with. Each candidate
    // transaction reads the clock again below.
    const runStartedAt = now();
    const nowMilliseconds = canonicalInstant(runStartedAt);
    if (nowMilliseconds === null) {
      throw new Error("Scheduled publish requires a canonical UTC clock value");
    }
    const dueQueryBound = new Date(nowMilliseconds).toISOString();
    const secondPrefix = dueQueryBound.slice(0, 19);
    const fraction = dueQueryBound.slice(20, 23);
    // These are the only accepted spellings in the current second that can be
    // numerically due but sort after the full three-digit query bound. Query
    // them by exact value only when the primary due query has unused capacity.
    const excludedAbbreviations = [
      `${secondPrefix}Z`,
      `${secondPrefix}.${fraction[0]}Z`,
      `${secondPrefix}.${fraction.slice(0, 2)}Z`,
    ];

    // Bound every recurring query before reading it. Full three-digit UTC
    // instants sort numerically, and the exact-value supplement below fills
    // only unused primary capacity. Pending retry rows are likewise filtered
    // to unclaimed published revisions.
    const primaryQueries = scoped ? [] : SCHEDULED_COLLECTIONS.flatMap((collection) => [
      {
        collection,
        kind: "scheduled",
        query: firestore
          .collection(collection)
          .where("status", "==", "scheduled")
          .where("publishAt", "<=", dueQueryBound)
          .orderBy("publishAt", "asc")
          .limit(MAX_SCHEDULED_CANDIDATE_READS_PER_RUN),
      },
      {
        collection,
        kind: "pending",
        query: firestore
          .collection(collection)
          .where("status", "==", "published")
          .where(PUBLISH_BUILD_PENDING_FIELD, "==", true)
          .where(PUBLISH_BUILD_QUEUE_FIELD, "==", null)
          .limit(MAX_SCHEDULED_CANDIDATE_READS_PER_RUN),
      },
    ]);
    const primarySnapshots = await Promise.all(
      primaryQueries.map(({ query }) => query.get()),
    );
    const supplementalQueries = [];
    for (const [queryIndex, snapshot] of primarySnapshots.entries()) {
      const primaryQuery = primaryQueries[queryIndex];
      if (primaryQuery.kind !== "scheduled") continue;
      const remaining = MAX_SCHEDULED_CANDIDATE_READS_PER_RUN - snapshot.size;
      if (remaining <= 0) continue;
      supplementalQueries.push({
        collection: primaryQuery.collection,
        kind: "scheduled",
        query: firestore
          .collection(primaryQuery.collection)
          .where("status", "==", "scheduled")
          .where("publishAt", "in", excludedAbbreviations)
          .limit(remaining),
      });
    }
    const supplementalSnapshots = await Promise.all(
      supplementalQueries.map(({ query }) => query.get()),
    );
    const queries = [...primaryQueries, ...supplementalQueries];
    const snapshots = [...primarySnapshots, ...supplementalSnapshots];
    // A row can change state between these independent reads. Key by canonical
    // ref so one invocation never snapshots or enqueues the document twice.
    const candidateMap = new Map();
    const discoveries = snapshots.map((snapshot, index) => ({ candidateQuery: queries[index], documents: snapshot.docs }));
    if (scoped) {
      const document = await firestore.doc(`${scoped.source.collection}/${scoped.source.id}`).get();
      if (document.exists) discoveries.push({ candidateQuery: { collection: scoped.source.collection, kind: 'scheduled' }, documents: [document] });
    }
    for (const { candidateQuery, documents } of discoveries) {
      for (const document of documents) {
        const data = document.data();
        const pendingBuild = isPendingBuild(data);
        if (candidateQuery.kind === "pending" && !pendingBuild) continue;
        if (
          candidateQuery.kind === "scheduled" &&
          (data?.status !== "scheduled" || data.deleted)
        ) {
          continue;
        }
        const publishAt = canonicalInstant(data.publishAt);
        candidateMap.set(document.ref.path, {
          collection: candidateQuery.collection,
          kind: candidateQuery.kind,
          observedPublishAt: data.publishAt,
          ref: document.ref,
          isPost: candidateQuery.collection === "cmsPosts" && data.type === "post",
          type: data.type,
          readyAt: pendingBuild || publishAt === null
            ? Number.NEGATIVE_INFINITY
            : publishAt,
        });
      }
    }
    // Leave accepted immutable revisions and their enqueue identities intact.
    // Blocked legacy retries must not consume the cap ahead of due cloud work.
    if ([...candidateMap.values()].some(candidate => candidate.kind === "pending")) {
      const retryControl = await firestore.runTransaction(async transaction => {
        const [control, serializer] = await Promise.all([
          readCmsPublicationRuntimeControlInTransaction({ firestore, transaction }),
          transaction.get(firestore.doc("system/publicDeployment/controls/serializer")),
        ]);
        const marker = serializer.data();
        // This is only a scan filter; the write transaction still owns admission.
        // A missing marker retains the existing enabled policy.
        const serializerEnabled = !serializer.exists || marker?.schemaVersion === 1 && marker.enabled === true &&
          Object.keys(marker).sort().join(",") === "enabled,schemaVersion";
        return { control, enabled: serializerEnabled && (control === null || control.phase === "ready") };
      }, { readOnly: true });
      for (const [path, candidate] of candidateMap) {
        if (candidate.kind === "pending" && (!retryControl.enabled || frozenLibraryPublicationMessage(
          candidate.collection, { type: candidate.type }, retryControl.control))) candidateMap.delete(path);
      }
    }
    // Failed fast confirmations stay with their own retry owner. Remove their
    // bounded pending-query rows before they can consume the scheduler scan cap.
    const pendingPosts = [...candidateMap.values()].filter(candidate => candidate.kind === "pending" && candidate.isPost);
    const pendingOwners = await Promise.all(pendingPosts.map(candidate =>
      readNoBuildPostOwner({ firestore, postId: candidate.ref.id })));
    for (const [index, owner] of pendingOwners.entries()) {
      if (owner.state?.operationId && owner.state.mode !== "static") candidateMap.delete(pendingPosts[index].ref.path);
    }
    const pendingPages = [...candidateMap.values()].filter(candidate => candidate.kind === "pending" &&
      candidate.collection === "cmsPages" && publicPageDefinition(candidate.ref.id));
    const pendingPageOwners = await Promise.all(pendingPages.map(candidate =>
      readNoBuildPageOwner({ firestore, pageId: candidate.ref.id })));
    for (const [index, owner] of pendingPageOwners.entries()) {
      if (owner.state) candidateMap.delete(pendingPages[index].ref.path);
    }
    const candidates = [...candidateMap.values()]
      // Retried frozen snapshots go first, then the oldest due date. The path is
      // a stable tie-breaker so a backlog drains deterministically across ticks.
      .sort(
        (left, right) =>
          left.readyAt - right.readyAt ||
          left.ref.path.localeCompare(right.ref.path),
      );

    if (candidates.length === 0) {
      // Keep this fallback until the dedicated Healthchecks-bound reconciliation
      // scheduler is provisioned and exported. A claimed stale queue is not an
      // isPendingBuild candidate, so an empty scheduled-publish tick must still
      // release it during the transition.
      if (!scoped) await reconcileStaleFn({ firestore });
      return { publishedCount: 0, queueId: null, changes: [] };
    }

    // Fast Posts use their own admission and confirmation owner. Readiness for
    // a full build is needed only by a candidate that will join that build.
    let readiness;
    let buildReadinessChecked = false;
    let buildReadinessError;
    const ensureBuildReadiness = async () => {
      if (buildReadinessChecked) return;
      if (!buildReadinessError) {
        try {
          readiness = await assertPublishReadyFn({ firestore });
          await assertPublishedMediaSafeFn({ firestore });
          buildReadinessChecked = true;
          return;
        } catch (error) { buildReadinessError = error; }
      }
      throw Object.assign(new Error("The full-build transport is unavailable. Scheduled publication will retry."), {
        scheduleDeferred: true,
      });
    };
    const requireBuildReadiness = () => {
      if (!buildReadinessChecked) throw new ScheduledReadinessRequired();
    };

    // Reserve the queue identity before any candidate transaction commits.
    // Runtime publication then sees an exact in-flight claim even during the
    // gap between a committed snapshot and transport dispatch.
    const queueRef = firestore.collection("cmsPublishQueue").doc();
    const queueId = queueRef.id;

    // Freeze each record in its own transaction. A blocked row moves to an
    // audited failure without rolling back valid records that follow it. All
    // full-build revisions enter one build request; fast Posts keep separate queues.
    const preparedBatch = { changes: [], allChanges: [], publications: [], newlyPublishedCount: 0 };
    const reserveQueue = (transaction, change, queueFields) => {
      if (preparedBatch.changes.length === 0) {
        transaction.create(queueRef, {
          // Keep the queue invisible to the serializer until every due revision
          // has joined the batch and enqueuePublishBuild atomically opens it.
          status: "reserved",
          transport: readiness?.transport ?? "github",
          triggeredBy: SCHEDULER_ACTOR,
          triggeredByEmail: null,
          triggeredAt: FieldValue.serverTimestamp(),
          completedAt: null,
          error: null,
          changes: [change],
          ...queueFields,
        });
        return;
      }
      transaction.update(queueRef, {
        changes: FieldValue.arrayUnion(change),
      });
    };
    let candidateReads = 0;
    for (const candidate of candidates) {
      if (
        preparedBatch.allChanges.length >= MAX_SCHEDULED_CHANGES_PER_RUN ||
        candidateReads >= MAX_SCHEDULED_CANDIDATE_READS_PER_RUN
      ) {
        break;
      }
      candidateReads += 1;

      const legacyPostQueueRef = firestore.collection("cmsPublishQueue").doc();
      let outcome;
      try {
        const captureRoot = candidate.collection === "cmsPages" && ["schedule", "live"].includes(candidate.ref.id)
          ? (await firestore.doc("system/publicDeployment").get()).data() : null;
        const pageScheduleCapture = await require("./lib/no-build-page-publication").capturePageScheduleForPublication({
          firestore, collection: candidate.collection, documentId: candidate.ref.id,
          scheduledCandidate: true,
          publishing: candidate.kind === "scheduled" && canonicalInstant(candidate.observedPublishAt) !== null,
          currentCodeRequest: deps.currentCodeRequest,
          ...(captureRoot?.schemaVersion === 2 ? { releaseSelector: require("./lib/public-release-media-fence").parseStoredSelector(captureRoot) } : {}) });
        const candidateTransaction = () => firestore.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(candidate.ref);
          if (!snapshot.exists) return null;
          const before = snapshot.data();
          const storedRoot = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
          const pairSelector = storedRoot?.schemaVersion === 2
            ? require("./lib/public-release-media-fence").parseStoredSelector(storedRoot) : null;
          if (scoped) {
            require("./lib/public-release-rehearsal-schedule").readRehearsalScheduledSourceBinding(sourceBinding, firestore);
            if (!pairSelector || before.version !== scoped.source.version || !samePublishAtValue(before.publishAt, scoped.source.publishAt) ||
                require("./lib/public-release-pair").publicReleaseDigest(pairSelector.selectedPair) !==
                  require("./lib/public-release-pair").publicReleaseDigest(scoped.selectedPair)) return null;
          }
          const postQueueRef = pairSelector ? firestore.doc(`cmsPublishQueue/${require("./lib/public-release-scheduled-operation").scheduledPairPublicationOperation({
            collection: candidate.collection, id: candidate.ref.id, version: before.version, publishAt: before.publishAt })}`) : legacyPostQueueRef;
          const isPost = candidate.collection === "cmsPosts" && before.type === "post";
          const isPage = candidate.collection === "cmsPages" && Boolean(publicPageDefinition(candidate.ref.id));
          const recordFamily = candidate.collection === "cmsPosts" ? require("./lib/no-build-record-publication").recordFamily(before) : null;
          const malformedSchedule = candidate.kind === "scheduled" && before.status === "scheduled" && !before.deleted &&
            samePublishAtValue(before.publishAt, candidate.observedPublishAt) && canonicalInstant(before.publishAt) === null;
          const [owner, admission] = (isPost || isPage || recordFamily) && !malformedSchedule ? await Promise.all([
            isPage ? readNoBuildPageOwner({ firestore, transaction, pageId: candidate.ref.id }) :
              recordFamily ? require("./lib/no-build-record-ownership").readNoBuildRecordOwner({ firestore, transaction, documentId: candidate.ref.id }) :
              readNoBuildPostOwner({ firestore, transaction, postId: candidate.ref.id }),
            readNoBuildFamilyAdmission({ firestore, transaction }),
          ]) : [null, null];
          const ownedFastPost = isPost && Boolean(owner?.state?.operationId && owner.state.mode !== "static");
          const ownedFastRecord = Boolean(recordFamily && owner?.state);
          const ownedFastPage = isPage && Boolean(owner?.state);
          const pairRequested = Boolean(pairSelector && (isPost || isPage || recordFamily));
          const fastRequested = pairRequested || (recordFamily && (before.scheduledPublicationTransport === "public-context-no-build-v1" || ownedFastRecord ||
            admission?.valid && admission.enabled && require("./lib/no-build-family-admission").selectsNoBuildRecord(admission, recordFamily, candidate.ref.id))) || (isPost && (before.scheduledPublicationTransport === TRANSPORT || ownedFastPost ||
            (owner?.state?.mode !== "static" && admission?.valid && admission.enabled && selectsNoBuildPost(admission, candidate.ref.id)))) ||
            (isPage && (before.scheduledPublicationTransport === PAGE_TRANSPORT || ownedFastPage ||
              (admission?.valid && admission.enabled && selectsNoBuildPage(admission, candidate.ref.id))));
          // Accepted instant operations keep their existing confirmation retry.
          // They must never enter the legacy retry of a frozen full-build row.
          if (isPendingBuild(before) && (pairRequested || ownedFastPost || ownedFastPage || ownedFastRecord)) return null;
          if (isPendingBuild(before) || !fastRequested) {
            const serializer = await readSerializerPublicationControlInTransaction({ firestore, transaction });
            if (isPendingBuild(before) && !serializer.enabled) return null;
            if (serializer.enabled) requireBuildReadiness();
          }
          // Read the clock again for this candidate, and again on every transaction
          // retry. The run's entry timestamp bounds the due query and nothing else:
          // a run that works through a window of due records can take minutes, and
          // `firstPublishedAt` is the instant publication actually completed (#1041).
          // Reusing the entry instant across a midnight boundary in station time
          // would date a post to a day the newsroom never published on.
          const timestamp = now();
          if (canonicalInstant(timestamp) === null) {
            throw new Error("Scheduled publish requires a canonical UTC clock value");
          }

        // Move a deterministic blocker out of the active due query through an
        // explicit audited failure in this transaction. Return to draft and
        // clear publishAt: scheduling does not imply approval (#2761).
        // The version increments and both audit rows
        // are written from a bounded receipt so a blocked record never
        // re-writes its own blocks into history. The admin audit after value
        // carries the failure reason.
        const recordFailure = (reason, detail = reason) => {
          const failedVersion =
            (Number.isInteger(before.version) ? before.version : 0) + 1;
          const failure = {
            failedAt: timestamp,
            failedBy: SCHEDULER_ACTOR,
            reason,
          };
          const beforeReceipt = {
            id: candidate.ref.id,
            status: before.status ?? null,
            version: before.version ?? null,
            publishAt: before.publishAt ?? null,
          };
          const afterReceipt = {
            id: candidate.ref.id,
            status: "draft",
            version: failedVersion,
            contentVersion: contentVersion(before),
            publishAt: null,
            scheduledPublishFailure: failure,
          };
          transaction.update(candidate.ref, {
            status: "draft",
            publishAt: FieldValue.delete(),
            version: failedVersion,
            contentVersion: contentVersion(before),
            scheduledPublishFailure: failure,
            scheduledPublicationTransport: FieldValue.delete(),
            updatedAt: timestamp,
            updatedBy: SCHEDULER_ACTOR,
          });
          transaction.set(
            firestore.collection(AUDIT_COLLECTIONS.versionHistory).doc(),
            {
              ...versionHistoryEntryFn({
                collection: candidate.collection,
                documentId: candidate.ref.id,
                action: "schedule-publish-failed",
                before: beforeReceipt,
                after: afterReceipt,
                actorUid: SCHEDULER_ACTOR,
                source: "scheduler",
              }),
              restorable: false,
            },
          );
          transaction.set(
            firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
            adminLogEntryFn({
              actorUid: SCHEDULER_ACTOR,
              action: "cms.schedule-publish-failed",
              target: `${candidate.collection}/${candidate.ref.id}`,
              before: {
                status: before.status ?? null,
                version: before.version ?? null,
              },
              after: {
                status: "draft",
                publishAt: null,
                version: failedVersion,
                contentVersion: contentVersion(before),
                reason,
                detail,
              },
              source: "scheduler",
            }),
          );
          return { failed: true, detail };
        };
        // Every deterministic blocker moves out of the active due query
        // through an audited failure so later due content is never starved.
        const disposition = (reason, detail = reason) =>
          recordFailure(reason, detail);

        // A frozen row whose enqueue failed gets no second history or audit
        // row. Verify its immutable snapshot still has active assets and exact
        // public projections before retrying the build. A missing projection
        // blocks enqueue until an operator repairs or replaces the asset.
        if (isPendingBuild(before)) {
          // A frozen snapshot can retry without calling the fresh producer.
          // Keep the original untouched when bootstrap closes new admission.
          await assertLegacyPublicQueueAdmissionInTransaction({ firestore, transaction });
          if (!(await readSerializerPublicationControlInTransaction({ firestore, transaction })).enabled) return null;
          if (await readFrozenLibraryPublicationMessage({ firestore, transaction,
            collection: candidate.collection, documentId: candidate.ref.id, document: before })) return null;
          const control = await assertSerializerPublicationAdmissionInTransaction({
            firestore,
            transaction,
          });
          requireBuildReadiness();
          const queueFields = preparedBatch.changes.length === 0
            ? await newDevGithubQueueFields({ firestore, transaction, control, transport: readiness?.transport ?? "github" })
            : {};
          if (candidate.collection === "cmsPosts") {
            const metadata = { ...before.published?.metadata };
            if (metadata.type === "post" && metadata.liveBlog !== undefined) {
              // This retry owns an immutable snapshot, never the working draft.
              try { require("./lib/live-blog").publicLiveBlogData(metadata.liveBlog, before.published.publishedAt); }
              catch (error) { throw new ScheduledCandidateRejection(error.message); }
              await require("./lib/live-blog-compatibility").assertLiveBlogRenderer({ firestore, transaction, liveBlog: metadata.liveBlog });
              delete metadata.liveBlog;
            }
            const contractError = validateContentFieldValues(
              candidate.collection,
              metadata.type,
              metadata,
            );
            if (contractError) {
              throw new ScheduledCandidateRejection(contractError);
            }
          }
          const publishedUsage = await prepareMediaUsageWrite({
            firestore,
            transaction,
            collection: candidate.collection,
            documentId: candidate.ref.id,
            state: "published",
            sourceVersion: before.published.sourceVersion,
            usage: collectPublishedMediaUsage({
              collection: candidate.collection,
              snapshot: before.published,
            }),
          });
          const change = {
            collection: candidate.collection,
            id: candidate.ref.id,
            sourceVersion: before.published.sourceVersion,
          };
          transaction.set(publishedUsage.ref, publishedUsage.document);
          transaction.update(candidate.ref, {
            [PUBLISH_BUILD_QUEUE_FIELD]: queueId,
          });
          reserveQueue(transaction, change, queueFields);
          return {
            change,
            newlyPublished: false,
          };
        }
        if (
          candidate.kind === "scheduled" &&
          before?.status === "scheduled" &&
          !before.deleted &&
          samePublishAtValue(before.publishAt, candidate.observedPublishAt) &&
          canonicalInstant(before.publishAt) === null
        ) {
          return disposition(
            SCHEDULED_FAILURE_REASONS.invalidContent,
            "publishAt must be a canonical UTC instant",
          );
        }
        if (!isDue(before, nowMilliseconds)) return null;
        const frozenMessage = recordFamily && fastRequested ? null : await readFrozenLibraryPublicationMessage({ firestore, transaction,
          collection: candidate.collection, documentId: candidate.ref.id, document: before });
        if (frozenMessage) return disposition(frozenMessage);
        if (!fastRequested && !(await readSerializerPublicationControlInTransaction({ firestore, transaction })).enabled) {
          const refusal = buildFreeRefusalMessage({ collection: candidate.collection, documentId: candidate.ref.id, document: before });
          return disposition(refusal, refusal);
        }

        let control = fastRequested ? null : await assertSerializerPublicationAdmissionInTransaction({
          firestore,
          transaction,
        });
        if (!fastRequested) requireBuildReadiness();
        let queueFields = !fastRequested && preparedBatch.changes.length === 0
          ? await newDevGithubQueueFields({ firestore, transaction, control, transport: readiness?.transport ?? "github" })
          : {};

        try {
          // cmsPosts stores several record kinds; only "post" has published-
          // snapshot support. An unsupported kind is a deterministic blocker,
          // not a filtered row, so a full window of legacy kinds cannot hide a
          // later valid post behind the bounded due query.
          if (!isSupportedScheduledRecord(candidate.collection, before)) {
            throw new ScheduledCandidateRejection(
              `Unsupported scheduled record type ${before.type} in ${candidate.collection}`,
              SCHEDULED_FAILURE_REASONS.unsupportedType,
            );
          }

          const publishable =
            candidate.collection === "cmsPosts"
              ? normalizeLegacyPostDate(before)
              : before;
          const metadataError = validateKnownMetadata(publishable, {
            descriptionIsString: candidate.collection === "cmsPages",
          });
          if (metadataError) {
            throw new ScheduledCandidateRejection(metadataError);
          }
          if (candidate.collection === "cmsPosts") {
            const contractError = validateContentFieldValues(
              candidate.collection,
              publishable.type,
              publishable,
              { complete: true },
            );
            if (contractError) {
              throw new ScheduledCandidateRejection(contractError);
            }
          }
          // A Program is a structured form with no block layout, so an absent
          // `blocks` field is its ordinary shape rather than malformed content.
          // Only that exact case is read as an empty list: a present but
          // non-array value still fails closed, and every block-bearing kind is
          // unchanged.
          const blocksToParse =
            candidate.collection === "cmsPosts" &&
            (publishable.type === "program" || publishable.type === "event") &&
            publishable.blocks === undefined
              ? []
              : publishable.blocks;
          const parsed = parseBlocksFn(blocksToParse, {
            pageId: candidate.collection === "cmsPages" ? candidate.ref.id : undefined,
          });
          if (!parsed.ok) {
            throw new ScheduledCandidateRejection(parsed.error);
          }
          const resourceError = publishedBlockResourceError(parsed.blocks, candidate.collection === "cmsPages" ? `/${candidate.ref.id}/` : "/posts/");
          if (resourceError) throw new ScheduledCandidateRejection(resourceError, resourceError);
          let section = null;
          if (candidate.collection === "cmsPages") {
            section = editorTemplateForPage(candidate.ref.id);
            if (section === null) {
              throw new ScheduledCandidateRejection(
                `Unknown public page id ${candidate.ref.id}`,
              );
            }
            if (
              before.template !== undefined &&
              before.template !== section
            ) {
              throw new ScheduledCandidateRejection(
                `Page ${candidate.ref.id} requires the ${section} editor template`,
              );
            }
          } else if (before.type === "post") {
            section = "post";
          }
          if (section !== null) {
            const sectionError = validateSectionFn(section, parsed.blocks);
            if (sectionError) {
              throw new ScheduledCandidateRejection(
                `${sectionError.reason} (${sectionError.detail})`,
              );
            }
          }
          const after = {
            ...publishable,
            // A blockless record keeps no `blocks` field: writing an empty array
            // onto a Program would invent a field its editor contract does not
            // own, and the snapshot already normalizes the public shape.
            ...(publishable.blocks === undefined ? {} : { blocks: parsed.blocks }),
            // A scheduled post's first publish time is the instant this run actually
            // completed, not the `publishAt` the editor asked for (#1041). A run that
            // lands four minutes after the due time published four minutes late, and
            // the page should say so. Nothing is stamped on a rerun or on a post that
            // was already public.
            ...(candidate.collection === "cmsPosts" && publishable.type === "post"
              ? applyFirstPublish(publishable, {
                  at: timestamp,
                  by: SCHEDULER_ACTOR,
                })
              : {}),
            ...(candidate.collection === "cmsPages" ? { template: section } : {}),
            status: "published",
            publiclyVisible: true,
            updatedAt: timestamp,
            updatedBy: SCHEDULER_ACTOR,
            version: (Number.isInteger(before.version) ? before.version : 0) + 1,
          contentVersion: contentVersion(before),
            [PUBLISH_BUILD_PENDING_FIELD]: true,
            [PUBLISH_BUILD_QUEUE_FIELD]: queueId,
          };
          // The scheduled run is a publish, so it freezes the byline exactly as a
          // manual publish does: the names as they read at the instant the run
          // actually completed, not as they read when the post was scheduled.
          // Pair admission below checks the selected renderer's live-blog support.
          if (candidate.collection === "cmsPosts" && after.type === "post" && after.liveBlog !== undefined && !pairSelector) {
            await require("./lib/live-blog-compatibility").assertLiveBlogRenderer({ firestore, transaction, liveBlog: after.liveBlog });
          }
          let frozen;
          try {
            frozen = await withFrozenCreditsFn({ firestore, tx: transaction,
              document: await require("./lib/election-source-refresh").withElectionSourceProjection({
                firestore, transaction, collection: candidate.collection, documentId: candidate.ref.id, document: after }), at: timestamp });
          } catch (error) {
            if (error instanceof require("./lib/live-blog").LiveBlogDraftError || error instanceof require("./lib/election-source-refresh").ElectionSourceProjectionError) throw new ScheduledCandidateRejection(error.message);
            throw error;
          }
          // Video blocks carry the public copy recorded when staff scheduled the
          // post. A missing record refuses this candidate; it never calls AWS.
          let documentForPublish;
          try {
            documentForPublish = await withPublicVideosFn({
              firestore,
              tx: transaction,
              document: frozen,
              collection: candidate.collection,
              documentId: candidate.ref.id,
            });
          } catch (error) {
            if (error instanceof PublicVideoError) {
              throw new ScheduledCandidateRejection(error.message);
            }
            throw error;
          }
          try {
            after.published = createPublishedSnapshot({
              collection: candidate.collection,
              document: documentForPublish,
              publishedAt: timestamp,
              publishedBy: SCHEDULER_ACTOR,
            });
            after.published = await resolveDatasetFiguresInTransaction({ firestore, transaction, snapshot: after.published });
          } catch (error) {
            if (error instanceof PublishSnapshotError) {
              throw new ScheduledCandidateRejection(error.message);
            }
            throw error;
          }
          let noBuildPublication = null;
          if (candidate.collection === "cmsPages") await require("./lib/page-reader-compatibility").assertInstalledPageReaders({
            firestore, transaction, pageId: candidate.ref.id, blocks: after.published?.blocks });
          if (fastRequested) {
            if (!pairSelector && (!admission.valid || !admission.enabled)) {
              throw Object.assign(new Error("Instant publication admission is unavailable. Scheduled publication will retry."), {
                scheduleDeferred: true,
              });
            }
            const noBuildFallback = {};
            try {
              noBuildPublication = await prepareNoBuildContentPublication({ firestore, transaction,
                collection: candidate.collection, documentId: candidate.ref.id, nextDocument: after,
                queueRef: postQueueRef, actor: { uid: SCHEDULER_ACTOR }, source: "scheduler", config: admission,
                fallback: noBuildFallback, pageScheduleCapture });
            } catch (error) {
              if (error instanceof require("./lib/public-release-pair").PublicReleaseProtocolError ||
                  error.scheduleDeferred === true || error.code === "failed-precondition") {
                throw Object.assign(new Error(error.message), { scheduleDeferred: true });
              }
              // The acceptance refusal already names the cause in staff words.
              if (error.status === 409) throw new ScheduledCandidateRejection(error.message, error.message);
              throw error;
            }
            if (!noBuildPublication) {
              if ([TRANSPORT, PAGE_TRANSPORT, "public-context-no-build-v1"].includes(before.scheduledPublicationTransport) || ownedFastPost || ownedFastPage || ownedFastRecord) {
                const reason = noBuildFallback.reason ?? SCHEDULED_FAILURE_REASONS.noBuild;
                throw new ScheduledCandidateRejection(reason, reason);
              }
              // No fast operation was accepted for this legacy schedule. Without
              // the retired full build it has no path; say why in the failure.
              const refusal = await buildFreeRefusalInTransaction({ firestore, transaction,
                collection: candidate.collection, document: after, fallbackReason: noBuildFallback.reason });
              if (refusal) throw new ScheduledCandidateRejection(refusal, refusal);
              control = await assertSerializerPublicationAdmissionInTransaction({ firestore, transaction });
              requireBuildReadiness();
              queueFields = preparedBatch.changes.length === 0
                ? await newDevGithubQueueFields({ firestore, transaction, control, transport: readiness?.transport ?? "github" }) : {};
            }
            if (noBuildPublication) after[PUBLISH_BUILD_QUEUE_FIELD] = noBuildPublication.contentQueueId;
          }
          delete after.scheduledPublicationTransport;
          const historyEntry = versionHistoryEntryFn({
            collection: candidate.collection,
            documentId: candidate.ref.id,
            action: "publish",
            before,
            after,
            actorUid: SCHEDULER_ACTOR,
            source: "scheduler",
          });
          const historyRef = firestore
            .collection(AUDIT_COLLECTIONS.versionHistory)
            .doc();
          const sizeError =
            documentSizeErrorFn(
              after,
              `${candidate.collection}/${candidate.ref.id}`,
              { publishing: true },
            ) ??
            documentSizeErrorFn(
              historyEntry,
              historyRef.path,
              { publishing: true, label: "the version-history row for this publish" },
            );
          if (sizeError) {
            return disposition(
              SCHEDULED_FAILURE_REASONS.oversized,
              sizeError.detail,
            );
          }

          const datasetUsageWrite = await prepareDatasetUsageWrites({ firestore, transaction, collection: candidate.collection,
            documentId: candidate.ref.id, snapshot: after.published, previousSnapshot: before.published,
            operationId: noBuildPublication?.operation.operationId, visible: true });
          const [workingUsage, publishedUsage] = await Promise.all([
            prepareMediaUsageWrite({
              firestore,
              transaction,
              collection: candidate.collection,
              documentId: candidate.ref.id,
              state: "working",
              sourceVersion: after.version,
              usage: collectWorkingMediaUsage({
                collection: candidate.collection,
                document: after,
              }),
            }),
            prepareMediaUsageWrite({
              firestore,
              transaction,
              collection: candidate.collection,
              documentId: candidate.ref.id,
              state: "published",
              releaseSelector: pairSelector ?? undefined,
              sourceVersion: after.version,
              usage: collectPublishedMediaUsage({
                collection: candidate.collection,
                snapshot: after.published,
              }),
            }),
          ]);

          try {
            if (!noBuildPublication) await assertNoBuildContentScheduleInTransaction({ firestore, transaction,
              collection: candidate.collection, documentId: candidate.ref.id, nextDocument: after, firing: true, pageScheduleCapture });
          } catch (error) {
            if (error instanceof require("./lib/public-release-pair").PublicReleaseProtocolError ||
                  error.scheduleDeferred === true || error.code === "failed-precondition") {
              throw Object.assign(new Error(error.message), { scheduleDeferred: true });
            }
            if (error.status === 409) throw new ScheduledCandidateRejection(error.message);
            throw error;
          }
          const writeReleaseChange = !noBuildPublication ? await preparePublicReleaseProducerInTransaction({ firestore, transaction,
            operationId: publicReleaseProducerOperation(candidate.collection, candidate.ref.id, after.version, after.published),
            changes: [publicContentChange(candidate.collection, candidate.ref.id, after)] }) : () => {};
          writeReleaseChange();
          if (!noBuildPublication) bumpPublicContextRevision(transaction, firestore);
          datasetUsageWrite();
          transaction.set(candidate.ref, after);
          transaction.set(historyRef, historyEntry);
          transaction.set(workingUsage.ref, workingUsage.document);
          transaction.set(publishedUsage.ref, publishedUsage.document);
          transaction.set(
            firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
            adminLogEntryFn({
              actorUid: SCHEDULER_ACTOR,
              action: "cms.schedule-publish",
              target: `${candidate.collection}/${candidate.ref.id}`,
              before: {
                status: before.status,
                version: before.version ?? null,
              },
              after: { status: "published", version: after.version },
              source: "scheduler",
            }),
          );
          const change = {
            collection: candidate.collection,
            id: candidate.ref.id,
            sourceVersion: after.published.sourceVersion,
          };
          if (noBuildPublication) noBuildPublication.write();
          else reserveQueue(transaction, change, queueFields);
          return {
            change,
            newlyPublished: true,
            ...(noBuildPublication ? { publication: { ...change, transport: noBuildPublication.transport,
              queueId: noBuildPublication.queueId, admissionRevision: noBuildPublication.operation.admissionRevision } } : {}),
          };
        } catch (error) {
          // Deterministic blockers (schema rejection, media usage) leave the
          // active due query through the shared disposition. Unexpected
          // infrastructure errors still abort the run.
          if (error.code === "serializer_publication_unavailable") {
            return disposition(error.message);
          }
          if (error instanceof ScheduledCandidateRejection) {
            return disposition(error.editorMessage, error.message);
          }
          if (error instanceof DatasetError) {
            return disposition(error.message);
          }
          if (error instanceof MediaUsageError) {
            return disposition(SCHEDULED_FAILURE_REASONS.media, error.message);
          }
          throw error;
        }
        });
        try {
          outcome = await candidateTransaction();
        } catch (error) {
          if (!(error instanceof ScheduledReadinessRequired)) throw error;
          // Readiness can reconcile this content row in a separate transaction.
          // Release its lock first, then re-read every acceptance fence.
          await ensureBuildReadiness();
          outcome = await candidateTransaction();
        }
      } catch (error) {
        if (error.code === "serializer_publication_unavailable") {
          log.error("scheduled serializer admission unavailable", { collection: candidate.collection, documentId: candidate.ref.id });
          continue;
        }
        if (error.scheduleDeferred === true) {
          log.info("scheduled publish deferred while publication is unavailable", {
            collection: candidate.collection,
            documentId: candidate.ref.id,
          });
          continue;
        }
        if (
          error instanceof ScheduledCandidateRejection ||
          error instanceof MediaUsageError
        ) {
          log.error("scheduled publish skipped a blocked document", {
            collection: candidate.collection,
            documentId: candidate.ref.id,
            detail: error.message,
          });
          continue;
        }
        throw error;
      }

      if (!outcome) continue;
      if (outcome.failed) {
        log.error("scheduled publish moved a blocked document to failure", {
          collection: candidate.collection,
          documentId: candidate.ref.id,
          detail: outcome.detail,
        });
        continue;
      }
      preparedBatch.allChanges.push(outcome.change);
      if (outcome.publication) preparedBatch.publications.push(outcome.publication);
      else preparedBatch.changes.push(outcome.change);
      if (outcome.newlyPublished) preparedBatch.newlyPublishedCount += 1;
    }

    if (preparedBatch.allChanges.length === 0) {
      if (buildReadinessError) throw buildReadinessError;
      // Same fallback as the no-candidate tick above. A window of deterministic
      // blockers moves each row to an audited failure and reaches this line with
      // nothing enqueued; the transient drops (a deleted document, one that
      // stopped being due) reach it too. Run reconciliation in every case.
      if (!scoped) await reconcileStaleFn({ firestore });
      return { publishedCount: 0, queueId: null, changes: [] };
    }
    let queued = null;
    try {
      if (preparedBatch.changes.length) queued = await enqueuePublishFn({
        actor: { uid: SCHEDULER_ACTOR, email: null },
        changes: preparedBatch.changes,
        source: "scheduler",
        readiness,
        queueId,
        queueReserved: true,
      });
    } catch (error) {
      await settleBuildQueue(firestore, {
        queueId,
        status: "failed",
        queueUpdate: {
          status: "failed",
          completedAt: FieldValue.serverTimestamp(),
          error: error?.message || "Failed to trigger publish",
        },
      });
      throw error;
    }

    log.info("scheduled publish snapshotted due content", {
      count: preparedBatch.newlyPublishedCount,
      retriedCount:
        preparedBatch.allChanges.length - preparedBatch.newlyPublishedCount,
      instantCount: preparedBatch.publications.length,
      queueId: queued?.queueId ?? null,
    });
    return {
      publishedCount: preparedBatch.newlyPublishedCount,
      queueId: queued?.queueId ?? null,
      changes: preparedBatch.allChanges,
      ...(preparedBatch.publications.length ? { publications: preparedBatch.publications } : {}),
    };
  };
}

// Deployed with cmsPublish. Fast Posts keep their atomic acceptance and confirmation
// owner. Legacy dispatch failures retain the frozen revision for bounded retry.
const onScheduledPublish = onSchedule(
  {
    schedule: "every 1 minutes",
    secrets: [...publishSecretBindings, ...routePurgeSecretNames(), CMS_EDGE_ORIGIN_SECRET],
    concurrency: 1,
    maxInstances: 1,
    timeoutSeconds: 300,
  },
  async (event) => {
    if (process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development" &&
        process.env.CMS_WRITEBACK_CONFIGURED !== "true") return;
    return createScheduledPublishRunner()(event);
  },
);

module.exports = {
  MAX_SCHEDULED_CANDIDATE_READS_PER_RUN,
  MAX_SCHEDULED_CHANGES_PER_RUN,
  SCHEDULED_COLLECTIONS,
  SCHEDULER_ACTOR,
  PUBLISH_BUILD_PENDING_FIELD,
  PUBLISH_BUILD_QUEUE_FIELD,
  canonicalInstant,
  createScheduledPublishRunner,
  isDue,
  isPendingBuild,
  onScheduledPublish,
  samePublishAtValue,
};
