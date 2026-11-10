"use strict";

const { fingerprint, fail } = require("./live-production-requests");
const same = (left, right) => fingerprint(left) === fingerprint(right);
const contentKey = candidate => fingerprint([candidate.marker, candidate.rawLines]);
function proposalBaseline(candidate, templateId) {
  if (candidate.text?.templateId === templateId) return candidate.text;
  return templateId === "headline" ? { templateId, headline: candidate.rawLines.join("\n") } :
    { templateId, name: candidate.rawLines[0] ?? "", title: candidate.rawLines.slice(1).join("\n") };
}
function protectedFields(banner) {
  const baseline = banner.rundown.acceptedText, current = banner.record.draft.text;
  const changed = Object.keys(current).filter(key => current.templateId !== baseline.templateId || current[key] !== baseline[key]);
  const fields = [...new Set([...(banner.rundown.protectedFields ?? []), ...changed])]
    .filter(key => key === "order" || Object.hasOwn(current, key));
  if (banner.order !== banner.rundown.acceptedOrder) fields.push("order");
  return [...new Set(fields)];
}
function similarity(left, right) {
  const words = text => new Set(text.join(" ").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const a = words(left), b = words(right);
  return a.size && b.size ? [...a].filter(word => b.has(word)).length / Math.max(a.size, b.size) : 0;
}
function targetView(banner) {
  return { bannerId: banner.record.id, baseVersion: banner.record.draft.version, text: banner.record.draft.text,
    order: banner.order, protectedFields: protectedFields(banner),
    sourceContext: [banner.rundown.tabTitle, banner.rundown.segmentTitle].filter(Boolean).join(" / ") || "Source-linked banner" };
}

// Context gives a match only when it is unique. Text similarity supplies choices,
// never authority to merge identities. Manual/CSV rows never enter this function.
function matchCandidates(candidates, banners) {
  const matched = new Map(), used = new Set();
  for (const candidate of candidates) {
    const peers = candidates.filter(item => item.contextKey === candidate.contextKey);
    const existing = banners.filter(banner => banner.rundown.contextKey === candidate.contextKey);
    const exact = existing.filter(banner => banner.rundown.contentKey === contentKey(candidate));
    let match = null;
    if (peers.length === 1 && existing.length === 1) match = existing[0];
    else if (exact.length === 1 && peers.filter(peer => contentKey(peer) === contentKey(candidate)).length === 1) match = exact[0];
    if (match && !used.has(match.record.id)) { matched.set(candidate.id, match); used.add(match.record.id); }
  }
  return { matched, used };
}
function reconcileCandidates(parsed, banners, previousPresence = {}) {
  if (banners.length > 100) fail("Archive older rundown drafts before reviewing more than 100 source-linked banners.", 413);
  const candidates = parsed.proposals, { matched, used } = matchCandidates(candidates, banners);
  const presence = Object.fromEntries(banners.map(banner => {
    const id = banner.record.id, previous = previousPresence[id] ?? { present: true, absence: 0 };
    const present = used.has(id);
    return [id, { present, absence: previous.absence + (!present && previous.present ? 1 : 0) }];
  }));
  const changes = [];
  for (const candidate of candidates) {
    const banner = matched.get(candidate.id);
    if (banner?.rundown.sourceFingerprint === candidate.fingerprint && !banner.rundown.removedFingerprint) continue;
    const possible = banner ? [] : banners.filter(item => !used.has(item.record.id) &&
      (item.rundown.contextKey === candidate.contextKey || item.rundown.contentKey === contentKey(candidate) ||
        similarity(item.rundown.rawLines, candidate.rawLines) >= 0.6));
    const status = !banner ? possible.length || candidate.flags.length || !candidate.text ? "AMBIGUOUS" : "NEW" :
      banner.rundown.contentKey === contentKey(candidate) && !banner.rundown.removedFingerprint ? "MOVED" : "CHANGED";
    const digest = fingerprint([banner?.record.id ?? candidate.id, candidate.fingerprint]);
    changes.push({ id: digest.slice(0, 32), fingerprint: digest, status, candidate, target: banner ? targetView(banner) : null,
      possibleTargets: possible.slice(0, 5).map(targetView),
      reasons: [...candidate.flags, ...(possible.length ? ["Identity is uncertain. Choose an existing source-linked banner or create a new draft."] : []),
        ...(banner && protectedFields(banner).length ? ["Producer-edited fields stay protected unless explicitly selected."] : [])] });
  }
  for (const banner of banners) {
    if (used.has(banner.record.id)) continue;
    const digest = fingerprint([banner.record.id, "removed", presence[banner.record.id].absence]);
    if (banner.rundown.removedFingerprint === digest) continue;
    changes.push({ id: digest.slice(0, 32), fingerprint: digest, status: "REMOVED", candidate: null,
      target: targetView(banner), possibleTargets: [], reasons: ["Source passage is absent or moved. Keep the draft; no automatic deletion."] });
  }
  return { changes, presence };
}
function acceptedText(current, proposed, overrides) {
  if (!current) return proposed;
  const protectedKeys = protectedFields(current);
  if (proposed.templateId !== current.record.draft.text.templateId) {
    if (protectedKeys.some(key => key !== "order" && !overrides.includes(key))) fail("Explicitly approve every protected text field before changing this template.", 409);
    return proposed;
  }
  const text = { ...proposed };
  for (const key of protectedKeys) {
    if (key !== "order" && !overrides.includes(key)) text[key] = current.record.draft.text[key];
  }
  return text;
}
module.exports = { same, contentKey, protectedFields, reconcileCandidates, acceptedText, proposalBaseline };
