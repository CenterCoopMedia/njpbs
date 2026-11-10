"use strict";

const { readNoBuildPostCapability } = require("./no-build-post-ownership");
const { assertPublicDeploymentPointer } = require("./public-deployment");

const supportsLiveBlog = capability => capability?.liveBlogVersion === 1;
const containsLiveBlog = snapshot => snapshot?.metadata?.liveBlog !== undefined;

function candidateSupportsOwnedLiveBlog(state, snapshot, contract) {
  return state?.visible !== true || !containsLiveBlog(snapshot) || (supportsLiveBlog(contract)
    && liveBlogContractVersion(contract) >= requiredLiveBlogContractVersion(snapshot.metadata.liveBlog));
}

const PRESENTATION_PENDING = "Live blog appearance settings take effect after the update. Choose them again after the update.";
const liveBlogContractVersion = capability => capability?.liveBlogContractVersion ?? 1;

const LIVE_BLOG_CONTRACTS = "system/publicDeployment/liveBlogContracts";
const { LIVE_BLOG_CONTRACT_VERSION } = require("./live-blog");

/** Companion metadata keeps OLD's strict shared capability key set unchanged. */
function writeLiveBlogContractMarker({ firestore, transaction, rendererSha, version = LIVE_BLOG_CONTRACT_VERSION }) {
  if (!/^[a-f0-9]{40}$/.test(rendererSha) || ![1, 2, 3].includes(version)) throw new Error("Invalid live blog contract marker");
  transaction.set(firestore.doc(`${LIVE_BLOG_CONTRACTS}/${rendererSha}`), { schemaVersion: 1, rendererSha, liveBlogContractVersion: version });
}

async function readLiveBlogContractForRenderer({ firestore, transaction, rendererSha }) {
  if (typeof rendererSha !== "string" || !/^[a-f0-9]{40}$/.test(rendererSha)) return 1;
  try {
    const marker = (await transaction.get(firestore.doc(`${LIVE_BLOG_CONTRACTS}/${rendererSha}`))).data();
    if (marker?.schemaVersion !== 1 || marker.rendererSha !== rendererSha || ![1, 2, 3].includes(marker.liveBlogContractVersion)) return 1;
    return marker.liveBlogContractVersion;
  } catch { return 1; }
}

/** Bind the companion to the exact active public reader, never an editor claim. */
async function readLiveBlogContractVersion({ firestore, transaction }) {
  const root = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
  let rendererSha;
  if (root?.schemaVersion === 2) {
    const protocol = require("./public-release-pair");
    const selector = require("./public-release-media-fence").parseStoredSelector(root);
    const work = require("./public-release-pair-work");
    const base = work.publicReleasePairPath(selector.selectedPair.pairId);
    const [pairRow, runtimeRow] = await transaction.getAll(firestore.doc(base), firestore.doc(`${base}/controls/runtime`));
    const pair = protocol.parsePublicReleasePair(pairRow.data());
    work.assertPublicReleasePairDatabase(firestore, pair);
    if (protocol.publicReleaseDigest(protocol.publicReleasePairReference(pair)) !== protocol.publicReleaseDigest(selector.selectedPair) ||
        runtimeRow.data()?.status !== "retained") return 1;
    rendererSha = pair.commitSha;
  } else {
    const capability = await readNoBuildPostCapability({ firestore, transaction });
    if (!supportsLiveBlog(capability) || capability.servingEnabled !== true ||
        capability.rendererSha !== root?.activeCommitSha) return 1;
    rendererSha = capability.rendererSha;
  }
  return readLiveBlogContractForRenderer({ firestore, transaction, rendererSha });
}

function containsLiveBlogFollowUps(liveBlog) {
  return Array.isArray(liveBlog?.updates) && liveBlog.updates.some(entry => entry?.followUps !== undefined);
}
function requiredLiveBlogContractVersion(liveBlog) {
  return containsLiveBlogFollowUps(liveBlog) ? 3 : liveBlog?.presentation !== undefined ? 2 : 1;
}
async function assertLiveBlogFollowUpsRenderer({ firestore, transaction, liveBlog }) {
  if (containsLiveBlogFollowUps(liveBlog) && await readLiveBlogContractVersion({ firestore, transaction }) < 3) {
    throw Object.assign(new Error("Follow-ups are not available until the updated live blog reader is live. Keep your draft and try again after the update."), { status: 409, code: "live_blog_follow_ups_unavailable", scheduleDeferred: true });
  }
}

async function assertLiveBlogPresentationRenderer({ firestore, transaction, liveBlog }) {
  await assertLiveBlogFollowUpsRenderer({ firestore, transaction, liveBlog });
  if (liveBlog?.presentation !== undefined && await readLiveBlogContractVersion({ firestore, transaction }) < 2) {
    throw Object.assign(new Error(PRESENTATION_PENDING), { status: 409, scheduleDeferred: true });
  }
}

/** Feature support comes from the installed exact-SHA renderer, never a request. */
async function assertLiveBlogRenderer({ firestore, transaction, liveBlog }) {
  await assertLiveBlogPresentationRenderer({ firestore, transaction, liveBlog });
  const capability = await readNoBuildPostCapability({ firestore, transaction });
  const pointer = assertPublicDeploymentPointer((await transaction.get(firestore.doc("system/publicDeployment"))).data());
  if (!supportsLiveBlog(capability) || capability.servingEnabled !== true ||
      pointer.state !== "idle" || capability.rendererSha !== pointer.activeCommitSha) {
    throw Object.assign(new Error("The installed Post renderer does not support live blogs yet. Try again after its release is verified."), { status: 409, scheduleDeferred: true });
  }
}

module.exports = { containsLiveBlogFollowUps, requiredLiveBlogContractVersion, assertLiveBlogFollowUpsRenderer, LIVE_BLOG_CONTRACT_VERSION, LIVE_BLOG_CONTRACTS, writeLiveBlogContractMarker, readLiveBlogContractForRenderer, PRESENTATION_PENDING, liveBlogContractVersion, readLiveBlogContractVersion, assertLiveBlogPresentationRenderer, supportsLiveBlog, containsLiveBlog, candidateSupportsOwnedLiveBlog, assertLiveBlogRenderer };
