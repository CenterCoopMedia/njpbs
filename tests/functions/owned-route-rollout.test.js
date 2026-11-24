import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { verifyOwnedPostRoutes } = require("../../functions/lib/no-build-post-recovery.js");
const { publicationTarget } = require("../../functions/lib/publication-target.js");

const previous = "a".repeat(40), candidateSha = "b".repeat(40);
const state = { slug: "owned-story", ownedSlugs: ["owned-story"], visible: true, operationId: "op-1", sourceVersion: 2 };
const candidate = { commitSha: candidateSha, workerVersionId: "version-2", noBuildPost: { enabled: true } };
const admission = { valid: true, admissionRevision: 1 };
const html = "<!doctype html><html><body>Owned</body></html>";

function answer(renderer, status = 200) {
  return new Response(status === 200 ? html : "Post unavailable", { status, headers: {
    "cache-control": "no-store", "x-njpbs-content-source": "cms-no-build", "x-njpbs-publication-operation": "op-1",
    "x-njpbs-source-version": "2", "x-njpbs-admission-revision": "1",
    ...(renderer ? { "x-njpbs-renderer-sha": renderer } : {}),
    ...(status === 200 ? { "x-njpbs-html-sha256": createHash("sha256").update(html).digest("hex") } : {}),
  } });
}

function verify(answers, backstopMs = 60_000) {
  let clock = 0, reads = 0;
  const fetchPublic = async () => answers[Math.min(reads++, answers.length - 1)]();
  const rollout = { backstopMs, now: () => clock, wait: async () => { clock += 1_000; } };
  const run = verifyOwnedPostRoutes({ state, candidate, admission, fetchPublic, target: publicationTarget("production"),
    headers: {}, previousRendererSha: previous, rollout });
  return { run, reads: () => reads, clock: () => clock };
}

it("reads again while the previous renderer answers, then judges the candidate once", async () => {
  const check = verify([() => answer(previous), () => answer(previous), () => answer(candidateSha)]);
  await expect(check.run).resolves.toBeUndefined();
  expect(check.reads()).toBe(3);
});

it("refuses a candidate failure at once", async () => {
  const check = verify([() => answer(candidateSha, 500), () => answer(candidateSha)]);
  await expect(check.run).rejects.toThrow("did not preserve its instant Post routes");
  expect(check.reads()).toBe(1);
});

it("refuses an answer without the candidate renderer at once", async () => {
  const check = verify([() => answer(null, 503), () => answer(candidateSha)]);
  await expect(check.run).rejects.toThrow("did not preserve its instant Post routes");
  expect(check.reads()).toBe(1);
});

it("stops at the backstop when the candidate version never arrives", async () => {
  const check = verify([() => answer(previous)], 5_000);
  await expect(check.run).rejects.toThrow("still answers from the previous renderer");
  expect(check.clock()).toBe(5_000);
  expect(check.reads()).toBe(6);
});
