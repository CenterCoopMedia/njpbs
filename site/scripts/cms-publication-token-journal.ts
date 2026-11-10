import { randomUUID } from "node:crypto";
import { constants as fileConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_FILE_NAME = "claim-journal.json";
const MAX_JOURNAL_BYTES = 4_096;
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const BUILD_BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const CLAIM_TOKEN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ROOT_FIELDS = new Set(["schemaVersion", "serializerId", "job"]);
const JOB_FIELDS = new Set([
  "queueId",
  "buildBatchId",
  "commitSha",
  "claimToken",
  "createdAt",
]);

export interface CmsPublicationJournalJob {
  queueId: string;
  buildBatchId: string;
  commitSha: string;
  claimToken: string;
  createdAt: string;
}

interface JournalState {
  schemaVersion: 1;
  serializerId: string;
  job: CmsPublicationJournalJob | null;
}

interface JournalReservation {
  queueId: string;
  buildBatchId: string;
  commitSha: string;
}

interface JournalClearRequest {
  queueId: string;
  claimToken: string;
}

export interface CmsPublicationTokenJournal {
  journalPath: string;
  read(): Promise<CmsPublicationJournalJob | null>;
  reserve(input: JournalReservation): Promise<{
    idempotent: boolean;
    job: CmsPublicationJournalJob;
  }>;
  clear(input: JournalClearRequest): Promise<{ idempotent: boolean }>;
}

export class CmsPublicationTokenJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsPublicationTokenJournalError";
  }
}

function journalError(message: string): never {
  throw new CmsPublicationTokenJournalError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(
  value: unknown,
  fields: ReadonlySet<string>,
): value is Record<string, unknown> {
  return plainObject(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field));
}

function canonicalDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) return null;
  return value;
}

function projectJob(value: unknown): CmsPublicationJournalJob {
  if (
    !hasExactFields(value, JOB_FIELDS) ||
    !QUEUE_ID.test(String(value.queueId)) ||
    !BUILD_BATCH_ID.test(String(value.buildBatchId)) ||
    !COMMIT_SHA.test(String(value.commitSha)) ||
    !CLAIM_TOKEN.test(String(value.claimToken)) ||
    canonicalDate(value.createdAt) === null
  ) {
    journalError("The CMS publication token journal job is invalid");
  }
  return Object.freeze({
    queueId: String(value.queueId),
    buildBatchId: String(value.buildBatchId),
    commitSha: String(value.commitSha),
    claimToken: String(value.claimToken).toLowerCase(),
    createdAt: String(value.createdAt),
  });
}

function projectState(value: unknown, serializerId: string): JournalState {
  if (
    !hasExactFields(value, ROOT_FIELDS) ||
    value.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    value.serializerId !== serializerId ||
    (value.job !== null && !plainObject(value.job))
  ) {
    journalError("The CMS publication token journal is invalid");
  }
  return Object.freeze({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    serializerId,
    job: value.job === null ? null : projectJob(value.job),
  });
}

function emptyState(serializerId: string): JournalState {
  return Object.freeze({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    serializerId,
    job: null,
  });
}

function sameJobIdentity(
  job: CmsPublicationJournalJob,
  input: { queueId: string; buildBatchId: string; commitSha: string },
): boolean {
  return job.queueId === input.queueId &&
    job.buildBatchId === input.buildBatchId &&
    job.commitSha === input.commitSha;
}

function errorCode(error: unknown): string | null {
  return plainObject(error) && typeof error.code === "string"
    ? error.code
    : null;
}

function effectiveUserId(): number {
  if (typeof process.geteuid !== "function") {
    journalError("The CMS publication token journal requires a Linux user id");
  }
  return process.geteuid();
}

