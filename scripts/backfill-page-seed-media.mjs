import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import releaseProducer from "../functions/lib/public-release-producer.js";
import mediaContract from "../functions/lib/media-contract.js";
import mediaDiscovery from "../functions/lib/media-discovery.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SYSTEM_ACTOR = "system:page-seed-backfill";
const { mediaProjection } = mediaContract;
const { bumpMediaDiscoveryRevision, deriveMediaDiscovery, withMediaDiscovery } =
  mediaDiscovery;

export const PAGE_SEED_MEDIA = Object.freeze([
  {
    id: "launch-watch",
    name: "Watch",
    path: "brand/spotlight/watch.jpg",
    mimeType: "image/jpeg",
    width: 640,
    height: 360,
  },
  {
    id: "launch-support",
    name: "Support",
    path: "brand/spotlight/support.jpg",
    mimeType: "image/jpeg",
    width: 640,
    height: 360,
  },
  {
    id: "launch-under-the-dome",
    name: "Under the Dome",
    path: "brand/spotlight/under-the-dome.jpg",
    mimeType: "image/jpeg",
    width: 640,
    height: 360,
  },
  {
    id: "launch-about",
    name: "About",
    path: "brand/spotlight/about.jpg",
    mimeType: "image/jpeg",
    width: 640,
    height: 360,
  },
  {
    id: "launch-give",
    name: "Give",
    path: "brand/spotlight/give.jpg",
    mimeType: "image/jpeg",
    width: 640,
    height: 360,
  },
  {
    id: "launch-passport",
    name: "Passport",
    path: "brand/spotlight/passport.jpg",
    mimeType: "image/jpeg",
    width: 640,
    height: 360,
  },
  {
    id: "launch-contact",
    name: "Contact",
    path: "brand/spotlight/contact.jpg",
    mimeType: "image/jpeg",
    width: 640,
    height: 360,
  },
  {
    id: "launch-politics",
    name: "Politics",
    path: "brand/spotlight/politics.jpg",
    mimeType: "image/jpeg",
    width: 640,
    height: 360,
  },
  {
    id: "home-start-live",
    name: "Watch live",
    path: "brand/starthere/live.webp",
    mimeType: "image/webp",
    width: 800,
    height: 450,
  },
  {
    id: "home-start-ondemand",
    name: "Watch on demand",
    path: "brand/starthere/ondemand.webp",
    mimeType: "image/webp",
    width: 800,
    height: 450,
  },
  {
    id: "home-start-schedule",
    name: "TV schedule",
    path: "brand/starthere/schedule.webp",
    mimeType: "image/webp",
    width: 800,
    height: 450,
  },
  {
    id: "home-start-kids",
    name: "PBS Kids",
    path: "brand/starthere/kids.webp",
    mimeType: "image/webp",
    width: 800,
    height: 450,
  },
]);

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sameProjection(left, right, { allowLegacyEmptyAlt = false } = {}) {
  const comparableLeft =
    allowLegacyEmptyAlt && plainObject(left) && left.altText === ""
      ? { ...left, altText: null }
      : left;
  return (
    plainObject(comparableLeft) &&
    plainObject(right) &&
    isDeepStrictEqual(comparableLeft, right)
  );
}

// Reads display dimensions from a JPEG SOF segment or a WebP VP8, VP8L or VP8X header.
export function imageDimensions(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
    return null;
  }
  if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8 ") {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    }
  }
  return null;
}

