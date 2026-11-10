// @vitest-environment node

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CmsPublicationTokenJournalError,
  openCmsPublicationTokenJournal,
} from "../scripts/cms-publication-token-journal";

const SERIALIZER_ID = "node-compute-primary";
const QUEUE_ID = "11111111111111111111";
const BUILD_BATCH_ID = `cms-${QUEUE_ID}`;
const COMMIT_SHA = "a".repeat(40);
const temporaryDirectories: string[] = [];

async function stateDirectory(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "njpbs-token-journal-test-"));
  temporaryDirectories.push(parent);
  return path.join(parent, "state");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("CMS publication token journal", () => {
  it("creates a private empty journal", async () => {
    const directory = await stateDirectory();
    const journal = await openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: SERIALIZER_ID,
    });

    await expect(journal.read()).resolves.toBeNull();
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(journal.journalPath)).mode & 0o777).toBe(0o600);
  });

  it("opens a journal under an already durable parent directory", async () => {
    const directory = await stateDirectory();
    await mkdir(directory, { mode: 0o700 });

    const journal = await openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: SERIALIZER_ID,
    });

    await expect(journal.read()).resolves.toBeNull();
  });

  it("persists one raw token before returning it and reopens exactly", async () => {
    const directory = await stateDirectory();
    const journal = await openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: SERIALIZER_ID,
    });
    const reserved = await journal.reserve({
      queueId: QUEUE_ID,
      buildBatchId: BUILD_BATCH_ID,
      commitSha: COMMIT_SHA,
    });
    const reopened = await openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: SERIALIZER_ID,
    });

    expect(reserved.idempotent).toBe(false);
    await expect(reopened.read()).resolves.toEqual(reserved.job);
    expect(JSON.parse(await readFile(journal.journalPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      serializerId: SERIALIZER_ID,
      job: reserved.job,
    });
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp")))
      .toEqual([]);
  });

  it("returns the same token for an idempotent reservation", async () => {
    const directory = await stateDirectory();
    const journal = await openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: SERIALIZER_ID,
    });
    const input = {
      queueId: QUEUE_ID,
      buildBatchId: BUILD_BATCH_ID,
      commitSha: COMMIT_SHA,
    };

    const first = await journal.reserve(input);
    const retry = await journal.reserve(input);

    expect(retry).toEqual({ idempotent: true, job: first.job });
  });

  it("refuses to overwrite another active job", async () => {
    const directory = await stateDirectory();
    const journal = await openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: SERIALIZER_ID,
    });
    const first = await journal.reserve({
      queueId: QUEUE_ID,
      buildBatchId: BUILD_BATCH_ID,
      commitSha: COMMIT_SHA,
    });

    await expect(journal.reserve({
      queueId: "22222222222222222222",
      buildBatchId: "cms-22222222222222222222",
      commitSha: COMMIT_SHA,
    })).rejects.toThrow(/already has another job/i);
    await expect(journal.read()).resolves.toEqual(first.job);
  });

  it("clears only the exact queue and raw token", async () => {
    const directory = await stateDirectory();
    const journal = await openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: SERIALIZER_ID,
    });
    const { job } = await journal.reserve({
      queueId: QUEUE_ID,
      buildBatchId: BUILD_BATCH_ID,
      commitSha: COMMIT_SHA,
    });

    await expect(journal.clear({
      queueId: QUEUE_ID,
      claimToken: "22222222-2222-4222-8222-222222222222",
    })).rejects.toThrow(/clear request conflicts/i);
    await expect(journal.read()).resolves.toEqual(job);
    await expect(journal.clear({
      queueId: QUEUE_ID,
      claimToken: job.claimToken.toUpperCase(),
    })).resolves.toEqual({ idempotent: false });
    await expect(journal.read()).resolves.toBeNull();
    await expect(journal.clear({
      queueId: QUEUE_ID,
      claimToken: job.claimToken,
    })).resolves.toEqual({ idempotent: true });
  });

  it("refuses a journal owned by another serializer", async () => {
    const directory = await stateDirectory();
    await openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: SERIALIZER_ID,
    });

    await expect(openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: "node-offsite-fallback",
    })).rejects.toThrow(/journal is invalid/i);
  });

  it("refuses broad directory permissions and symbolic-link state", async () => {
    const directory = await stateDirectory();
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);

    await expect(openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: SERIALIZER_ID,
    })).rejects.toThrow(/directory is not private/i);

    const linkDirectory = await stateDirectory();
    const targetDirectory = await stateDirectory();
    await mkdir(targetDirectory, { mode: 0o700 });
    await symlink(targetDirectory, linkDirectory);
    await expect(openCmsPublicationTokenJournal({
      stateDirectory: linkDirectory,
      serializerId: SERIALIZER_ID,
    })).rejects.toThrow(CmsPublicationTokenJournalError);
  });

  it("refuses malformed journal bytes without replacing them", async () => {
    const directory = await stateDirectory();
    await mkdir(directory, { mode: 0o700 });
    const journalPath = path.join(directory, "claim-journal.json");
    await writeFile(journalPath, "not json\n", { mode: 0o600 });

    await expect(openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: SERIALIZER_ID,
    })).rejects.toThrow(/journal is unreadable/i);
    await expect(readFile(journalPath, "utf8")).resolves.toBe("not json\n");
  });

  it("refuses a symbolic-link journal file without reading its target", async () => {
    const directory = await stateDirectory();
    await mkdir(directory, { mode: 0o700 });
    const targetDirectory = await stateDirectory();
    await mkdir(targetDirectory, { mode: 0o700 });
    const targetPath = path.join(targetDirectory, "target.json");
    await writeFile(targetPath, "secret target\n", { mode: 0o600 });
    await symlink(targetPath, path.join(directory, "claim-journal.json"));

    await expect(openCmsPublicationTokenJournal({
      stateDirectory: directory,
      serializerId: SERIALIZER_ID,
    })).rejects.toThrow(/file is not private/i);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("secret target\n");
  });
});
