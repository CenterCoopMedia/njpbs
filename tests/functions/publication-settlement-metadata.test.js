import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import publishBuildState from "../../functions/lib/publish-build-state.js";
import getContent from "../../functions/get-content.js";

const PROJECT = "demo-njpbs";
let app;
let db;

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) {
    throw new Error("These tests require the local Firestore emulator");
  }
  app = initializeApp({ projectId: PROJECT }, "publication-settlement-metadata");
  db = isolatedFirestore("publication-settlement-metadata.test.js");
});
beforeEach(async () => {
  const response = await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
  if (!response.ok) throw new Error("The emulator reset failed");
});
afterAll(async () => { if (app) await deleteApp(app); });

async function metadata() {
  const handler = getContent.createCmsGetContentHandler({
    firestore: db,
    requirePrincipalFn: async () => ({
      uid: "editor-one", email: "editor@example.test",
      principal: { id: "editor-one", grants: [{ role: "editor" }] },
    }),
  });
  const response = {
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  };
  await handler({ method: "POST", body: {
    collection: "cmsPosts", id: "post-one", publicationOnly: true,
  } }, response);
  expect(response.statusCode).toBe(200);
  return response.body.publication;
}

describe("publication settlement metadata", () => {
  it.each(["success", "failed", "cancelled", "superseded", "public_unconfirmed"].flatMap((status) =>
    ["publish", "withdraw"].map((operation) => ({ status, operation })),
  ))("reads durable $status after $operation settlement clears the pointer", async ({ status, operation }) => {
    const ref = db.doc("cmsPosts/post-one");
    await ref.set({ type: "post", status: "draft", version: 12,
      publiclyVisible: operation === "publish", publishBuildPending: true,
      publishBuildQueueId: "queue-one", publicSourceVersion: 8,
      published: { sourceVersion: 10 },
    });
    await db.doc("cmsPublishQueue/queue-one").set({ status: "publishing", changes: [{
      collection: "cmsPosts", id: "post-one", sourceVersion: 10,
      ...(operation === "withdraw" ? { operation } : {}),
    }] });
    expect(await publishBuildState.settleBuildQueue(db, {
      queueId: "queue-one", status, queueUpdate: { status },
    })).toBe(true);
    const stored = (await ref.get()).data();
    expect(stored.publishBuildQueueId).toBeNull();
    expect(stored.publishBuildSettlement).toEqual({ status, sourceVersion: 10, operation });
    const pending = ["failed", "cancelled", "superseded"].includes(status);
    expect(stored.publishBuildPending).toBe(pending);
    expect(await metadata()).toMatchObject({
      queueStatus: status, publicBuildQueueId: null, publicUpdatePending: pending,
      publishedSourceVersion: 10, publiclyVisible: operation === "publish",
    });
    // A new revision must not inherit the previous queue's result.
    await ref.update({ "published.sourceVersion": 11, publishBuildPending: true });
    expect((await metadata()).queueStatus).toBeNull();
  });
});
