import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { openRehearsalDemoResources } from "../../scripts/lib/public-release-rehearsal-demo.mjs";

let directory: string, packet: any;
beforeEach(async () => {
  for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) vi.stubEnv(key, undefined);
  directory = await mkdtemp(join(tmpdir(), "rehearsal-demo-resources-"));
  packet = { schemaVersion: 1, runId: `demo-store-${randomUUID()}`, projectId: 'demo-njpbs',
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: "http://127.0.0.1:18396", proofOrigin: "http://127.0.0.1:18397",
    adapter: resolve("scripts/lib/public-release-rehearsal-adapter.mjs"), oldPair: releasePair(), newPair: releasePair("b", "b".repeat(40)),
    previewPairs: { old: { pairId: "preview-old", rendererSha: "a".repeat(40), serializerId: "preview-old" },
      new: { pairId: "preview-new", rendererSha: "b".repeat(40), serializerId: "preview-new" } } };
});
afterEach(async () => { try { await rm(directory, { recursive: true, force: true }); } finally { vi.unstubAllEnvs(); } });

it("requires explicit demo authorization and the exact closed emulator identity before opening resources", async () => {
  await expect(openRehearsalDemoResources({ packet, directory })).rejects.toThrow("refused");
  await expect(openRehearsalDemoResources({ packet: { ...packet, projectId: "njpbs-site" }, directory, authorized: true })).rejects.toThrow();
  await expect(openRehearsalDemoResources({ packet: { ...packet, emulatorHost: "127.0.0.1:1" }, directory, authorized: true })).rejects.toThrow();
});
it("keeps actual SDK facts and native R2 bytes across simultaneous runtimes and a later reopen", async () => {
  let first: Awaited<ReturnType<typeof openRehearsalDemoResources>> | undefined;
  let second: typeof first, reopened: typeof first;
  try {
    first = await openRehearsalDemoResources({ packet, directory, authorized: true });
    await first.firestore.doc(`rehearsalDemo/${packet.runId}`).create({ operation: "original", sourceVersion: 9 });
    await first.store.put("original", "actual original R2 bytes");
    second = await openRehearsalDemoResources({ packet, directory, authorized: true });
    expect(await (await second.store.get("original"))!.text()).toBe("actual original R2 bytes");
    await second.store.put("next", "actual later R2 bytes");
    expect(await (await first.store.get("next"))!.text()).toBe("actual later R2 bytes");
    await second.close(); second = undefined;
    await first.close(); first = undefined;
    reopened = await openRehearsalDemoResources({ packet, directory, authorized: true });
    expect((await reopened.firestore.doc(`rehearsalDemo/${packet.runId}`).get()).data()).toEqual({ operation: "original", sourceVersion: 9 });
    expect(await (await reopened.store.get("original"))!.text()).toBe("actual original R2 bytes");
  } finally { await reopened?.close(); await second?.close(); await first?.close(); }
});
it("refuses an aliased persistence directory", async () => {
  const alias = directory + "-alias";
  try {
    await symlink(directory, alias, "dir");
    await expect(openRehearsalDemoResources({ packet, directory: alias, authorized: true })).rejects.toThrow("directory refused");
  } finally { await rm(alias, { force: true }); }
});