function recordFor(seed, nowIso) {
  const filePath = resolve(REPO_ROOT, "site/public", seed.path);
  const bytes = readFileSync(filePath);
  const actual = imageDimensions(bytes);
  if (!actual || actual.width !== seed.width || actual.height !== seed.height) {
    throw new Error(
      `Repository asset ${seed.path} is not ${seed.width}x${seed.height}; update the seed manifest before deploying`,
    );
  }
  return withMediaDiscovery(seed.id, {
    id: seed.id,
    name: seed.name,
    originalName: basename(seed.path),
    category: "site-seed",
    tags: ["site-seed"],
    description: "Built-in NJ PBS page image.",
    altText: null,
    license: "NJ PBS site asset",
    credit: null,
    mimeType: seed.mimeType,
    kind: "image",
    sizeBytes: bytes.length,
    width: seed.width,
    height: seed.height,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    storageKey: null,
    animated: false,
    url: `https://njpbs.org/${seed.path}`,
    lifecycle: "active",
    source: "site_seed",
    version: 1,
    createdAt: nowIso,
    createdBy: SYSTEM_ACTOR,
    updatedAt: nowIso,
    updatedBy: SYSTEM_ACTOR,
  });
}

const IMMUTABLE_RECORD_FIELDS = Object.freeze([
  "id",
  "originalName",
  "category",
  "mimeType",
  "kind",
  "sizeBytes",
  "width",
  "height",
  "contentHash",
  "storageKey",
  "url",
  "source",
]);

const REFRESHABLE_RECORD_FIELDS = Object.freeze(["sizeBytes", "contentHash"]);

function validExistingShape(stored) {
  return (
    plainObject(stored) &&
    stored.lifecycle === "active" &&
    Number.isSafeInteger(stored.version) &&
    stored.version >= 1
  );
}

function immutableMismatches(stored, expected) {
  return IMMUTABLE_RECORD_FIELDS.filter((field) => stored[field] !== expected[field]);
}

function assertExistingPrivate(assetId, stored, expected) {
  if (!validExistingShape(stored) || immutableMismatches(stored, expected).length > 0) {
    throw new Error(
      `Existing private page seed media ${assetId} does not match the repository asset`,
    );
  }
}

// A repo image can be replaced in place (same path and dimensions, new bytes),
// which changes only sizeBytes and contentHash. When that is the only drift,
// the stored source is still site_seed, the record has no storage object of
// its own (storageKey is null) and the served url already points at the
// current repo file, so the stale metadata can be refreshed instead of
// failing the deploy.
function refreshableMismatches(stored, expected) {
  if (!validExistingShape(stored)) return null;
  const mismatches = immutableMismatches(stored, expected);
  if (
    mismatches.length === 0 ||
    !mismatches.every((field) => REFRESHABLE_RECORD_FIELDS.includes(field)) ||
    stored.source !== "site_seed" ||
    stored.storageKey !== null ||
    stored.url !== expected.url
  ) {
    return null;
  }
  return mismatches;
}

function auditEntry(record, nowIso) {
  return {
    actorUid: SYSTEM_ACTOR,
    actorEmail: null,
    action: "media.seed_backfill",
    target: `media_assets/${record.id}`,
    before: null,
    after: {
      source: record.source,
      contentHash: record.contentHash,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
    },
    source: "cms_staging_deploy",
    timestamp: FieldValue.serverTimestamp(),
    at: nowIso,
  };
}

function refreshAuditEntry(stored, record, nowIso) {
  return {
    actorUid: SYSTEM_ACTOR,
    actorEmail: null,
    action: "media.seed_refresh",
    target: `media_assets/${record.id}`,
    before: { contentHash: stored.contentHash, sizeBytes: stored.sizeBytes },
    after: { contentHash: record.contentHash, sizeBytes: record.sizeBytes },
    source: "cms_staging_deploy",
    timestamp: FieldValue.serverTimestamp(),
    at: nowIso,
  };
}

