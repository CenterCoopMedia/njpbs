// @vitest-environment node

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
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCmsPublicationCloudStorage,
  type CloudPublicationIdentity,
} from "../scripts/cms-publication-cloud-storage";
import { publicationTarget } from "../../functions/lib/publication-target.js";

const QUEUE_ID = "11111111111111111111";
const INPUT = Buffer.from('{"frozen":true}\n');
const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const IDENTITY: CloudPublicationIdentity = {
  queueId: QUEUE_ID,
  commitSha: "a".repeat(40),
  buildBatchId: `cms-${QUEUE_ID}`,
  inputSha256: sha256(INPUT),
};
const PREFIX = `publication/${QUEUE_ID}`;
const DIRECTORIES: string[] = [];

it("keeps development checkpoints in its exact private bucket", async () => {
  const target = publicationTarget("development");
  const boundary = s3();
  const { send } = boundary;
  const storage = createCmsPublicationCloudStorage({ target, client: boundary.client });
  await storage.freezeInput(QUEUE_ID, INPUT);
  expect(send).toHaveBeenCalledTimes(2); // Conditional put followed by digest-checked readback.
  for (const [command] of send.mock.calls as unknown as [{ input: { Bucket: string } }][]) {
    expect(command.input.Bucket).toBe(target.publicationBucket);
  }
  expect(() => createCmsPublicationCloudStorage({ target: { ...target, publicationBucket: publicationTarget().publicationBucket }, client: { send } as unknown as S3Client })).toThrow("mixed publication target");
});

