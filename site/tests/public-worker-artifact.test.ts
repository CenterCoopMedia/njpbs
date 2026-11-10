import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPublicArtifactInventoryReceipt,
  createPublicArtifactInventoryReceipt,
} from "../src/lib/public-artifact-inventory";
import {
  assertPreparedPublicWorkerArtifact,
  preparePublicWorkerArtifact,
  publicPublicationReceiptMatchesPreparedArtifact,
  verifyPreparedPublicWorkerArtifact,
} from "../src/lib/public-worker-artifact";

const temporaryDirectories: string[] = [];
const COMMIT_SHA = "a".repeat(40);

function reservation() {
  const cutoffAt = {
    seconds: 1_787_856_000,
    nanoseconds: 0,
    toMillis: () => 1_787_856_000_000,
  };
  return {
    schemaVersion: 1,
    buildBatchId: "build-one",
    generation: 8,
    status: "reserved",
    commitSha: COMMIT_SHA,
    reservedAgainstGeneration: 7,
    reservedAgainstDeploymentId: "deployment-seven",
    reservedAgainstCommitSha: "b".repeat(40),
    cutoffAt,
    reservedAt: cutoffAt,
  };
}

function artifactReceipt() {
  return createPublicArtifactInventoryReceipt({
    reservation: reservation(),
    pages: [],
    posts: [],
    programs: [],
    authors: [],
    settings: [],
  });
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "njpbs-worker-artifact-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function artifactFixture(order = ["index.html", "assets/app.js"]) {
  const directory = await temporaryDirectory();
  const distDirectory = path.join(directory, "dist");
  const outputPath = path.join(directory, "prepared.json");
  await mkdir(distDirectory);
  for (const relativePath of order) {
    const target = path.join(distDirectory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `content:${relativePath}\n`, "utf8");
  }
  return { directory, distDirectory, outputPath };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("prepared public Worker artifacts", () => {
  it("writes one public identity receipt and one private preparation receipt", async () => {
    const fixture = await artifactFixture();
    const inventory = assertPublicArtifactInventoryReceipt(artifactReceipt());

    const prepared = await preparePublicWorkerArtifact({
      artifactReceipt: inventory,
      distDirectory: fixture.distDirectory,
      outputPath: fixture.outputPath,
    });
    const publicationBytes = await readFile(
      path.join(fixture.distDirectory, "_publication.json"),
      "utf8",
    );
    const publication = JSON.parse(publicationBytes);

    expect(publication).toEqual({
      schemaVersion: 1,
      digestAlgorithm: "sha256",
      buildBatchId: "build-one",
      generation: 8,
      commitSha: COMMIT_SHA,
      artifactDigest: prepared.artifactDigest,
      artifactReceiptDigest: createHash("sha256")
        .update(JSON.stringify(inventory))
        .digest("hex"),
      mediaManifestDigest: inventory.mediaManifestDigest,
    });
    expect(prepared).toEqual({
      ...publication,
      publicationReceiptDigest: createHash("sha256")
        .update(publicationBytes)
        .digest("hex"),
      artifactFileCount: 3,
      artifactBytes:
        Buffer.byteLength("content:index.html\n") +
        Buffer.byteLength("content:assets/app.js\n") +
        Buffer.byteLength(publicationBytes),
    });
    expect(JSON.parse(await readFile(fixture.outputPath, "utf8")))
      .toEqual(prepared);
  });

  it("is stable across file creation order and an exact retry", async () => {
    const firstFixture = await artifactFixture([
      "index.html",
      "assets/app.js",
    ]);
    const secondFixture = await artifactFixture([
      "assets/app.js",
      "index.html",
    ]);
    await writeFile(
      path.join(secondFixture.distDirectory, "_publication.json"),
      "stale receipt\n",
      "utf8",
    );

    const first = await preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: firstFixture.distDirectory,
      outputPath: firstFixture.outputPath,
    });
    const second = await preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: secondFixture.distDirectory,
      outputPath: secondFixture.outputPath,
    });
    const retry = await preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: firstFixture.distDirectory,
      outputPath: firstFixture.outputPath,
    });

    expect(second).toEqual(first);
    expect(retry).toEqual(first);
  });

  it("changes both bound digests when a deployed file changes", async () => {
    const fixture = await artifactFixture();
    const first = await preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: fixture.distDirectory,
      outputPath: fixture.outputPath,
    });
    await writeFile(
      path.join(fixture.distDirectory, "index.html"),
      "changed\n",
      "utf8",
    );

    const changed = await preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: fixture.distDirectory,
      outputPath: fixture.outputPath,
    });

    expect(changed.artifactDigest).not.toBe(first.artifactDigest);
    expect(changed.publicationReceiptDigest)
      .not.toBe(first.publicationReceiptDigest);
  });

  it("accepts the exact prepared artifact before upload", async () => {
    const fixture = await artifactFixture();
    const prepared = await preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: fixture.distDirectory,
      outputPath: fixture.outputPath,
    });

    await expect(verifyPreparedPublicWorkerArtifact({
      preparedArtifact: prepared,
      distDirectory: fixture.distDirectory,
    })).resolves.toEqual(prepared);
  });

  it("matches only the exact bounded public receipt", async () => {
    const fixture = await artifactFixture();
    const prepared = await preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: fixture.distDirectory,
      outputPath: fixture.outputPath,
    });
    const body = await readFile(
      path.join(fixture.distDirectory, "_publication.json"),
      "utf8",
    );

    expect(publicPublicationReceiptMatchesPreparedArtifact(body, prepared))
      .toBe(true);
    expect(publicPublicationReceiptMatchesPreparedArtifact(
      `${body}changed`,
      prepared,
    )).toBe(false);
    expect(publicPublicationReceiptMatchesPreparedArtifact(
      "x".repeat(8 * 1024 + 1),
      prepared,
    )).toBe(false);
    expect(publicPublicationReceiptMatchesPreparedArtifact(body, {
      ...prepared,
      futureField: true,
    })).toBe(false);
  });

  it("rejects a deployed file changed after preparation", async () => {
    const fixture = await artifactFixture();
    const prepared = await preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: fixture.distDirectory,
      outputPath: fixture.outputPath,
    });
    await writeFile(
      path.join(fixture.distDirectory, "index.html"),
      "changed after preparation\n",
      "utf8",
    );

    await expect(verifyPreparedPublicWorkerArtifact({
      preparedArtifact: prepared,
      distDirectory: fixture.distDirectory,
    })).rejects.toThrow(/changed after preparation/i);
  });

  it("rejects a publication receipt changed after preparation", async () => {
    const fixture = await artifactFixture();
    const prepared = await preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: fixture.distDirectory,
      outputPath: fixture.outputPath,
    });
    await writeFile(
      path.join(fixture.distDirectory, "_publication.json"),
      "changed after preparation\n",
      "utf8",
    );

    await expect(verifyPreparedPublicWorkerArtifact({
      preparedArtifact: prepared,
      distDirectory: fixture.distDirectory,
    })).rejects.toThrow(/changed after preparation/i);
  });

  it("rejects symbolic links instead of hashing their targets", async () => {
    const fixture = await artifactFixture();
    await symlink(
      path.join(fixture.distDirectory, "index.html"),
      path.join(fixture.distDirectory, "linked.html"),
    );

    await expect(preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: fixture.distDirectory,
      outputPath: fixture.outputPath,
    })).rejects.toThrow(/symbolic link/i);
  });

  it("keeps the private preparation receipt outside the deployed tree", async () => {
    const fixture = await artifactFixture();

    await expect(preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: fixture.distDirectory,
      outputPath: path.join(fixture.distDirectory, "prepared.json"),
    })).rejects.toThrow(/outside site\/dist/i);
  });

  it("fails closed on an unknown prepared receipt field", async () => {
    const fixture = await artifactFixture();
    const prepared = await preparePublicWorkerArtifact({
      artifactReceipt: artifactReceipt(),
      distDirectory: fixture.distDirectory,
      outputPath: fixture.outputPath,
    });

    expect(() => assertPreparedPublicWorkerArtifact({
      ...prepared,
      futureField: true,
    })).toThrow(/prepared public Worker artifact is invalid/i);
  });
});
