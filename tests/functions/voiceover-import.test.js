import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import {
  applyImport,
  buildImportPlan,
  inspectWaveBuffer,
  parseArguments,
  resolveRecorder,
} from "../../scripts/import-voiceover-library.mjs";

function wave(durationSeconds = 0.01) {
  const dataBytes = Math.round(durationSeconds * 96_000);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(48_000, 24);
  buffer.writeUInt32LE(96_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

async function fixture(root, mutate = (value) => value) {
  const styles = [
    { id: "soft-spoken", label: "Soft-spoken" },
    { id: "masculine", label: "Masculine" },
  ];
  const families = Array.from({ length: 25 }, (_, index) => ({
    id: `family-${String(index + 1).padStart(2, "0")}`,
    label: `Family ${index + 1}`,
  }));
  const takes = Array.from({ length: 196 }, (_, index) => {
    const style = styles[index % styles.length].id;
    const family = families[index % families.length];
    const takeNumber = Math.floor(index / families.length) + 1;
    const id = `${style}-${family.id}-${String(takeNumber).padStart(2, "0")}`;
    return {
      id,
      family_id: family.id,
      family: family.label,
      take: takeNumber,
      style,
      performer_id: "jules-avery",
      text: `Voiceover ${index + 1}.`,
      display_text: `Voiceover ${index + 1}.`,
      file: `audio/${style}/${id}.wav`,
      start: index,
      end: index + 0.01,
      duration_seconds: 0.01,
      complete: true,
      flags: [],
      insert_note: "",
    };
  });
  const manifest = mutate({
    version: 1,
    status: "review-ready",
    styles,
    families,
    performers: { "jules-avery": { name: "Jules Avery" } },
    takes,
  });
  await Promise.all(manifest.takes.map(async (take) => {
    const path = join(root, take.file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, wave());
  }));
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { manifestPath, audioRoot: root, manifest };
}

describe("voiceover import validation", () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "voiceover-import-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("validates all 196 stable takes and their original WAV bytes", async () => {
    const input = await fixture(root, (manifest) => {
      manifest.takes.at(-1).complete = false;
      manifest.takes.at(-1).flags = ["incomplete"];
      return manifest;
    });
    const plan = await buildImportPlan(input);
    expect(plan).toMatchObject({
      schemaVersion: 1,
      manifestVersion: 1,
      takeCount: 196,
    });
    expect(plan.styles).toHaveLength(2);
    expect(plan.families).toHaveLength(25);
    expect(plan.takes[0]).toMatchObject({
      order: 0,
      sizeBytes: 1_004,
      objectKey: expect.stringMatching(/^takes\/v1\/.+\.wav$/),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(plan.takes[0].audio.equals(wave())).toBe(true);
    expect(plan.takes.at(-1)).toMatchObject({
      complete: false,
      flags: ["incomplete"],
    });
  });

  it("rejects duplicate IDs, missing display text and invalid WAV formats", async () => {
    const duplicate = await fixture(root, (manifest) => {
      manifest.takes[1] = { ...manifest.takes[0] };
      return manifest;
    });
    await expect(buildImportPlan(duplicate)).rejects.toThrow(/duplicated/i);

    await rm(root, { recursive: true, force: true });
    await mkdir(root);
    const missingText = await fixture(root, (manifest) => {
      delete manifest.takes[0].display_text;
      return manifest;
    });
    await expect(buildImportPlan(missingText)).rejects.toThrow(/display_text/i);
    expect(() => inspectWaveBuffer(Buffer.from("not wave"))).toThrow(/RIFF\/WAVE/);
  });

  it("rejects an ID that does not match the take's stable identity fields", async () => {
    const input = await fixture(root, (manifest) => {
      const take = manifest.takes[0];
      take.id = `${take.id}-renamed`;
      take.file = `audio/${take.style}/${take.id}.wav`;
      return manifest;
    });
    await expect(buildImportPlan(input)).rejects.toThrow(/stable ID fields/i);
  });

  it("rejects an inherited object property as an unregistered performer", async () => {
    const input = await fixture(root, (manifest) => {
      manifest.takes[0].performer_id = "constructor";
      return manifest;
    });
    await expect(buildImportPlan(input)).rejects.toThrow(/invalid performer/i);
  });

  it("is dry-run by default and requires every identity and input argument", () => {
    expect(parseArguments([
      "--manifest", "manifest.json",
      "--audio-root", "review",
      "--recorder-email", "person@example.org",
    ])).toEqual({
      apply: false,
      project: "njpbs-site",
      manifestPath: "manifest.json",
      audioRoot: "review",
      recorderEmail: "person@example.org",
    });
    expect(parseArguments([
      "--manifest", "manifest.json",
      "--audio-root", "review",
      "--recorder-email", "person@example.org",
      "--apply",
    ]).apply).toBe(true);
    expect(() => parseArguments(["--apply"])).toThrow(/required/i);
  });
});

describe("voiceover import identity and persistence", () => {
  let db;
  let root;

  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error("Use the Firestore emulator for voiceover import tests.");
    }
    if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
    db = isolatedFirestore("voiceover-import.test.js");
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
      { method: "DELETE" }, db,
    );
    root = await mkdtemp(join(tmpdir(), "voiceover-import-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("requires the verified active recorder to hold settings.manage", async () => {
    const auth = {
      getUserByEmail: vi.fn(async (email) => ({
        uid: "jules-cms",
        email,
        emailVerified: true,
        disabled: false,
      })),
    };
    await db.doc("users/jules-cms").set({
      email: "jules@example.org",
      displayName: "Jules CMS",
      role: "super_admin",
      active: true,
    });
    await expect(resolveRecorder({
      auth,
      firestore: db,
      email: "JULES@example.org",
    })).resolves.toEqual({ uid: "jules-cms", displayName: "Jules CMS" });

    await db.doc("users/jules-cms").update({ role: "editor" });
    await expect(resolveRecorder({
      auth,
      firestore: db,
      email: "jules@example.org",
    })).rejects.toThrow(/settings manager/i);
  });

  it("resolves the recorder's staff access level after activation", async () => {
    const auth = {
      getUserByEmail: vi.fn(async (email) => ({ uid: "jules-cms", email, emailVerified: true, disabled: false })),
    };
    const recorder = { auth, firestore: db, email: "jules@example.org" };
    await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
    await db.doc("users/jules-cms").set({
      email: "jules@example.org", displayName: "Jules CMS", active: true, accessTier: "viewer", role: "super_admin",
    });
    await expect(resolveRecorder(recorder)).rejects.toThrow(/settings manager/i);
    await db.doc("users/jules-cms").set({ email: "jules@example.org", displayName: "Jules CMS", active: true, accessTier: "admin" });
    await expect(resolveRecorder(recorder)).resolves.toEqual({ uid: "jules-cms", displayName: "Jules CMS" });
  });

  it("imports once, verifies an identical rerun and rejects take replacement", async () => {
    const plan = await buildImportPlan(await fixture(root));
    const objects = new Map();
    const storage = {
      headIfExists: vi.fn(async (key) => objects.get(key) ?? null),
      putIfAbsent: vi.fn(async ({ key, body, contentHash }) => {
        if (objects.has(key)) return { created: false };
        objects.set(key, {
          contentLength: body.length,
          contentType: "audio/wav",
          metadata: { sha256: contentHash },
        });
        return { created: true };
      }),
    };
    const recorder = { uid: "jules-cms", displayName: "Jules CMS" };
    const first = await applyImport({
      firestore: db,
      storage,
      plan,
      recorder,
      importedAt: "2026-09-10T18:00:00.000Z",
    });
    expect(first).toEqual({
      objects: { created: 196, verified: 196 },
      documents: { created: 196, verified: 0 },
    });
    const stored = (await db.doc(`voiceoverTakes/${plan.takes[0].id}`).get()).data();
    expect(stored).toMatchObject({
      recordedByUid: "jules-cms",
      recordedByName: "Jules CMS",
      objectKey: plan.takes[0].objectKey,
      contentHash: plan.takes[0].contentHash,
    });
    expect(stored).not.toHaveProperty("audio");
    expect(stored).not.toHaveProperty("file");

    const rerun = await applyImport({
      firestore: db,
      storage,
      plan,
      recorder,
      importedAt: "2026-09-10T19:00:00.000Z",
    });
    expect(rerun).toEqual({
      objects: { created: 0, verified: 196 },
      documents: { created: 0, verified: 196 },
    });
    expect(storage.putIfAbsent).toHaveBeenCalledTimes(196);

    const changed = {
      ...plan,
      takes: plan.takes.map((take, index) =>
        index === 0 ? { ...take, text: "Replacement content." } : take),
    };
    await expect(applyImport({
      firestore: db,
      storage,
      plan: changed,
      recorder,
    })).rejects.toThrow(/different content or identity/i);
  });
});
