import { describe, expect, it, vi } from "vitest";
import uploader from "../../functions/lib/source-media-uploader.js";
import contract from "../../functions/lib/source-media-contract.js";

function directory(profiles = {}) {
  return {
    collection: () => ({ doc: id => ({ id }) }),
    getAll: vi.fn(async (...refs) => refs.map(({ id }) => ({
      id, exists: Object.hasOwn(profiles, id), data: () => profiles[id],
    }))),
  };
}

describe("source video uploader attribution", () => {
  it.each([false, true])("batches distinct uploader profiles once when users.view is %s", async (canViewUsers) => {
    const profiles = Object.fromEntries(Array.from({ length: 96 }, (_, i) => [
      `staff-${i}`, { displayName: `Staff member ${i}`, email: "private@example.org", grants: [{ role: "admin" }] },
    ]));
    const firestore = directory(profiles);
    const records = Array.from({ length: 97 }, (_, i) => ({ id: `video-${i}`,
      uploadedBy: { uid: `staff-${i % 96}`, name: "Uploader name unavailable" } }));
    const result = await uploader.enrichSourceMediaUploaders(firestore, records, canViewUsers);
    expect(firestore.getAll).toHaveBeenCalledOnce();
    expect(firestore.getAll.mock.calls[0]).toHaveLength(96);
    expect(result).toEqual(records.map((record, i) => ({ ...record, uploadedBy: {
      ...(canViewUsers ? { uid: `staff-${i % 96}` } : {}), name: `Staff member ${i % 96}`,
    } })));
  });

  it("does not label an import operator or an unknown identity as the uploader", async () => {
    const firestore = directory();
    const records = [{ createdBy: "system:s3-source-import" }, {}].map(contract.sourceMediaAssetSummary);
    expect(records.map(record => record.uploadedBy)).toEqual([null, null]);
    expect((await uploader.enrichSourceMediaUploaders(firestore, records, false)).map(record => record.uploadedBy)).toEqual([null, null]);
    expect(firestore.getAll).not.toHaveBeenCalled();
  });

  it("preserves the recorded uploader id if their profile is missing", async () => {
    const record = { id: "first", uploadedBy: { uid: "former-staff", name: "Uploader name unavailable" } };
    expect(await uploader.enrichSourceMediaUploaders(directory(), [record], true)).toEqual([record]);
  });

  it("withholds uploader account data unless the caller can view users", async () => {
    const firestore = directory({ "staff-1": { displayName: "  Alex Rivera  ", email: "private@example.org" } });
    const record = { id: "first", uploadedBy: { uid: "staff-1", name: "Uploader name unavailable" } };
    expect(await uploader.enrichSourceMediaUploaders(firestore, [record], false)).toEqual([{
      id: "first", uploadedBy: { name: "Alex Rivera" },
    }]);
  });

  it.each([undefined, null, "", "   ", 42])("masks a missing or invalid display name %s", async (displayName) => {
    const firestore = directory({ "staff-1": { displayName, email: "private@example.org" } });
    const asset = { id: "first", uploadedBy: { uid: "staff-1", name: "Stored private label" } };
    expect(await uploader.presentSourceMediaAsset(firestore, asset, false)).toEqual({
      id: "first", uploadedBy: { name: "Staff uploader" },
    });
  });

  it("limits the display name for both directory permission levels", async () => {
    const firestore = directory({ "staff-1": { displayName: `  ${"a".repeat(201)}  ` } });
    const asset = { uploadedBy: { uid: "staff-1", name: "Uploader name unavailable" } };
    for (const canViewUsers of [false, true]) {
      const result = await uploader.presentSourceMediaAsset(firestore, asset, canViewUsers);
      expect(result.uploadedBy.name).toBe("a".repeat(200));
      expect(Object.keys(result.uploadedBy).sort()).toEqual(canViewUsers ? ["name", "uid"] : ["name"]);
    }
  });

  it.each([false, true])("preserves asset responses on directory failure when users.view is %s", async (canViewUsers) => {
    const firestore = directory();
    firestore.getAll.mockRejectedValueOnce(new Error("Directory unavailable"));
    const asset = { id: "first", uploadedBy: { uid: "staff-1", name: "Uploader name unavailable" } };
    expect(await uploader.presentSourceMediaAsset(firestore, asset, canViewUsers)).toEqual({
      id: "first", uploadedBy: canViewUsers
        ? { uid: "staff-1", name: "Uploader name unavailable" } : { name: "Staff uploader" },
    });
  });

  it("presents a single asset summary with the same withholding rule", async () => {
    const asset = { id: "first", uploadedBy: { uid: "staff-1", name: "Uploader name unavailable" } };
    expect(await uploader.presentSourceMediaAsset(directory(), asset, false)).toEqual({
      id: "first", uploadedBy: { name: "Staff uploader" },
    });
    expect(await uploader.presentSourceMediaAsset({}, null, false)).toBeNull();
  });
});