async function assertPrivateDirectory(stateDirectory: string): Promise<void> {
  if (!path.isAbsolute(stateDirectory) || path.parse(stateDirectory).root === stateDirectory) {
    journalError("The CMS publication token journal directory is invalid");
  }
  try {
    await mkdir(stateDirectory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const status = await lstat(stateDirectory);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== effectiveUserId() ||
    (status.mode & 0o077) !== 0
  ) {
    journalError("The CMS publication token journal directory is not private");
  }
  // Make the directory entry durable before reserve() can return a raw token.
  // Repeating this sync on reopen also repairs an interrupted first open.
  await syncDirectory(path.dirname(stateDirectory));
}

function assertPrivateJournalFile(status: Stats): void {
  if (
    !status.isFile() ||
    status.uid !== effectiveUserId() ||
    (status.mode & 0o077) !== 0 ||
    status.size < 1 ||
    status.size > MAX_JOURNAL_BYTES
  ) {
    journalError("The CMS publication token journal file is not private");
  }
}

async function syncDirectory(stateDirectory: string): Promise<void> {
  const directory = await open(stateDirectory, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeState(
  stateDirectory: string,
  journalPath: string,
  state: JournalState,
): Promise<void> {
  const temporaryPath = path.join(
    stateDirectory,
    `.${JOURNAL_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, journalPath);
    await syncDirectory(stateDirectory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true });
  }
}

async function readState(
  journalPath: string,
  serializerId: string,
): Promise<JournalState> {
  let handle;
  try {
    handle = await open(
      journalPath,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      journalError("The CMS publication token journal file is not private");
    }
    throw error;
  }
  let value: unknown;
  try {
    assertPrivateJournalFile(await handle.stat());
    value = JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof CmsPublicationTokenJournalError) throw error;
    journalError("The CMS publication token journal is unreadable");
  } finally {
    await handle.close();
  }
  return projectState(value, serializerId);
}

function validateReservation(input: JournalReservation): void {
  if (
    !QUEUE_ID.test(input.queueId ?? "") ||
    !BUILD_BATCH_ID.test(input.buildBatchId ?? "") ||
    !COMMIT_SHA.test(input.commitSha ?? "")
  ) {
    journalError("The CMS publication token reservation is invalid");
  }
}

function serializeOperations() {
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export async function openCmsPublicationTokenJournal({
  stateDirectory,
  serializerId,
}: {
  stateDirectory: string;
  serializerId: string;
}): Promise<CmsPublicationTokenJournal> {
  if (!SERIALIZER_ID.test(serializerId ?? "")) {
    journalError("The CMS publication token journal serializer id is invalid");
  }
  await assertPrivateDirectory(stateDirectory);
  const journalPath = path.join(stateDirectory, JOURNAL_FILE_NAME);
  try {
    await readState(journalPath, serializerId);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await writeState(
      stateDirectory,
      journalPath,
      emptyState(serializerId),
    );
  }
  const serialize = serializeOperations();

  return Object.freeze({
    journalPath,
    read: () => serialize(async () =>
      (await readState(journalPath, serializerId)).job),
    reserve: (input: JournalReservation) => serialize(async () => {
      validateReservation(input);
      const state = await readState(journalPath, serializerId);
      if (state.job) {
        if (!sameJobIdentity(state.job, input)) {
          journalError("The CMS publication token journal already has another job");
        }
        return { idempotent: true, job: state.job };
      }
      const job = projectJob({
        ...input,
        claimToken: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      await writeState(stateDirectory, journalPath, {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        serializerId,
        job,
      });
      return { idempotent: false, job };
    }),
    clear: ({ queueId, claimToken }: JournalClearRequest) => serialize(async () => {
      if (!QUEUE_ID.test(queueId ?? "") || !CLAIM_TOKEN.test(claimToken ?? "")) {
        journalError("The CMS publication token journal clear request is invalid");
      }
      const state = await readState(journalPath, serializerId);
      if (state.job === null) return { idempotent: true };
      if (
        state.job.queueId !== queueId ||
        state.job.claimToken !== claimToken.toLowerCase()
      ) {
        journalError("The CMS publication token journal clear request conflicts");
      }
      await writeState(
        stateDirectory,
        journalPath,
        emptyState(serializerId),
      );
      return { idempotent: false };
    }),
  });
}
