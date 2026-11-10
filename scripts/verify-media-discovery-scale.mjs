// Opt-in complete scale proof. This command refuses production and uses only synthetic data.
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import discovery from "../functions/lib/media-discovery.js";
import queryApi from "../functions/lib/media-discovery-query.js";
import mediaLibrary from "../functions/lib/media-library.js";
import listApi from "../functions/list-media.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw Error("A Firestore emulator is required");
const app = initializeApp({ projectId: "demo-njpbs" }, "media-discovery-scale");
const db = getFirestore(app);
const count = 5120;
const actor = { uid: "scale-editor", approvedActive: true,
  principal: { id: "scale-editor", grants: [{ role: "editor", sections: ["news"] }] } };
const query = mediaLibrary.parseMediaListRequest({ paging: "cursor", sort: "sizeBytes", direction: "asc" });
const started = performance.now();
try {
  const cleared = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" });
  if (!cleared.ok) throw Error("Could not clear the owned emulator");
  await db.doc(discovery.MEDIA_DISCOVERY_STATE).set({ schema: 1, state: "ready", revision: 1 });
  for (let start = 0; start < count; start += 300) {
    const batch = db.batch();
    for (let i = start; i < Math.min(start + 300, count); i++) {
      const id = `asset-${String(i).padStart(5, "0")}`;
      batch.set(db.collection("media_assets").doc(id), discovery.withMediaDiscovery(id, {
        name: `Photo ${String(i).padStart(5, "0")}`, originalName: `photo-${i}.png`,
        category: "news", categories: ["news", "events"], tags: ["scale"],
        description: "Synthetic scale fixture", altText: "A test image", license: "Fixture", credit: "Fixture",
        kind: "image", mimeType: "image/png", sizeBytes: i + 1, width: 100, height: 100,
        lifecycle: "active", version: 1, url: `https://example.invalid/${id}.png`,
        createdAt: "2026-10-03T12:00:00.000Z", updatedAt: "2026-10-03T12:00:00.000Z",
        createdBy: actor.uid, updatedBy: actor.uid, storageKey: "private-fixture-key",
      }));
    }
    await batch.commit();
  }
  console.log(JSON.stringify({ phase: "seeded", count, elapsedMs: Math.round(performance.now() - started) }));
  const ids = [];
  let cursor;
  let pages = 0;
  let terminal;
  do {
    terminal = await queryApi.readIndexedMedia(db, actor, { ...query, ...(cursor ? { cursor } : {}), page: ++pages }, { news: "News", events: "Events" }, listApi.SUMMARY_FIELDS);
    if (terminal.records.length > 30 || (terminal.nextCursor && terminal.total !== null)) throw Error("Invalid page contract");
    for (const record of terminal.records) {
      if ("storageKey" in record || "mediaDiscovery" in record) throw Error("Private fields escaped");
      ids.push(record.id);
    }
    cursor = terminal.nextCursor;
    if (pages > 200) throw Error("Continuation did not finish");
    if (pages % 25 === 0) console.log(JSON.stringify({ phase: "paging", pages, rows: ids.length }));
  } while (cursor);
  const expected = Array.from({ length: count }, (_, i) => `asset-${String(i).padStart(5, "0")}`);
  if (JSON.stringify(ids) !== JSON.stringify(expected) || terminal.total !== count || terminal.allCount !== count) throw Error("Scale sweep omitted or reordered assets");
  console.log(JSON.stringify({ complete: true, fixture: "synthetic emulator", count, pages,
    ordering: "sizeBytes ascending", idsSha256: createHash("sha256").update(JSON.stringify(ids)).digest("hex"),
    duplicates: ids.length - new Set(ids).size, missing: expected.filter(id => !ids.includes(id)).length,
    candidateReadBoundPerPage: 121, elapsedMs: Math.round(performance.now() - started),
    indexReadinessProven: false, productionLatencyProven: false }));
} finally { await db.terminate(); await deleteApp(app); }
