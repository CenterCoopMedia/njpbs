"use strict";

// Resolve only recorded human uploader IDs. Import operators are not uploaders.
async function enrichSourceMediaUploaders(firestore, records, canViewUsers) {
  const uids = [...new Set(records.flatMap((record) => record.uploadedBy ? [record.uploadedBy.uid] : []))]
    .filter(uid => typeof uid === "string" && uid && !uid.includes("/"));
  const names = new Map();
  if (uids.length) {
    try {
      const snapshots = await firestore.getAll(...uids.map(uid => firestore.collection("users").doc(uid)));
      for (const snapshot of snapshots) {
        const name = snapshot.exists ? snapshot.data()?.displayName : null;
        if (typeof name === "string" && name.trim()) names.set(snapshot.id, name.trim().slice(0, 200));
      }
    } catch {
      // Optional names must not fail an upload or metadata write that already committed.
    }
  }
  return records.map((record) => ({
    ...record,
    uploadedBy: record.uploadedBy
      ? { ...(canViewUsers ? { uid: record.uploadedBy.uid } : {}),
        name: names.get(record.uploadedBy.uid) ?? (canViewUsers ? record.uploadedBy.name : "Staff uploader") }
      : null,
  }));
}

async function presentSourceMediaAsset(firestore, asset, canViewUsers) {
  if (!asset) return asset;
  const [presented] = await enrichSourceMediaUploaders(firestore, [asset], canViewUsers);
  return presented;
}

module.exports = { enrichSourceMediaUploaders, presentSourceMediaAsset };