export async function backfillPageSeedMedia({
  firestore,
  nowIso = new Date().toISOString(),
} = {}) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  if (!Number.isFinite(Date.parse(nowIso))) {
    throw new Error("The page seed media timestamp is invalid");
  }

  const planned = PAGE_SEED_MEDIA.map((seed) => {
    const record = recordFor(seed, nowIso);
    return {
      record,
      privateRef: firestore.collection("media_assets").doc(seed.id),
      publicRef: firestore.collection("media_assets_public").doc(seed.id),
    };
  });

  return firestore.runTransaction(async (transaction) => {
    const snapshots = await Promise.all(
      planned.flatMap(({ privateRef, publicRef }) => [
        transaction.get(privateRef),
        transaction.get(publicRef),
      ]),
    );
    const missing = [];
    const classify = [];
    const refresh = [];
    let verified = 0;

    for (const [index, entry] of planned.entries()) {
      const privateSnapshot = snapshots[index * 2];
      const publicSnapshot = snapshots[index * 2 + 1];
      if (privateSnapshot.exists) {
        const stored = privateSnapshot.data();
        const refreshable = refreshableMismatches(stored, entry.record);
        if (!refreshable) assertExistingPrivate(entry.record.id, stored, entry.record);
        if (
          !publicSnapshot.exists ||
          !sameProjection(publicSnapshot.data(), mediaProjection(stored))
        ) {
          throw new Error(
            `Existing public page seed media ${entry.record.id} does not match its private record`,
          );
        }
        if (refreshable) refresh.push({ ...entry, stored });
        else if (stored.animated !== true && stored.animated !== false) {
          classify.push({ ...entry, stored });
        }
        verified += 1;
        continue;
      }
      if (
        publicSnapshot.exists &&
        !sameProjection(publicSnapshot.data(), mediaProjection(entry.record), {
          allowLegacyEmptyAlt: true,
        })
      ) {
        throw new Error(
          `Existing public page seed media ${entry.record.id} does not match the repository asset`,
        );
      }
      missing.push(entry);
    }

    const writeReleaseChange = missing.length ? await releaseProducer.preparePublicReleaseProducerInTransaction({ firestore, transaction,
      operationId: releaseProducer.publicReleaseProducerOperation("media", "page-seed", 1,
        missing.map(entry => [entry.record.id, mediaProjection(entry.record)])),
      changes: missing.map(entry => ({ kind: "media", id: entry.record.id, action: "dependency",
        sourceVersion: entry.record.version, snapshot: mediaProjection(entry.record), mediaSource: entry.record })) }) : () => {};
    writeReleaseChange();
    for (const entry of missing) {
      transaction.create(entry.privateRef, entry.record);
      transaction.set(entry.publicRef, mediaProjection(entry.record));
      transaction.create(
        firestore.collection("admin_logs").doc(),
        auditEntry(entry.record, nowIso),
      );
    }

    for (const entry of classify) {
      const patch = {
        animated: false,
        updatedAt: nowIso,
        updatedBy: SYSTEM_ACTOR,
      };
      transaction.update(entry.privateRef, {
        ...patch,
        mediaDiscovery: deriveMediaDiscovery(entry.record.id, {
          ...entry.stored,
          ...patch,
        }),
      });
    }

    for (const entry of refresh) {
      const nextVersion = entry.stored.version + 1;
      const patch = {
        sizeBytes: entry.record.sizeBytes,
        contentHash: entry.record.contentHash,
        version: nextVersion,
        ...(entry.stored.animated === true || entry.stored.animated === false
          ? {}
          : { animated: false }),
        updatedAt: nowIso,
        updatedBy: SYSTEM_ACTOR,
      };
      transaction.update(entry.privateRef, {
        ...patch,
        mediaDiscovery: deriveMediaDiscovery(entry.record.id, {
          ...entry.stored,
          ...patch,
        }),
      });
      // The public projection holds none of the refreshed fields, and it was verified above.
      transaction.create(
        firestore.collection("admin_logs").doc(),
        refreshAuditEntry(entry.stored, entry.record, nowIso),
      );
    }

    if (missing.length + classify.length + refresh.length > 0) {
      bumpMediaDiscoveryRevision(transaction, firestore);
    }

    return { created: missing.length, verified };
  });
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required");
  }
  const app = getApps()[0] || initializeApp({ projectId: "njpbs-site" });
  try {
    const result = await backfillPageSeedMedia({
      firestore: getFirestore(app),
    });
    console.log(
      `Page seed media ready: ${result.created} created, ${result.verified} verified.`,
    );
  } finally {
    await deleteApp(app);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
