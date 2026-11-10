import assert from "node:assert/strict";
import { test } from "node:test";
import { devReconcileEnvironment } from "./dev-reconcile-input.mjs";

const env = { CANONICAL_GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", CANONICAL_GITHUB_REPOSITORY_ID: "1442374012",
  GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", RETAINED_RUN_ID: "42",
  RETAINED_QUEUE_ID: "abcdefghijklmnopqrst", RETAINED_GENERATION: "2",
  RETAINED_WORKER_VERSION_ID: "11111111-1111-4111-8111-111111111111",
  CMS_DEV_PUBLISH_ENABLED: "false", CMS_DEV_DISPATCH_ACTOR: "dev-publisher[bot]",
  CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: '["publisher"]',
};
const run = {
  id: 42, path: ".github/workflows/cms-dev-publish.yml", event: "push",
  head_branch: "main", head_sha: "a".repeat(40), status: "completed", conclusion: "failure",
  repository: { full_name: env.GITHUB_REPOSITORY }, head_repository: { full_name: env.GITHUB_REPOSITORY },
  actor: { login: "publisher" }, triggering_actor: { login: "publisher" },
};

test("reconciliation requires explicit trusted publication actors", () => {
  assert.equal(devReconcileEnvironment(run, env).SOURCE_SHA, run.head_sha);
  for (const actors of [undefined, "", "[]", "invalid", '["unrelated"]']) {
    assert.throws(() => devReconcileEnvironment(run, { ...env, CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: actors }));
  }
});

test("development dispatch and trusted rerunner remain separate identities", () => {
  const dispatch = { ...run, event: "repository_dispatch", actor: { login: "dev-publisher[bot]" } };
  assert.doesNotThrow(() => devReconcileEnvironment(dispatch, env));
  assert.doesNotThrow(() => devReconcileEnvironment({ ...dispatch, triggering_actor: dispatch.actor }, env));
  assert.throws(() => devReconcileEnvironment({ ...dispatch, triggering_actor: { login: "unrelated" } }, env));
  assert.throws(() => devReconcileEnvironment(dispatch, { ...env, CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: '["publisher","dev-publisher[bot]"]' }));
});
