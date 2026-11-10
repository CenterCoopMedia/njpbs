import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import firebase from "../../functions/lib/firebase.js";
import datasets from "../../functions/datasets.js";
import { withCmsEdge } from "../../functions/lib/cms-edge.js";
import { datasetRelease } from "../fixtures/dataset-release.js";

const { db, admin } = firebase;
let server, origin, owner, contributor, stranger, staff;
async function account(profile) {
  const uid = `datasets-${randomUUID()}`;
  await admin.auth().createUser({ uid, email: `${uid}@example.test`, emailVerified: true });
  await db.doc(`users/${uid}`).set({ active: true, ...profile });
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=synthetic`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: await admin.auth().createCustomToken(uid), returnSecureToken: true }),
  });
  if (!response.ok) throw new Error("Synthetic emulator sign-in failed.");
  return { uid, token: (await response.json()).idToken };
}
async function call(body, actor = owner, headers = {}) {
  const response = await fetch(origin, { method: "POST", headers: { "Content-Type": "application/json", "x-njpbs-cms-edge": "synthetic-edge",
    ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}), ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
}
async function save(release = datasetRelease(), actor = owner, existing = null) {
  const response = await call({ action: "save", title: "Synthetic dataset", release, requestId: randomUUID(),
    ...(existing ? { id: existing.id, baseVersion: existing.version } : {}) }, actor);
  expect(response.status, response.body.error).toBe(200);
  return response.body.dataset;
}
async function transition(record, action, actor = owner, extra = {}) {
  return call({ action, id: record.id, baseVersion: record.version, requestId: randomUUID(), ...extra }, actor);
}
beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Use Auth and Firestore emulators.");
  [owner, contributor, stranger, staff] = await Promise.all([
    account({ role: "admin" }), account({ grants: [{ role: "contributor" }] }),
    account({ grants: [{ role: "contributor" }] }), account({ grants: [{ role: "staff" }] }),
  ]);
  const handler = withCmsEdge(datasets.createDatasetsHandler(), { readSecret: () => "synthetic-edge" });
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    req.rawBody = Buffer.concat(chunks);
    req.body = JSON.parse(req.rawBody.toString());
    res.set = (name, value) => { res.setHeader(name, value); return res; };
    res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); return res; };
    await handler(req, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}, 20_000);
afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

describe("dataset HTTP/Auth/Firestore boundary", () => {
  it("refuses anonymous, edge bypass, inactive staff and forged server fields", async () => {
    expect((await call({ action: "list" }, null)).status).toBe(401);
    expect((await call({ action: "list" }, owner, { "x-njpbs-cms-edge": "wrong" })).status).toBe(403);
    expect((await call({ action: "save", title: "Forged", release: datasetRelease(), ownerUid: owner.uid, requestId: randomUUID() })).status).toBe(400);
    const inactive = await account({ role: "super_admin", active: false });
    expect((await call({ action: "list" }, inactive)).status).toBe(403);
    expect((await call({ action: "save", title: "Bad source", release: { ...datasetRelease(), approvedBy: owner.uid }, requestId: randomUUID() })).status).toBe(400);
  });
  it("keeps saves private, enforces owner and approval permission, and retains immutable corrections", async () => {
    let record = await save(datasetRelease(), contributor);
    expect(record).toMatchObject({ ownerUid: contributor.uid, state: "draft", approvedReleaseId: null, version: 1, canApprove: false });
    const staffRead = await call({ action: "get", id: record.id }, staff);
    expect(staffRead.status).toBe(403);
    expect(staffRead.cache).toBe("private, no-store");
    expect(staffRead.body).not.toHaveProperty("dataset");
    expect((await transition(record, "review", stranger)).status).toBe(403);
    expect((await transition(record, "approve", contributor, { expectedUseCount: 0 })).status).toBe(403);
    record = (await transition(record, "review", contributor)).body.dataset;
    expect(record.state).toBe("review");
    const approved = await transition(record, "approve", owner, { expectedUseCount: 0 });
    expect(approved.status, approved.body.error).toBe(200);
    record = approved.body.dataset;
    const firstRef = db.doc(`cmsDatasets/${record.id}/releases/${record.approvedReleaseId}/revisions/1`);
    const first = (await firstRef.get()).data();
    expect(first).toMatchObject({ revision: 1, approvedBy: owner.uid, release: { value: 4.2 } });
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    const corrected = { ...datasetRelease(), value: 4.3, changeKind: "correction", changeNote: "The source revised September from 4.2% to 4.3%." };
    record = await save(corrected, contributor, record);
    expect((await firstRef.get()).data()).toEqual(first);
    record = (await transition(record, "review", contributor)).body.dataset;
    record = (await transition(record, "approve", owner, { expectedUseCount: 0 })).body.dataset;
    expect(record.approvedReleaseId).toBe(first.releaseId);
    expect((await firstRef.get()).data()).toEqual(first);
    expect((await db.doc(`cmsDatasets/${record.id}/releases/${first.releaseId}/revisions/2`).get()).data())
      .toMatchObject({ revision: 2, release: { value: 4.3, changeKind: "correction" } });
  });
  it("admits one concurrent save, replays exact requests, and reads current authority", async () => {
    const record = await save(datasetRelease(), contributor);
    const body = { action: "save", id: record.id, baseVersion: record.version, requestId: randomUUID(), title: "Changed", release: datasetRelease() };
    const results = await Promise.all([call(body, contributor), call({ ...body, requestId: randomUUID() }, contributor)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = results[0].status === 200 ? results[0] : results[1];
    if (results[0].status === 200) expect((await call(body, contributor)).body).toMatchObject({ replayed: true, dataset: { version: 2 } });
    expect(winner.body.dataset.version).toBe(2);
    await db.doc(`users/${contributor.uid}`).update({ active: false });
    expect((await call({ action: "get", id: record.id }, contributor)).status).toBe(403);
    await db.doc(`users/${contributor.uid}`).update({ active: true });
  });
  it("refuses approval and archival when a published-use index needs repair", async () => {
    let record = await save();
    record = (await transition(record, "review")).body.dataset;
    const use = db.collection("cmsDatasetUses").doc();
    await use.set({ datasetId: record.id, collection: "cmsPosts", documentId: "synthetic", blockId: "figure" });
    expect((await transition(record, "approve", owner, { expectedUseCount: 0 })).status).toBe(409);
    expect((await transition(record, "archive", owner, { expectedUseCount: 0 })).status).toBe(409);
    expect((await db.doc(`cmsDatasets/${record.id}`).get()).data().state).toBe("review");
    await use.delete();
  });
  it("validates ownership transfer and applies current owner access", async () => {
    let record = await save(datasetRelease(), contributor);
    const body = { action: "assign", id: record.id, baseVersion: record.version, ownerUid: stranger.uid, requestId: randomUUID() };
    expect((await call(body, contributor)).status).toBe(403);
    expect((await call({ action: "owners" }, contributor)).status).toBe(403);
    expect((await call({ ...body, ownerUid: staff.uid })).status).toBe(400);
    const assigned = await call(body);
    expect(assigned.status, assigned.body.error).toBe(200);
    record = assigned.body.dataset;
    expect(record.ownerUid).toBe(stranger.uid);
    expect((await transition(record, "review", contributor)).status).toBe(403);
    expect((await transition(record, "review", stranger)).status).toBe(200);
  });
  it("pages all reporting releases without losing older correction choices", async () => {
    const record = await save();
    const refs = db.collection(`cmsDatasets/${record.id}/releases`);
    const batch = db.batch();
    const ids = Array.from({ length: 101 }, (_, index) => `reporting-${String(index).padStart(3, "0")}`);
    for (const id of ids) batch.set(refs.doc(id), { label: id, releasedOn: "2026-10-20", approvedRevision: 1 });
    await batch.commit();
    const first = await call({ action: "releases", id: record.id });
    expect(first.status).toBe(200);
    expect(first.body.releases.map(release => release.id)).toEqual(ids.slice(0, 100));
    expect(first.body).toMatchObject({ hasMore: true, nextCursor: "reporting-099" });
    const second = await call({ action: "releases", id: record.id, cursor: first.body.nextCursor });
    expect(second.status).toBe(200);
    expect(second.body.releases.map(release => release.id)).toEqual(["reporting-100"]);
    expect(second.body).toMatchObject({ hasMore: false, nextCursor: null });
    expect((await call({ action: "releases", id: record.id, cursor: "bad/path" })).status).toBe(400);
  });
  it("loads an exact historical release for correction after a newer reporting release", async () => {
    let record = await save();
    record = (await transition(record, "review")).body.dataset;
    record = (await transition(record, "approve", owner, { expectedUseCount: 0 })).body.dataset;
    const september = record.approvedReleaseId;
    const next = { ...datasetRelease(), period: { start: "2026-10-01", end: "2026-10-31", label: "October 2026" }, value: 4.4 };
    record = await save(next, owner, record);
    record = (await transition(record, "review")).body.dataset;
    record = (await transition(record, "approve", owner, { expectedUseCount: 0 })).body.dataset;
    const october = record.approvedReleaseId;
    expect(october).not.toBe(september);
    const historical = await call({ action: "release", id: record.id, releaseId: september });
    expect(historical.status).toBe(200);
    expect(historical.body.release).toMatchObject({ value: 4.2, period: { label: "September 2026" } });
    const saved = await call({ action: "save", id: record.id, baseVersion: record.version, title: record.title,
      releaseId: september, requestId: randomUUID(), release: { ...historical.body.release, value: 4.3, changeKind: "correction", changeNote: "Corrected September source value." } });
    record = (await transition(saved.body.dataset, "review")).body.dataset;
    record = (await transition(record, "approve", owner, { expectedUseCount: 0 })).body.dataset;
    expect(record.approvedReleaseId).toBe(october);
    const head = (await db.doc(`cmsDatasets/${record.id}/releases/${september}`).get()).data();
    expect(head.approvedRevision).toBe(2);
  });
});
