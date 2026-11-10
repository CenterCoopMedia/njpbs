import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pair, reader } from "./cms-preview-pairs.js";
const api = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair.js");
export const bodyDigest = bytes => createHash("sha256").update(bytes).digest("hex");
export function bridgeFixture(now = Date.now()) {
  const readers = Object.fromEntries(["functions", "cmsApi"].map(component => [component,
    { ...reader(component, now), supported: { ...reader(component, now).supported, adminSession: [1, 2] } }]));
  const publicPairs = ["a", "b"].map(value => ({ pairDigest: value.repeat(64), requirements: pair("old").requirements }));
  const previewPairs = [pair("old"), pair("new", "b")];
  const state = { schemaVersion: 2, publicSelectorDigest: "c".repeat(64), publicPairs, previewPairs };
  const scopes = { publicOld: publicPairs[0].pairDigest, publicNew: publicPairs[1].pairDigest,
    previewOld: api.digest(previewPairs[0]), previewNew: api.digest(previewPairs[1]) };
  const cases = [];
  for (const [scope, pairDigest] of Object.entries(scopes)) for (const version of [1, 2]) {
    for (const feature of ["publicCode", "postChrome", "settings", "capabilities", ...(scope.startsWith("preview") ? ["previewRequest"] : [])]) {
      const fixtureCase = `${scope}:${version}:${feature}`;
      const endpoint = feature === "settings" ? "cmsGetPublishedSettings" : feature === "previewRequest" ? "cmsPreviewStatus"
        : feature === "publicCode" ? "cmsReadPairCurrentCodeV2" : "cmsGetPublicPage";
      const body = { fixtureCase, ...(feature === "settings" ? { id: "station" } : feature === "previewRequest" ? { queueId: "q".repeat(20) } : {
        ...(feature === "publicCode" ? { schemaVersion: 2 } : {}),
        mode: { publicCode: "current-code-v2", postChrome: "no-build-post-v1", capabilities: "no-build-page-v1" }[feature],
      }) };
      const response = JSON.stringify({ fixtureCase, immutableSource: pairDigest });
      cases.push({ scope, feature, version, pairDigest, endpoint, body,
        expected: { status: 200, contentType: "application/json", bodyDigest: bodyDigest(response) } });
    }
  }
  return { state, request: { schemaVersion: 2, operationId: "reader-install", expectedStateDigest: api.digest(state), readers, cases } };
}
