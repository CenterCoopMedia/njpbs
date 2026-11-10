import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import serving from "../../functions/lib/public-release-serving.js";
import content from "../../functions/public-content.js";
import { releaseSelector } from "../helpers/private-public-release-pair.js";

let app, firestore;
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use a loopback Firestore emulator");
  app = initializeApp({ projectId: "demo-layer4-selector" }, "layer4-selector"); firestore = getFirestore(app);
});
afterAll(async () => { if (app) await deleteApp(app); });
const response = () => ({ statusCode: 200, set() { return this; }, status(code) { this.statusCode = code; return this; }, json(value) { this.value = value; return this; } });
it("reads only one committed selector document, without a catalog query or cache", async () => {
  await firestore.doc("system/publicDeployment").set(releaseSelector());
  const doc = vi.spyOn(firestore, "doc");
  const value = await serving.readPublicReleaseSelector({ firestore, environment: "development", now: () => 42 });
  expect(value).toEqual({ environment: "development", selector: releaseSelector(), readStartedAt: 42 });
  expect(doc.mock.calls).toEqual([["system/publicDeployment"]]); doc.mockRestore();
});
it("keeps the private selector mode off until explicit reader adoption", async () => {
  const handler = content.createCmsGetPublicPageHandler({ firestore, log: { error() {} }, releaseReadersEnabled: false });
  const res = response(); await handler({ method: "POST", body: { mode: "release-selector-v2" } }, res);
  expect(res.statusCode).toBe(503);
});
it("routes the enabled private mode without serving a legacy projection or lease", async () => {
  await firestore.doc("system/publicDeployment").set(releaseSelector());
  const projection = vi.fn();
  const handler = content.createCmsGetPublicPageHandler({ firestore, target: { environment: "development" }, readProjectionFn: projection,
    log: { error() {} }, releaseReadersEnabled: true });
  const res = response(); await handler({ method: "POST", body: { mode: "release-selector-v2" } }, res);
  expect(res.statusCode).toBe(200); expect(res.value.selector).toEqual(releaseSelector()); expect(projection).not.toHaveBeenCalled();
  await firestore.doc("system/publicDeployment").set({ schemaVersion: 1, state: "idle" });
  const failed = response(); await handler({ method: "POST", body: { mode: "release-selector-v2" } }, failed);
  expect(failed.statusCode).toBe(503);
});
