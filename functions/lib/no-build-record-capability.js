"use strict";

const { RECORD_FAMILIES, readRecordNamespace } = require("./no-build-record-namespace");
const { listNoBuildRecordOwners, recordRouteRef, assertRecordOwnerSnapshot } = require("./no-build-record-ownership");
const CAPABILITY_PATH = "system/publicDeployment/noBuildRecords/capability";
function refuse(message = "The record renderer capability is unavailable.") { throw Object.assign(new Error(message), { status: 409 }); }
function candidateNoBuildRecordContract(value) {
  if (value === undefined) return null;
  const keys = ["schemaVersion", "rendererSha", "enabled", "authoritative", "families"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key)) || value.schemaVersion !== 1 ||
      !/^[a-f0-9]{40}$/.test(value.rendererSha ?? "") || typeof value.enabled !== "boolean" || value.authoritative !== true ||
      !Array.isArray(value.families) || !value.families.length ||
      JSON.stringify(value.families) !== JSON.stringify(RECORD_FAMILIES.filter(family => value.families.includes(family)))) refuse();
  return { ...value, families: [...value.families] };
}
async function readRecordCapability({ firestore, transaction }) {
  const row = await (transaction ? transaction.get(firestore.doc(CAPABILITY_PATH)) : firestore.doc(CAPABILITY_PATH).get());
  const value = row.data();
  if (!row.exists) return null;
  const keys = ["schemaVersion", "rendererSha", "servingEnabled", "families", "generation"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => ![...keys, "terminalOwner"].includes(key)) || keys.some(key => !Object.hasOwn(value, key)) ||
      !Number.isSafeInteger(value.generation) || value.generation < 1) refuse();
  candidateNoBuildRecordContract({ schemaVersion: value.schemaVersion, rendererSha: value.rendererSha,
    enabled: value.servingEnabled, authoritative: true, families: value.families });
  const seal = value.terminalOwner;
  if (seal !== undefined && (!seal || typeof seal !== "object" || Array.isArray(seal) ||
      Object.keys(seal).length !== 3 || Object.keys(seal).some(key => !["schemaVersion", "transport", "rendererSha"].includes(key)) ||
      seal.schemaVersion !== 1 || seal.transport !== "public-context-no-build-v1" || seal.rendererSha !== value.rendererSha)) refuse();
  return value;
}
/** Code activation cannot release a registered namespace or a retained route. */
async function assertRecordCandidateInTransaction({ firestore, transaction, candidate }) {
  const contract = candidateNoBuildRecordContract(candidate.noBuildRecord);
  if (contract && contract.rendererSha !== candidate.commitSha) refuse("The record renderer does not match its candidate.");
  const namespace = await readRecordNamespace({ firestore, transaction });
  const owners = await listNoBuildRecordOwners({ firestore, transaction });
  if (owners.some(({ state }) => !namespace.families.includes(state.family))) refuse("Record namespace ownership is unavailable.");
  if (namespace.families.length && (!contract?.enabled || namespace.families.some(family => !contract.families.includes(family)))) {
    refuse("The public candidate must preserve registered record families.");
  }
  const refs = owners.flatMap(({ state }) => [firestore.doc(`cmsPosts/${state.documentId}`),
    ...state.ownedPaths.map(path => recordRouteRef(firestore, path))]);
  const rows = [];
  for (let offset = 0; offset < refs.length; offset += 100) rows.push(...await transaction.getAll(...refs.slice(offset, offset + 100)));
  let index = 0;
  for (const { state } of owners) {
    assertRecordOwnerSnapshot(state, rows[index++].data());
    for (const path of state.ownedPaths) {
      const claim = rows[index++].data();
      if (claim?.schemaVersion !== 1 || claim.path !== path || claim.family !== state.family || claim.documentId !== state.documentId) refuse();
    }
  }
  return contract;
}
function writeRecordCandidateActivation(transaction, firestore, contract, candidate) {
  if (!contract) return;
  if (typeof require("./no-build-record-publication").prepareNoBuildRecordPublication !== "function" ||
      typeof require("./no-build-record-retry").existingNoBuildRecordPublication !== "function" ||
      typeof require("./no-build-record-confirmation").recoverNoBuildRecordPublication !== "function") refuse();
  transaction.set(firestore.doc(CAPABILITY_PATH), { schemaVersion: 1, rendererSha: candidate.commitSha,
    servingEnabled: contract.enabled, families: contract.families, generation: candidate.generation,
    terminalOwner: { schemaVersion: 1, transport: "public-context-no-build-v1", rendererSha: candidate.commitSha } });
}
module.exports = { CAPABILITY_PATH, candidateNoBuildRecordContract, readRecordCapability,
  assertRecordCandidateInTransaction, writeRecordCandidateActivation };
