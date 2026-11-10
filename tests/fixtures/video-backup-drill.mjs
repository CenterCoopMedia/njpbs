import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

const project = process.env.NJPBS_VIDEO_BACKUP_PROJECT;
const root = process.env.NJPBS_VIDEO_BACKUP_ROOT;
const phase = process.argv[2];
assert.match(project || "", /^demo-video-backup-[a-f0-9]{8}$/);
assert.equal(process.env.GCLOUD_PROJECT, project);
assert.equal(process.env.GOOGLE_CLOUD_PROJECT, project);
assert(root && ["backup", "recover"].includes(phase) && process.argv.length === 3);
const config = JSON.parse(await readFile(join(root, "firebase.json"), "utf8"));
if (phase === "backup") assert.equal(process.env.FIRESTORE_EMULATOR_HOST, `127.0.0.1:${config.emulators.firestore.port}`);
else assert(!process.env.FIRESTORE_EMULATOR_HOST, "Recovery must have no database route");

const { createFileBackupDestination, createFileBackupSource, createFileBackupState } = await import("../../scripts/lib/video-backup-files.mjs");
const destination = createFileBackupDestination(join(root, "backup"));
function command(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${name} failed`);
  return result.stdout;
}

if (phase === "backup") {
  const { initializeApp, deleteApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { createVideoBackupRunner } = await import("../../scripts/lib/video-backup-runner.mjs");
  const { assetFixture, sourceBucket, sourceIdentity, identityKey } = await import("./video-backup.mjs");
  const app = initializeApp({ projectId: project });
  const db = getFirestore(app);
  try {
    assert.equal((await db.listCollections()).length, 0);
    await mkdir(join(root, "source"));
    const original = join(root, "source", "synthetic.mp4");
    command("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-threads", "1",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", original]);
    const sizeBytes = (await stat(original)).size;
    const asset = assetFixture("unpublished", sizeBytes);
    await rename(original, join(root, "source", `${identityKey(sourceIdentity(asset))}.mp4`));
    const pending = assetFixture("pending");
    delete pending.rendition;
    await db.doc("mediaSourceAssets/unpublished").set(asset);
    await db.doc("mediaSourceAssets/pending").set(pending);
    await db.doc("mediaSourceAssets/other").set({ sourceId: "another-library" });
    const { inventoryRecords } = await import("../../scripts/backup-video-viewing-copies.mjs");
    assert.deepEqual(await inventoryRecords({ db, sourceBucket }).then(({ completedAt: _date, ...counts }) => counts), {
      phase: "inventory", sourceVerified: false, complete: true, scanned: 2, eligibleFiles: 1,
      eligibleBytes: sizeBytes, gapCount: 1, gapReasons: { missing_viewing_copy: 1 },
    });
    const state = createFileBackupState(join(root, "state"));
    const options = { db, sourceBucket, state, destination, pageSize: 1,
      source: createFileBackupSource(join(root, "source"), identityKey) };
    let inventory;
    do {
      // New runner instance after each page demonstrates durable cursors.
      inventory = await createVideoBackupRunner(options).inventoryStep("drill");
    } while (!inventory.complete);
    assert.equal(inventory.scanned, 2);
    assert.equal(inventory.eligibleFiles, 1);
    assert.equal(inventory.eligibleBytes, sizeBytes);
    assert.equal(inventory.gapCount, 1);
    console.log(JSON.stringify({ phase: "inventory-before-transfer", ...inventory }));
    let receipt;
    do { receipt = await createVideoBackupRunner(options).copyStep("drill"); } while (!receipt.complete);
    assert.equal(receipt.verified, 1);
    assert.equal(receipt.failed, 0);
    // Removing the source document has no backup delete path.
    await db.doc("mediaSourceAssets/unpublished").delete();
    do { receipt = await createVideoBackupRunner(options).copyStep("drill"); } while (!receipt.complete);
    assert.equal(receipt.reused, 1);
    await writeFile(join(root, "inventory-receipt.json"), JSON.stringify(inventory));
  } finally { await deleteApp(app); }
} else {
  const catalog = await readdir(join(root, "backup", "viewing-copies-v1"));
  const sidecarName = catalog.find(name => name.endsWith(".json"));
  assert(sidecarName);
  const sidecar = JSON.parse(await readFile(join(root, "backup", "viewing-copies-v1", sidecarName), "utf8"));
  const recovered = join(root, "recovered.mp4");
  await pipeline(await destination.read(`viewing-copies-v1/${sidecar.archiveId}.mp4`), createWriteStream(recovered, { mode: 0o600 }));
  const recoveredBytes = await readFile(recovered);
  assert.equal(recoveredBytes.length, sidecar.sizeBytes);
  assert.equal(createHash("sha256").update(recoveredBytes).digest("hex"), sidecar.sha256);
  const media = JSON.parse(command("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", recovered]));
  const video = media.streams.find(stream => stream.codec_type === "video");
  const audio = media.streams.find(stream => stream.codec_type === "audio");
  assert.equal(video.width, sidecar.width);
  assert.equal(video.height, sidecar.height);
  assert(Math.abs(Number(media.format.duration) - sidecar.durationSeconds) < 0.1);
  assert.equal(audio.codec_name, "aac");
  command("ffmpeg", ["-v", "error", "-xerror", "-i", recovered, "-map", "0:v", "-map", "0:a", "-f", "null", "-"]);
  await writeFile(join(root, "recovery.json"), JSON.stringify({ verifiedFiles: 1, verifiedBytes: recoveredBytes.length,
    sha256: sidecar.sha256, coverageGaps: 1, durationSeconds: Number(media.format.duration),
    width: video.width, height: video.height, audio: audio.codec_name, decodedVideoAndAudio: true,
    sourceRemoved: true, workerStateRemoved: true, firestoreStopped: true, liveR2Verified: false }));
}