afterEach(async () => {
  await Promise.all(
    DIRECTORIES.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

type StoredObject = {
  bytes: Buffer;
  ContentLength: number;
  ContentType?: string;
  CacheControl?: string;
  Metadata?: Record<string, string>;
};

function s3() {
  const objects = new Map<string, StoredObject>();
  let intercept: ((command: GetObjectCommand | PutObjectCommand, options?: { abortSignal?: AbortSignal }) => void | Promise<void>) | null =
    null;
  const store = (key: string, bytes: Buffer) => {
    objects.set(key, {
      bytes: Buffer.from(bytes),
      ContentLength: bytes.length,
      ContentType: "application/octet-stream",
      CacheControl: "private, no-store, max-age=0",
      Metadata: {
        schema: "njpbs-publication-v1",
        sha256: sha256(bytes),
      },
    });
  };
  const send = vi.fn(
    async (command: GetObjectCommand | PutObjectCommand, options?: { abortSignal?: AbortSignal }) => {
      await intercept?.(command, options);
      const key = command.input.Key!;
      if (command instanceof PutObjectCommand) {
        if (command.input.IfNoneMatch === "*" && objects.has(key)) {
          throw { $metadata: { httpStatusCode: 412 } };
        }
        const bytes = Buffer.from(command.input.Body as Buffer);
        objects.set(key, {
          bytes,
          ContentLength: bytes.length,
          ContentType: command.input.ContentType,
          CacheControl: command.input.CacheControl,
          Metadata: command.input.Metadata,
        });
        return {};
      }
      const stored = objects.get(key);
      if (!stored) throw { $metadata: { httpStatusCode: 404 } };
      return {
        ...stored,
        Body: {
          transformToWebStream: () =>
            Readable.toWeb(Readable.from([stored.bytes])),
        },
      };
    },
  );
  const client = { send } as unknown as S3Client;
  return {
    client,
    objects,
    send,
    store,
    intercept(next: typeof intercept) {
      intercept = next;
    },
    storage: createCmsPublicationCloudStorage({ client }),
  };
}

async function privateDirectory(label: string) {
  const directory = await mkdtemp(
    path.join(tmpdir(), `njpbs-cloud-publication-${label}-`),
  );
  DIRECTORIES.push(directory);
  return directory;
}

async function writeArtifact(
  directory: string,
  marker: string,
  extra = false,
) {
  await mkdir(path.join(directory, "dist/assets"), {
    recursive: true,
    mode: 0o700,
  });
  const files: Record<string, string> = {
    "artifact-inventory.json": `inventory-${marker}\n`,
    "prepared-worker.json": `worker-${marker}\n`,
    "public-context.json": `context-${marker}\n`,
    "dist/index.html": `<p>${marker}</p>\n`,
    "dist/assets/app.js": `console.log(${JSON.stringify(marker)});\n`,
  };
  if (extra) files["dist/assets/second-only.js"] = "second only\n";
  await Promise.all(
    Object.entries(files).map(([relative, bytes]) =>
      writeFile(path.join(directory, relative), bytes, { mode: 0o600 }),
    ),
  );
}

async function readArtifact(directory: string) {
  return Promise.all(
    [
      "artifact-inventory.json",
      "prepared-worker.json",
      "public-context.json",
      "dist/index.html",
      "dist/assets/app.js",
    ].map(async (relative) => [
      relative,
      await readFile(path.join(directory, relative), "utf8"),
    ]),
  );
}

function storedManifest(objects: Map<string, StoredObject>) {
  return JSON.parse(
    objects.get(`${PREFIX}/manifest.json`)!.bytes.toString("utf8"),
  ) as {
    files: Array<{ path: string; byteLength: number; sha256: string }>;
  };
}

describe("CMS publication cloud storage", () => {
  it("freezes the first input and returns it on a conflicting retry", async () => {
    const cloud = s3();

    await expect(cloud.storage.readInput(QUEUE_ID)).resolves.toBeNull();
    await expect(cloud.storage.freezeInput(QUEUE_ID, INPUT)).resolves.toEqual(
      INPUT,
    );
    await expect(
      cloud.storage.freezeInput(QUEUE_ID, Buffer.from("different\n")),
    ).resolves.toEqual(INPUT);
    await expect(cloud.storage.readInput(QUEUE_ID)).resolves.toEqual(INPUT);

    const puts = cloud.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof PutObjectCommand);
    expect(puts).toHaveLength(2);
    expect(puts.every((command) => command.input.IfNoneMatch === "*")).toBe(
      true,
    );
    expect(cloud.objects.get(`${PREFIX}/input.json`)?.bytes).toEqual(INPUT);
  });

  it("restores a checkpoint after restart and rejects another source or input", async () => {
    const cloud = s3();
    const source = await privateDirectory("source");
    const restored = await privateDirectory("restored");
    await writeArtifact(source, "first");
    await cloud.storage.freezeInput(QUEUE_ID, INPUT);
    await cloud.storage.checkpointArtifact(IDENTITY, source);
    const expected = await readArtifact(source);

    const restarted = createCmsPublicationCloudStorage({ client: cloud.client });
    await expect(restarted.restoreArtifact(IDENTITY, restored)).resolves.toBe(
      true,
    );
    await expect(readArtifact(restored)).resolves.toEqual(expected);

    await expect(
      restarted.restoreArtifact(
        { ...IDENTITY, commitSha: "b".repeat(40) },
        restored,
      ),
    ).rejects.toThrow(/identity differs/i);
    await expect(
      restarted.restoreArtifact(
        { ...IDENTITY, inputSha256: sha256("another frozen input") },
        restored,
      ),
    ).rejects.toThrow(/identity differs/i);
  });

  it("does not recover an upload interrupted before the manifest", async () => {
    const cloud = s3();
    const source = await privateDirectory("interrupted-source");
    const restored = await privateDirectory("interrupted-restore");
    await writeArtifact(source, "interrupted");
    let fileUploads = 0;
    cloud.intercept((command) => {
      if (
        command instanceof PutObjectCommand &&
        command.input.Key?.startsWith(`${PREFIX}/files/`) &&
        ++fileUploads === 2
      ) {
        throw new Error("simulated interruption");
      }
    });

    await expect(
      cloud.storage.checkpointArtifact(IDENTITY, source),
    ).rejects.toThrow("simulated interruption");
    cloud.intercept(null);

    expect(cloud.objects.has(`${PREFIX}/manifest.json`)).toBe(false);
    expect(
      [...cloud.objects.keys()].some((key) => key.startsWith(`${PREFIX}/files/`)),
    ).toBe(true);
    await expect(
      cloud.storage.restoreArtifact(IDENTITY, restored),
    ).resolves.toBe(false);
  });

  it("stops a stalled restoration when the caller's deadline ends", async () => {
    const cloud = s3();
    const source = await privateDirectory("deadline-source");
    const restored = await privateDirectory("deadline-restore");
    await writeArtifact(source, "deadline");
    await cloud.storage.checkpointArtifact(IDENTITY, source);
    // Artifact file reads stall at the network boundary until their signal aborts.
    cloud.intercept((command, options) => {
      if (!(command instanceof GetObjectCommand) || !command.input.Key!.includes("/files/")) return;
      return new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason), { once: true });
      });
    });
    const startedAt = Date.now();
    await expect(
      cloud.storage.restoreArtifact(IDENTITY, restored, undefined, AbortSignal.timeout(50)),
    ).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it.each(["corrupt", "missing"] as const)(
    "refuses a %s object from a complete checkpoint",
    async (failure) => {
      const cloud = s3();
      const source = await privateDirectory(`${failure}-source`);
      const restored = await privateDirectory(`${failure}-restore`);
      await writeArtifact(source, failure);
      await cloud.storage.checkpointArtifact(IDENTITY, source);
      const file = storedManifest(cloud.objects).files[0];
      const key = `${PREFIX}/files/${file.sha256}`;

      if (failure === "missing") cloud.objects.delete(key);
      else {
        const object = cloud.objects.get(key)!;
        object.bytes = Buffer.alloc(object.bytes.length, 0x78);
      }

      await expect(
        cloud.storage.restoreArtifact(IDENTITY, restored),
      ).rejects.toThrow(/bytes differ/i);
    },
  );

  it("refuses traversal in a retained manifest and symlinks in local artifacts", async () => {
    const cloud = s3();
    const source = await privateDirectory("unsafe-source");
    const restored = await privateDirectory("unsafe-restore");
    await writeArtifact(source, "unsafe");
    await symlink(
      "../index.html",
      path.join(source, "dist/assets/linked-index.html"),
    );

    await expect(
      cloud.storage.checkpointArtifact(IDENTITY, source),
    ).rejects.toThrow(/symbolic link/i);

    await rm(path.join(source, "dist/assets/linked-index.html"));
    await cloud.storage.checkpointArtifact(IDENTITY, source);
    const manifest = storedManifest(cloud.objects);
    manifest.files[0].path = "dist/../escaped.json";
    cloud.store(
      `${PREFIX}/manifest.json`,
      Buffer.from(
        `${JSON.stringify({ schemaVersion: 1, ...IDENTITY, ...manifest })}\n`,
      ),
    );

    await expect(
      cloud.storage.restoreArtifact(IDENTITY, restored),
    ).rejects.toThrow(/artifact path/i);
  });

  it("restores the first complete artifact when a retry produces another result", async () => {
    const cloud = s3();
    const first = await privateDirectory("first-winner");
    const second = await privateDirectory("second-loser");
    await writeArtifact(first, "first");
    await writeArtifact(second, "second", true);
    await cloud.storage.freezeInput(QUEUE_ID, INPUT);
    await cloud.storage.checkpointArtifact(IDENTITY, first);
    const winnerManifest = Buffer.from(
      cloud.objects.get(`${PREFIX}/manifest.json`)!.bytes,
    );
    const expected = await readArtifact(first);

    await cloud.storage.checkpointArtifact(IDENTITY, second);

    await expect(readArtifact(second)).resolves.toEqual(expected);
    await expect(
      readFile(path.join(second, "dist/assets/second-only.js")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(cloud.objects.get(`${PREFIX}/manifest.json`)?.bytes).toEqual(
      winnerManifest,
    );
  });
});

it("restores a complete release renderer on empty disk and checks the approved manifest digest", async () => {
  const boundary = s3();
  const storage = createCmsPublicationCloudStorage({ client: boundary.client, includeRenderer: true });
  const source = await privateDirectory("release");
  const restored = await privateDirectory("release-restored");
  await writeArtifact(source, "release");
  await mkdir(path.join(source, "renderer/server"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(source, "renderer/renderer-release.json"), JSON.stringify({ schemaVersion: 1, rendererSha: IDENTITY.commitSha }));
  await writeFile(path.join(source, "renderer/server/entry.mjs"), 'export const rendererSha = "approved";');
  const digest = await storage.checkpointArtifact(IDENTITY, source);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  await expect(storage.restoreArtifact(IDENTITY, restored, "0".repeat(64))).rejects.toThrow("digest differs");
  expect(await storage.restoreArtifact(IDENTITY, restored, digest)).toBe(true);
  expect(await readFile(path.join(restored, "renderer/server/entry.mjs"), "utf8")).toContain("approved");
  const manifest = storedManifest(boundary.objects);
  const file = manifest.files.find(file => file.path === "renderer/server/entry.mjs")!;
  boundary.store(`${PREFIX}/files/${file.sha256}`, Buffer.from("changed"));
  await expect(storage.restoreArtifact(IDENTITY, restored, digest)).rejects.toThrow("bytes differ");
});

it("refuses a release checkpoint without its compiled renderer", async () => {
  const boundary = s3();
  const storage = createCmsPublicationCloudStorage({ client: boundary.client, includeRenderer: true });
  const directory = await privateDirectory("incomplete-release");
  await writeArtifact(directory, "release");
  await expect(storage.checkpointArtifact(IDENTITY, directory)).rejects.toThrow();
  expect(boundary.objects.has(`${PREFIX}/manifest.json`)).toBe(false);
});
