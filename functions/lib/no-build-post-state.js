"use strict";

const { isServerMintableSlugShape } = require("./post-slug-contract");
const { publicationRuntime } = require("./publication-runtime-owner");
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validSha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function refuse(message = "Instant Post ownership is unavailable.") {
  throw Object.assign(new Error(message), { status: 409 });
}

function validateState(state) {
  if (!state) return null;
  if ((state.mode !== undefined && !["dynamic", "static"].includes(state.mode)) || typeof state.servingEnabled !== "boolean" ||
      (state.operationId !== null && (!Number.isSafeInteger(state.sourceVersion) || state.sourceVersion < 1 ||
        !isServerMintableSlugShape(state.slug) || typeof state.visible !== "boolean")) ||
      state.schemaVersion !== 1 || !validId(state.postId) || !validSha(state.rendererSha) ||
      (state.snapshotDigest !== undefined && !validDigest(state.snapshotDigest)) ||
      (state.datasetFiguresDigest !== undefined &&
        (!validDigest(state.datasetFiguresDigest) || !validDigest(state.snapshotDigest))) ||
      !Array.isArray(state.ownedSlugs) || state.ownedSlugs.length > 100 ||
      state.ownedSlugs.some(slug => !isServerMintableSlugShape(slug)) ||
      new Set(state.ownedSlugs).size !== state.ownedSlugs.length ||
      !Number.isSafeInteger(state.generation) || state.generation < 0 ||
      (state.operationId !== null && !/^[A-Za-z0-9]{20}$/.test(state.operationId))) refuse();
  if (state.contentRedirectUrl != null && require("./content-link").contentLinkError({ contentLinkMode: "custom", contentLinkUrl: state.contentRedirectUrl })) refuse();
  if (state.runtime !== undefined) publicationRuntime(state.runtime);
  return state;
}

function validateCapability(value) {
  if (!value) return null;
  const common = ["schemaVersion", "rendererSha", "servingEnabled", "generation"];
  const required = value.schemaVersion === 1 ? [...common, "postId"] : common;
  const fields = [...required, "dataFigureVersion", "electionResultsVersion", "liveBlogVersion"];
  if (typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length < required.length || Object.keys(value).length > fields.length ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !fields.includes(key)) || ![1, 2].includes(value.schemaVersion) ||
      (value.schemaVersion === 1 && !validId(value.postId)) ||
      !validSha(value.rendererSha) || typeof value.servingEnabled !== "boolean" ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      (value.dataFigureVersion !== undefined && value.dataFigureVersion !== 1) ||
      (value.electionResultsVersion !== undefined && ![1, 2].includes(value.electionResultsVersion)) ||
      (value.liveBlogVersion !== undefined && value.liveBlogVersion !== 1)) refuse();
  return { ...value };
}

function effectiveNoBuildPostState(state, capability) {
  if (!state || !capability || state.mode === "static") return state;
  if (capability.schemaVersion === 1 && capability.postId !== state.postId) refuse();
  return { ...state, rendererSha: capability.rendererSha, servingEnabled: capability.servingEnabled,
    generation: Math.max(state.generation, capability.generation) };
}

function candidateNoBuildContract(value) {
  if (value === undefined) return null;
  const common = ["schemaVersion", "rendererSha", "enabled", "authoritative"];
  const required = value?.schemaVersion === 2 ? [...common, "families"] : [...common, "postId"];
  const fields = [...required, "dataFigureVersion", "electionResultsVersion", "liveBlogVersion"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length < required.length || Object.keys(value).length > fields.length ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !fields.includes(key)) || !validSha(value.rendererSha) ||
      typeof value.enabled !== "boolean" || value.authoritative !== true ||
      (value.dataFigureVersion !== undefined && value.dataFigureVersion !== 1) ||
      (value.electionResultsVersion !== undefined && ![1, 2].includes(value.electionResultsVersion)) ||
      (value.liveBlogVersion !== undefined && value.liveBlogVersion !== 1)) refuse();
  if (value.schemaVersion === 2) {
    if (!Array.isArray(value.families) || value.families.length !== 1 || value.families[0] !== "posts") refuse();
    return { ...value, families: ["posts"] };
  }
  if (value.schemaVersion !== 1 || !validId(value.postId)) refuse();
  return { ...value };
}

function candidateSupportsPost(contract, postId) {
  return contract?.schemaVersion === 2 || contract?.postId === postId;
}

module.exports = { validateState, validateCapability, effectiveNoBuildPostState, candidateNoBuildContract, candidateSupportsPost };
