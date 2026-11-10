"use strict";
const { ElectionSourceError, parseElectionRoster } = require("./election-result-sources");
const roster = require("../fixtures/election-rehearsal-2015-roster.json");
const CONTROL = "system/electionResultSources";
const RESULTS_URL = "https://centercoopmedia.github.io/nj-decides/data/rehearsal-2015-results.json";
const label = value => typeof value === "string" && value.startsWith("REHEARSAL:");
function refuse() {
  throw new ElectionSourceError("rehearsal", "Rehearsal results require the enabled, exact test Page with its REHEARSAL label and search exclusion.");
}
function rehearsalRoster() { return parseElectionRoster(roster, roster.electionDate); }
async function assertRehearsalTarget({ firestore, transaction, connection, document }) {
  const ap = connection.config?.apRehearsal;
  if (connection.config?.rehearsal !== true && !ap) return;
  if (connection.config?.rehearsal === true && ap) refuse();
  const controls = (await transaction.get(firestore.doc(CONTROL))).data();
  const control = ap ? controls?.apRehearsal : controls?.rehearsal;
  const metadata = document?.published?.metadata;
  if (firestore.projectId !== "njpbs-site" || control?.enabled !== true ||
      connection.collection !== "cmsPages" || control.documentId !== connection.documentId || control.blockId !== connection.blockId ||
      !/^page-[a-f0-9]{32}$/.test(connection.documentId) ||
      document?.template !== "genericPage" || document?.seo?.noindex !== true || metadata?.seo?.noindex !== true ||
      !label(document.title) || !label(metadata.title) || document.pageTheme === "nj-decides" || metadata.pageTheme === "nj-decides" ||
      !/^rehearsal-[a-f0-9]{32}$/.test(document.slug ?? "") || metadata.slug !== document.slug ||
      (document.previousSlugs?.length ?? 0) !== 0 || (metadata.previousSlugs?.length ?? 0) !== 0) refuse();
  if (ap && (connection.config.source?.kind !== "ap" ||
      !document.title.startsWith("REHEARSAL: AP 2026") || !metadata.title.startsWith("REHEARSAL: AP 2026") ||
      control.sourceTimeOrigin !== ap.sourceTimeOrigin || control.replayTimeOrigin !== ap.replayTimeOrigin)) refuse();
}
function assertRehearsalLabels(data) {
  if (data.races.some(race => !label(race.sourceLabel))) refuse();
}
module.exports = { RESULTS_URL, rehearsalRoster, assertRehearsalTarget, assertRehearsalLabels };
