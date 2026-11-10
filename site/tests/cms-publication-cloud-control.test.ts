// @vitest-environment node

import { expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  assertPublicationRuntimeIdentity,
  confirmPublicationRuntimeReady,
  parsePublicationRuntimeControl,
} from "../scripts/cms-publication-cloud-control";

const commitSha = "a".repeat(40);
const serializerId = "cloud-publication-primary";
const control = {
  schemaVersion: 1 as const,
  phase: "starting" as const,
  commitSha,
  serializerId,
};

function database(value: unknown, exists = true) {
  const ref = { get: async () => ({ exists, data: () => value }) };
  const update = vi.fn();
  const set = vi.fn();
  const firestore = {
    doc: vi.fn(() => ref),
    runTransaction: async (
      run: (transaction: unknown) => Promise<void>,
    ) => run({ get: async () => ({ exists, data: () => value }), update, set }),
  } as unknown as Firestore;
  return { firestore, ref, update, set };
}

it.each(["paused", "starting", "ready"] as const)(
  "accepts an exact %s runtime control",
  (phase) => {
    expect(parsePublicationRuntimeControl({ ...control, phase }))
      .toEqual({ ...control, phase });
  },
);

it.each([
  undefined,
  null,
  {},
  { ...control, schemaVersion: 2 },
  { ...control, phase: "invalid" },
  { ...control, commitSha: "short" },
  { ...control, serializerId: "../other" },
  { ...control, extra: true },
])("rejects malformed runtime control %#", (value) => {
  expect(() => parsePublicationRuntimeControl(value)).toThrow(
    "runtime control is invalid",
  );
});

it("requires a present exact startup identity", async () => {
  await expect(assertPublicationRuntimeIdentity(
    database(undefined, false).firestore,
    commitSha,
    serializerId,
  )).rejects.toThrow("requires a runtime control");
  await expect(assertPublicationRuntimeIdentity(
    database({ ...control, serializerId: "other-owner" }).firestore,
    commitSha,
    serializerId,
  )).rejects.toThrow("requires another serializer");
});

it("changes only the exact starting control to ready", async () => {
  const db = database(control);
  await confirmPublicationRuntimeReady(db.firestore, commitSha, serializerId);
  expect(db.update).toHaveBeenCalledOnce();
  expect(db.update).toHaveBeenCalledWith(db.ref, { phase: "ready" });
});

it.each(["paused", "ready"] as const)(
  "does not reopen or rewrite a %s control",
  async (phase) => {
    const db = database({ ...control, phase });
    await confirmPublicationRuntimeReady(db.firestore, commitSha, serializerId);
    expect(db.update).not.toHaveBeenCalled();
  },
);

it("refuses a startup identity that changed inside the transaction", async () => {
  const db = database({ ...control, commitSha: "b".repeat(40) });
  await expect(confirmPublicationRuntimeReady(
    db.firestore,
    commitSha,
    serializerId,
  )).rejects.toThrow("changed during startup");
  expect(db.update).not.toHaveBeenCalled();
  expect(db.set).not.toHaveBeenCalled();
});

it("readies only the cloud identity while preserving the retained full-build owner", async () => {
  const cloud = { phase: "starting" as const, commitSha: "b".repeat(40), serializerId: "cloudflare-publisher" };
  const split = { ...control, phase: "ready" as const, serializerId: "node-compute-primary", cloud };
  expect(parsePublicationRuntimeControl(split)).toEqual(split);
  const db = database(split);
  expect(await assertPublicationRuntimeIdentity(db.firestore, cloud.commitSha, cloud.serializerId)).toEqual(cloud);
  await confirmPublicationRuntimeReady(db.firestore, cloud.commitSha, cloud.serializerId);
  expect(db.update).toHaveBeenCalledExactlyOnceWith(db.ref, { "cloud.phase": "ready" });
});

it.each([
  null,
  {},
  { phase: "ready", commitSha, serializerId: "unknown" },
  { phase: "ready", commitSha, serializerId: "cloudflare-publisher", extra: true },
  { phase: "ready", commitSha: "bad", serializerId: "cloudflare-publisher" },
])("refuses malformed or unknown cloud identities %#", cloud => {
  expect(() => parsePublicationRuntimeControl({ ...control, cloud })).toThrow();
});

it("emits a version-three companion at normal publisher startup without modifying the shared capability", async () => {
  const db = database(control);
  await confirmPublicationRuntimeReady(db.firestore, commitSha, serializerId);
  expect(db.firestore.doc).toHaveBeenCalledWith(`system/publicDeployment/liveBlogContracts/${commitSha}`);
  expect(db.set).toHaveBeenCalledWith(db.ref, { schemaVersion: 1, rendererSha: commitSha, liveBlogContractVersion: 3 });
  expect(db.firestore.doc).not.toHaveBeenCalledWith("system/publicDeployment/noBuildPosts/capability");
});

// Short-pause promotion changes paused OLD pins to paused NEW, then resumes
// directly to ready. Startup must attest either exact identity without opening it.
it.each(["paused", "ready"] as const)("attests the exact %s publisher without reopening admission", async phase => {
  const db = database({ ...control, phase });
  await confirmPublicationRuntimeReady(db.firestore, commitSha, serializerId);
  expect(db.set).toHaveBeenCalledExactlyOnceWith(db.ref,
    { schemaVersion: 1, rendererSha: commitSha, liveBlogContractVersion: 3 });
  expect(db.firestore.doc).toHaveBeenCalledWith(`system/publicDeployment/liveBlogContracts/${commitSha}`);
  expect(db.update).not.toHaveBeenCalled();
  expect(db.firestore.doc).not.toHaveBeenCalledWith("system/publicDeployment/noBuildPosts/capability");
});
