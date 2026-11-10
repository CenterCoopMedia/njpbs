import { readCmsDeployWorkflow } from "../helpers/cms-deploy-workflow.mjs";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { FirestoreApi } = require("firebase-tools/lib/firestore/api.js");

it("preserves undeclared Firestore field overrides and TTL policies on both deploy paths", () => {
  const workflow = parse(readCmsDeployWorkflow());
  const commands = workflow.jobs.firebase.steps.flatMap(step => [...(step.run ?? "").matchAll(/(?:npx --no-install )?firebase deploy\s[\s\S]*?--non-interactive/g)].map(match => match[0]))
    .filter(command => command.includes("firestore:indexes"));
  expect(commands).toHaveLength(3);
  for (const command of commands) expect(command).not.toMatch(/--force\b/);
  const indexes = JSON.parse(readFileSync(new URL("../../firestore.indexes.json", import.meta.url), "utf8"));
  expect(indexes.fieldOverrides.filter(value => value.ttl === true).length).toBeGreaterThanOrEqual(7);
});

it.each([false, true])("proves the installed Firebase CLI field/TTL deletion behavior (force=%s) without provider calls", async force => {
  const api = new FirestoreApi();
  // Every provider boundary is replaced; an unexpected call fails this test.
  api.apiClient = { patch() { throw new Error("Unexpected provider call"); } };
  api.listIndexes = async () => [];
  api.getDatabase = async () => ({ databaseEdition: "STANDARD" });
  api.listFieldOverrides = async () => Array.from({ length: 5 }, (_, index) => ({
    name: `projects/test-only/databases/(default)/collectionGroups/retained${index}/fields/purgeAt`,
    ttlConfig: { state: "ACTIVE" }, indexConfig: { indexes: [] },
  }));
  api.deleteField = vi.fn(async () => {});
  api.patchField = vi.fn(async () => {});
  await api.deploy({ project: "test-only", nonInteractive: true, force }, [],
    [{ collectionGroup: "declared", fieldPath: "purgeAt", ttl: true, indexes: [] }]);
  expect(api.deleteField).toHaveBeenCalledTimes(force ? 5 : 0);
  expect(api.patchField).toHaveBeenCalledTimes(1);
});
