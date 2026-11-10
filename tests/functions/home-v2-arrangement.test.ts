import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import save from "../../functions/save.js";
import preview from "../../functions/lib/preview-snapshot.js";
import snapshot from "../../functions/lib/publish-snapshot.js";
import { blockEditorReducer, initialBlockEditorState } from "../../admin/src/lib/block-editor-state";
import { blocksForPublicPageSave } from "../../admin/src/lib/public-page-block-ownership";
import type { AdminBlock } from "../../admin/src/lib/block-factory";
import fixture from "../../site/tests/fixtures/home-composition-v1.json";

const project = process.env.GCLOUD_PROJECT || "demo-njpbs";
const host = process.env.FIRESTORE_EMULATOR_HOST;
let db: ReturnType<typeof getFirestore>;
const principal = (role: string) => () => ({ uid: "arranging-editor", email: "arranging-editor@example.test", principal: { id: "arranging-editor", grants: [{ role }] } });
async function request(role: string, blocks: AdminBlock[]) {
  const response = { code: 0, body: null as any, status(code: number) { this.code = code; return this; }, json(body: unknown) { this.body = body; return this; } };
  await save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: principal(role) })({ method: "POST", headers: {}, ip: "203.0.113.9", body: { collection: "cmsPages", id: "home", baseVersion: 7, document: { blocks } } }, response);
  return response;
}
describe("Home arrangement across the editor and exact save boundary", () => {
  beforeAll(() => {
    if (!host || !project.startsWith("demo-")) throw new Error("A demo-* Firestore emulator is required");
    db = isolatedFirestore("home-v2-arrangement.test.ts");
  });
  beforeEach(async () => {
    expect((await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" }, db)).ok).toBe(true);
    await db.collection("cmsPages").doc("home").set({ ...fixture, homeCompositionVersion: 2 });
  });
  afterAll(async () => { await Promise.all(getApps().map(deleteApp)); });

  it("an ordinary Editor saves, reopens and snapshots the chosen whole-section order and withdrawal", async () => {
    const original = structuredClone(fixture.blocks) as AdminBlock[];
    const moved = blockEditorReducer("home", initialBlockEditorState(original), { kind: "editRows", edit: { kind: "homeV2Move", id: "new-home-passport-copy", destination: { beforeId: "new-home-featured" } } });
    const hidden = blockEditorReducer("home", moved, { kind: "setVisible", id: "new-home-passport-copy", visible: false, homeSection: true });
    const blocks = blocksForPublicPageSave("home", original, hidden.blocks, 2);
    const response = await request("editor", blocks);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.mintedIds).toEqual({});
    const reopened = (await db.collection("cmsPages").doc("home").get()).data()!;
    // Spec oracle: the Passport copy/action move together before Featured and
    // keep both IDs while removed from the page. Protected shelf sources remain.
    const expected = [original[0], original[1], { ...original[3], visible: false }, { ...original[4], visible: false }, original[2], original[5], original[6]].map((block, order) => ({ ...block, order }));
    expect(reopened.blocks).toEqual(expected);
    expect(preview.createPreviewSnapshot("home", reopened).blocks).toEqual(expected);
    expect(snapshot.createPublishedSnapshot({ collection: "cmsPages", document: reopened, publishedAt: "2026-10-11T12:00:00.000Z", publishedBy: "fixture" }).blocks).toEqual(expected);
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it("an ordinary Writer cannot save arrangement", async () => {
    const response = await request("writer", structuredClone(fixture.blocks) as AdminBlock[]);
    expect(response.code).toBe(403);
    expect((await db.collection("cmsPages").doc("home").get()).data()?.blocks).toEqual(fixture.blocks);
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
  });
});
