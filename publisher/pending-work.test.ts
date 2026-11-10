import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPublicationWork } from "./pending-work";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "njpbs-site",
  client_email: "publisher@njpbs-site.iam.gserviceaccount.com",
  private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
});
const COMMIT_SHA = "a".repeat(40);
const SERIALIZER_ID = "cloudflare-publisher";
const QUEUE_ID = "abcdefghijklmnopqrst";
const NOW = Date.parse("2026-09-10T20:00:00.000Z");
const options = {
  account: ACCOUNT,
  commitSha: COMMIT_SHA,
  serializerId: SERIALIZER_ID,
};

afterEach(() => vi.restoreAllMocks());

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
const token = () =>
  json({ access_token: "synthetic-token", token_type: "Bearer" });
const runtime = (overrides: Record<string, unknown> = {}) =>
  json({
    fields: {
      schemaVersion: { integerValue: "1" },
      phase: { stringValue: "ready" },
      commitSha: { stringValue: COMMIT_SHA },
      serializerId: { stringValue: SERIALIZER_ID },
      ...overrides,
    },
  });
const absent = () => new Response(null, { status: 404 });
const journal = (commitSha = COMMIT_SHA) =>
  json({
    fields: {
      job: {
        mapValue: {
          fields: {
            queueId: { stringValue: QUEUE_ID },
            commitSha: { stringValue: commitSha },
          },
        },
      },
    },
  });
const queue = (triggeredAt: string) =>
  json([
    {
      document: {
        name: `projects/njpbs-site/databases/(default)/documents/cmsPublishQueue/${QUEUE_ID}`,
        fields: { triggeredAt: { timestampValue: triggeredAt } },
      },
    },
  ]);
const coordinator = (
  state: "idle" | "deploying" | "reconciling" = "idle",
  leaseAcquiredAt?: string,
) =>
  json({
    fields: {
      state: { stringValue: state },
      ...(leaseAcquiredAt
        ? { leaseAcquiredAt: { timestampValue: leaseAcquiredAt } }
        : {}),
    },
  });

function responses(...values: Response[]) {
  return vi.fn<typeof fetch>(async () => {
    const response = values.shift();
    if (!response) throw new Error("Unexpected network request in test");
    return response;
  });
}

describe("cloud publisher pending work", () => {
  it("accepts matching runtime and journal sources and reads only bounded identities", async () => {
    const request = responses(
      token(),
      runtime(),
      journal(),
      json([]),
      coordinator(),
    );

    await expect(readPublicationWork(options, request)).resolves.toEqual({
      needsRuntime: true,
      healthy: true,
    });

    const runtimeUrl = new URL(String(request.mock.calls[1][0]));
    expect(runtimeUrl.searchParams.getAll("mask.fieldPaths")).toEqual([
      "schemaVersion",
      "phase",
      "commitSha",
      "serializerId",
    ]);
    const journalUrl = new URL(String(request.mock.calls[2][0]));
    expect(
      journalUrl.pathname.endsWith(
        `/cmsPublicationSerializerJournals/${SERIALIZER_ID}`,
      ),
    ).toBe(true);
    expect(journalUrl.searchParams.getAll("mask.fieldPaths")).toEqual([
      "job.queueId",
      "job.commitSha",
    ]);
    const requested = request.mock.calls
      .map(([url, init]) => `${String(url)} ${String(init?.body ?? "")}`)
      .join("\n");
    expect(requested).not.toMatch(/claimToken|snapshot|cmsPosts/);
  });

  it("refuses a runtime control or journal owned by another source", async () => {
    const wrongControl = responses(
      token(),
      runtime({ commitSha: { stringValue: "b".repeat(40) } }),
    );
    await expect(readPublicationWork(options, wrongControl)).rejects.toThrow(
      "runtime control is invalid",
    );
    expect(wrongControl).toHaveBeenCalledTimes(2);

    const wrongJournal = responses(token(), runtime(), journal("b".repeat(40)));
    await expect(readPublicationWork(options, wrongJournal)).rejects.toThrow(
      "journal requires its original publisher",
    );
    expect(wrongJournal).toHaveBeenCalledTimes(3);
  });

  it("queries pending and publishing work and marks the oldest overdue item unhealthy", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const request = responses(
      token(),
      runtime(),
      absent(),
      queue(new Date(NOW - 16 * 60_000).toISOString()),
      coordinator(),
    );

    await expect(readPublicationWork(options, request)).resolves.toEqual({
      needsRuntime: true,
      healthy: false,
    });

    const [, queryInit] = request.mock.calls[3];
    const query = JSON.parse(String(queryInit?.body)).structuredQuery;
    expect(query.limit).toBe(1);
    expect(query.orderBy).toEqual([
      {
        field: { fieldPath: "triggeredAt" },
        direction: "ASCENDING",
      },
    ]);
    expect(
      query.where.compositeFilter.filters[0].fieldFilter.value.arrayValue
        .values,
    ).toEqual([{ stringValue: "pending" }, { stringValue: "publishing" }]);
    expect(query.where.compositeFilter.filters[1]).toEqual({
      fieldFilter: {
        field: { fieldPath: "transport" },
        op: "EQUAL",
        value: { stringValue: "serializer" },
      },
    });
  });

  it.each(["deploying", "reconciling"] as const)(
    "requires runtime recovery while the coordinator is %s",
    async (state) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const current = responses(
        token(),
        runtime(),
        absent(),
        json([]),
        coordinator(state, new Date(NOW - 60_000).toISOString()),
      );
      await expect(readPublicationWork(options, current)).resolves.toEqual({
        needsRuntime: true,
        healthy: true,
      });

      const stuck = responses(
        token(),
        runtime(),
        absent(),
        json([]),
        coordinator(state, new Date(NOW - 16 * 60_000).toISOString()),
      );
      await expect(readPublicationWork(options, stuck)).resolves.toEqual({
        needsRuntime: true,
        healthy: false,
      });
    },
  );

  it("keeps an idle ready publisher healthy without requesting runtime work", async () => {
    const request = responses(
      token(),
      runtime(),
      absent(),
      json([]),
      coordinator(),
    );

    await expect(readPublicationWork(options, request)).resolves.toEqual({
      needsRuntime: false,
      healthy: true,
    });
  });
});

import { readNoBuildPublicationWork, readPublicationOwners } from "./pending-work";
import { documents, runtime as cloudRuntime, taskPath, preparationPath, digest } from "../tests/no-build-cloud-contract";
import { publicationTarget } from "../functions/lib/publication-target.js";
import cloudWork from "../functions/lib/no-build-cloud-work.js";

function firestoreFields(input: Record<string, any>): Record<string, unknown> {
  const encode = (value: any): unknown => {
    if (value === null) return { nullValue: null };
    if (typeof value === "string") return { stringValue: value };
    if (typeof value === "boolean") return { booleanValue: value };
    if (typeof value === "number") return { integerValue: String(value) };
    if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
    return { mapValue: { fields: firestoreFields(value) } };
  };
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, encode(value)]));
}

describe("failed aggregate retry projection contract (#4616)", () => {
  const operationId = "D".repeat(20);
  const retryTaskPath = `cmsPublishQueue/${operationId}/backgroundOutputs/listings`;
  const aggregatePreparation = `cmsPublishQueue/${operationId}/backgroundPreparation/${digest}`;

  function fixture() {
    const docs = documents();
    delete docs["system/publicDeployment/noBuildPosts/current"];
    docs["system/cmsPublicationRuntime"] = { schemaVersion: 1, phase: "ready", commitSha: COMMIT_SHA, serializerId: SERIALIZER_ID };
    docs["system/noBuildPostAdmission"].backgroundBucket = "njpbs-public-artifacts";
    Object.assign(docs["system/publicDeployment/aggregateContexts/current"], {
      finalNamespaceOwner: true, namespaceOperationId: operationId, preparationOperationId: operationId,
    });
    docs[`cmsPublishQueue/${operationId}`].status = "failed";
    docs[aggregatePreparation] = { schemaVersion: 1, runtime: cloudRuntime, contextDigest: digest, status: "verified", attempts: 1 };
    for (const output of ["listings", "authors", "feed", "contentApi", "sitemap", "search"]) {
      docs[`cmsBackgroundOutputs/${output}`] = { schemaVersion: 1, runtime: cloudRuntime, contextOnly: true,
        contextDigest: digest, status: "verified", receipt: { rendererSha: COMMIT_SHA },
        taskPath: `cmsPublishQueue/${operationId}/backgroundOutputs/${output}` };
    }
    docs["cmsBackgroundOutputs/listings"].status = "failed";
    // The exhausted task shape written by post-background-outputs after #4596:
    // four attempts, no normal retry, and one transient retry ten minutes later.
    docs[retryTaskPath] = { schemaVersion: 1, owner: "post-background-v1", output: "listings", revision: 1,
      runtime: cloudRuntime, contextOnly: true, postId: null, contextDigest: digest,
      status: "failed", attempts: 4, claim: null, nextAttemptAt: null, slowRetryAt: NOW,
      lastAttempt: { attempt: 4, startedAt: NOW - 630_000, durationMs: 30_000, budgetMs: 90_000,
        failureClass: "timeout", retryable: true }, error: "background_generation_failed", receipt: null };
    const taskMasks: string[][] = [];
    const request = (async (url: string) => {
      if (url === "https://oauth2.googleapis.com/token") return token();
      const parsed = new URL(url);
      if (parsed.pathname.endsWith(":runQuery")) return json([]);
      const name = parsed.pathname.split("/documents/")[1];
      if (name === "system/publicDeployment/noBuildPostOwners") return json({});
      if (!docs[name]) return absent();
      // Honor the actual REST mask, including nested map fields. Returning the
      // complete fixture here would conceal the Worker/Node contract mismatch.
      const mask = parsed.searchParams.getAll("mask.fieldPaths");
      if (name === retryTaskPath) taskMasks.push(mask);
      const encoded = firestoreFields(docs[name]);
      const projected: Record<string, any> = {};
      for (const path of mask) {
        const parts = path.split(".");
        let source: any = encoded, destination = projected;
        for (const [index, part] of parts.entries()) {
          if (!Object.hasOwn(source, part)) break;
          if (index === parts.length - 1) destination[part] = source[part];
          else {
            if (!source[part].mapValue) break;
            source = source[part].mapValue.fields;
            destination = (destination[part] ??= { mapValue: { fields: {} } }).mapValue.fields;
          }
        }
      }
      return json({ fields: projected });
    }) as typeof fetch;
    return { docs, request, taskMasks };
  }

  async function check(docs: ReturnType<typeof documents>, request: typeof fetch, expected: boolean) {
    const node = await cloudWork.readNoBuildCloudWork({ runtime: cloudRuntime, now: Date.now(), read: async path => docs[path] ?? null });
    expect(node.maintenance || node.reconcile).toBe(expected);
    expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(expected);
  }

  it.each([
    ["timeout", true], ["storage_readback", true], ["lease_lost", true],
    ["validation", false], ["context_changed", false],
  ])("matches Node for a due %s failure and projects only bounded retry fields", async (failureClass, expected) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { docs, request, taskMasks } = fixture();
    docs[retryTaskPath].lastAttempt.failureClass = failureClass;
    await check(docs, request, expected);
    expect(taskMasks).toHaveLength(1);
    expect(taskMasks[0].filter(path => /^(claim|slowRetryAt|lastAttempt)(\.|$)/.test(path))).toEqual([
      "claim", "slowRetryAt", "lastAttempt.retryable", "lastAttempt.failureClass",
    ]);
    for (const field of ["lastAttempt", "lastAttempt.durationMs", "error", "snapshot", "previewContext.claim"]) {
      expect(taskMasks[0]).not.toContain(field);
    }
  });

  it("waits for the ten-minute retry deadline, then wakes on the next minute", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW - 60_000);
    const { docs, request } = fixture();
    await check(docs, request, false);
    clock.mockReturnValue(NOW);
    await check(docs, request, true);
  });

  it.each([
    ["nonretryable", { lastAttempt: { failureClass: "timeout", retryable: false } }, false],
    ["missing retry evidence", { lastAttempt: null }, false],
    ["later slow retry", { slowRetryAt: NOW + 1 }, false],
    ["expired final claim", { claim: "00000000-0000-4000-8000-000000000001", nextAttemptAt: NOW, slowRetryAt: null }, true],
    ["live final claim", { claim: "00000000-0000-4000-8000-000000000001", nextAttemptAt: NOW + 1, slowRetryAt: null }, false],
    ["unclaimed exhaustion", { nextAttemptAt: NOW, slowRetryAt: null }, false],
    ["superseded", { status: "superseded" }, false],
    ["other owner", { runtime: { ...cloudRuntime, owner: "node-compute" } }, false],
    ["other release", { runtime: { ...cloudRuntime, release: "b".repeat(40) } }, false],
  ])("preserves the %s task guard", async (_name, overrides, expected) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { docs, request } = fixture();
    Object.assign(docs[retryTaskPath], overrides);
    await check(docs, request, expected);
  });

  it.each([
    ["billing stop", "system/billing", { disabled: true }, false],
    ["paused accepted work", "system/cmsPublicationRuntime", { phase: "paused" }, true],
    ["exhausted preparation", aggregatePreparation, { status: "failed", attempts: 4, nextAttemptAt: null }, false],
    ["preparation backoff", aggregatePreparation, { status: "failed", attempts: 1, nextAttemptAt: NOW + 1 }, false],
    ["other active release", "system/publicDeployment", { activeCommitSha: "b".repeat(40) }, false],
    ["other lease owner", "system/publicDeployment", { state: "deploying", runtime: { ...cloudRuntime, owner: "node-compute" } }, false],
  ])("preserves the %s control guard", async (_name, path, overrides, expected) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { docs, request } = fixture();
    docs[path] = { ...docs[path], ...overrides };
    await check(docs, request, expected);
  });
});

it("queries only due cloud releases and wakes an unmarked cloud namespace handoff", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const docs = documents();
  docs["system/noBuildPostAdmission"].backgroundBucket = "njpbs-public-artifacts";
  docs[taskPath].nextAttemptAt = Date.now() + 60_000;
  docs["system/cmsPublicationRuntime"] = { schemaVersion: 1, phase: "ready", commitSha: COMMIT_SHA, serializerId: SERIALIZER_ID };
  const queries: unknown[] = [];
  const reads: string[] = [];
  const request = (async (url: string, init?: RequestInit) => {
    if (url === "https://oauth2.googleapis.com/token") return token();
    const parsed = new URL(url);
    if (parsed.pathname.endsWith(":runQuery")) { queries.push(JSON.parse(String(init?.body))); return json([]); }
    const name = parsed.pathname.split("/documents/")[1];
    if (name === "system/publicDeployment/noBuildPostOwners") { reads.push(name); return json({}); }
    if (name === "cmsBackgroundOutputs/listings") {
      expect(parsed.searchParams.getAll("mask.fieldPaths")).toContain("receipt.rendererSha");
    }
    if (name === `cmsPublishQueue/${docs["system/publicDeployment/noBuildPosts/current"].operationId}`) {
      expect(parsed.searchParams.getAll("mask.fieldPaths")).toContain("homeFullBuild.status");
    }
    reads.push(name);
    return docs[name] ? json({ fields: firestoreFields(docs[name]) }) : absent();
  }) as typeof fetch;
  expect(await readNoBuildPublicationWork(options, request)).toEqual({ needsRuntime: true, healthy: true,
    diagnostics: { reasons: [], oldestDueAt: 900 } });
  // Hold the fresh handoff while the remaining assertions exercise already
  // accepted legacy Post work. Pause must not hide those original wake hints.
  docs["system/cmsPublicationRuntime"].phase = "paused";
  // Work selection and health share one completed enumeration in this pass.
  expect(reads.filter(path => path === "system/publicDeployment/noBuildPostOwners")).toHaveLength(1);
  expect(queries).toEqual([expect.objectContaining({ structuredQuery: expect.objectContaining({
    from: [{ collectionId: "releases" }], limit: 1,
  }) })]);
  expect(JSON.stringify(queries)).toContain('"runtime.owner"');
  expect(JSON.stringify(queries)).toContain('"nextAttemptAt"');
  docs[taskPath].nextAttemptAt = Date.now() - 1;
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(true);
  docs["cmsBackgroundOutputs/listings"].status = "verified";
  docs["cmsBackgroundOutputs/listings"].receipt = { rendererSha: "b".repeat(40) };
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(true);
  docs["cmsBackgroundOutputs/listings"].receipt = { rendererSha: COMMIT_SHA };
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(false);

  docs["system/publicDeployment/noBuildPosts/current"].visible = false;
  const originalQueue = docs[`cmsPublishQueue/${docs["system/publicDeployment/noBuildPosts/current"].operationId}`];
  originalQueue.homeFullBuild = { schemaVersion: 1, status: "reserved" };
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(true);
  originalQueue.homeFullBuild.status = "queued";
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(false);

  docs["cmsBackgroundOutputs/listings"].status = "failed";
  docs[preparationPath] = { runtime: cloudRuntime, status: "failed", attempts: 4, nextAttemptAt: null };
  expect(await readNoBuildPublicationWork(options, request)).toEqual({ needsRuntime: false, healthy: false,
    diagnostics: { reasons: ["preparation_exhausted", "runtime_not_ready"], oldestDueAt: 900 } });
  delete docs[preparationPath];
  docs["cmsBackgroundOutputs/listings"].status = "verified";
  docs["system/publicDeployment/noBuildPosts/current"].visible = false;
  originalQueue.homeFullBuild = { schemaVersion: 1, status: "reserved" };
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(true);
  const admissionBefore = docs["system/noBuildPostAdmission"];
  docs["system/noBuildPostAdmission"] = { ...admissionBefore, schemaVersion: 99 };
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(true);
  docs["system/noBuildPostAdmission"] = admissionBefore;
  originalQueue.homeFullBuild.status = "queued";
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(false);
  docs["system/publicDeployment"] = { state: "deploying", leaseAcquiredAt: 900, runtime: { ...cloudRuntime, owner: "node-compute" } };

  queries.length = 0;
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(false);
  expect(queries).toEqual([]);
  expect(reads.some(path => path.startsWith("cmsPosts/"))).toBe(false);
});

describe("masked cloud Post owner enumeration", () => {
  const documentsUrl = "https://firestore.googleapis.com/v1/projects/njpbs-site-dev/databases/(default)/documents";
  const owner = (postId: string) => ({
    name: `projects/njpbs-site-dev/databases/(default)/documents/system/publicDeployment/noBuildPostOwners/${postId}`,
    fields: firestoreFields({ schemaVersion: 1, postId, runtime: cloudRuntime, servingEnabled: true,
      generation: 2, ownedSlugs: [postId, `${postId}-old`], sourceVersion: 1, slug: postId,
      rendererSha: COMMIT_SHA, operationId: "C".repeat(20), visible: true, mode: "dynamic" }),
  });

  it("follows later pages and returns decoded raw owner records in the same target", async () => {
    const request = responses(json({ documents: [owner("first")], nextPageToken: "next+/=" }),
      json({ documents: [owner("second")] }));
    const result = await readPublicationOwners(documentsUrl, {}, request);
    expect(result.map(record => record.postId)).toEqual(["first", "second"]);
    expect(result[1]).toMatchObject({ ownedSlugs: ["second", "second-old"], runtime: cloudRuntime,
      schemaVersion: 1, servingEnabled: true, generation: 2, sourceVersion: 1 });
    const urls = request.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[1].searchParams.get("pageToken")).toBe("next+/=");
    expect(urls.every(url => url.pathname.includes("/projects/njpbs-site-dev/"))).toBe(true);
    const expectedMask = ["schemaVersion", "servingEnabled", "generation", "ownedSlugs", "sourceVersion",
      "slug", "rendererSha", "postId", "operationId", "visible", "mode", "runtime"];
    for (const url of urls) expect(url.searchParams.getAll("mask.fieldPaths")).toEqual(expectedMask);
    expect(String(request.mock.calls)).not.toMatch(/claimToken|snapshot|cmsPosts/);
  });

  it("accepts an empty collection without manufacturing an owner", async () => {
    expect(await readPublicationOwners(documentsUrl, {}, responses(json({})))).toEqual([]);
  });

  it.each([
    [{ documents: "not-an-array" }],
    [{ documents: [owner("first")], nextPageToken: 123 }],
    [{ documents: [owner("first")], nextPageToken: "repeat" }, { nextPageToken: "repeat" }],
    [{ documents: [owner("first")], nextPageToken: "next" }, { documents: [owner("first")] }],
    [{ documents: [{ ...owner("first"), name: owner("first").name.replace("njpbs-site-dev", "njpbs-site") }] }],
    [{ documents: [{ ...owner("first"), fields: firestoreFields({ postId: "different" }) }] }],
  ])("refuses malformed, repeated and mixed-target owner pages", async (...pages) => {
    await expect(readPublicationOwners(documentsUrl, {}, responses(...pages.map(json)))).rejects.toThrow();
  });

  it("refuses a later read failure instead of returning a partial owner list", async () => {
    const request = responses(json({ documents: [owner("first")], nextPageToken: "next" }),
      new Response(null, { status: 403 }));
    await expect(readPublicationOwners(documentsUrl, {}, request)).rejects.toThrow("work check failed");
  });

  it("refuses an unfinished collection when its page bound is reached", async () => {
    let page = 0;
    const request = vi.fn<typeof fetch>(async () => json({ nextPageToken: `page-${++page}` }));
    await expect(readPublicationOwners(documentsUrl, {}, request)).rejects.toThrow("page limit");
    expect(request).toHaveBeenCalledTimes(100);
  });
});

it("reports observer failure while still waking an already-due cloud release", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const docs: Record<string, any> = {
    "system/cmsPublicationRuntime": { schemaVersion: 1, phase: "ready", commitSha: COMMIT_SHA, serializerId: SERIALIZER_ID },
    "system/publicDeployment": { state: "idle" },
  };
  const request = (async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return token();
    if (url.includes(":runQuery")) return json([{ document: { name: "due-cloud-release" } }]);
    const name = new URL(url).pathname.split("/documents/")[1];
    if (name === "system/publicDeployment/noBuildPostOwners") return json({});
    return docs[name] ? json({ fields: firestoreFields(docs[name]) }) : absent();
  }) as typeof fetch;
  expect(await readNoBuildPublicationWork(options, request)).toEqual({ needsRuntime: true, healthy: false,
    diagnostics: { reasons: ["state_unreadable"], oldestDueAt: null } });
});

it("preserves an independently due release wake when owner pagination cannot complete", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const docs = documents();
  docs["system/cmsPublicationRuntime"] = { schemaVersion: 1, phase: "ready", commitSha: COMMIT_SHA, serializerId: SERIALIZER_ID };
  docs["system/noBuildPostAdmission"].backgroundBucket = "njpbs-public-artifacts";
  const request = (async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return token();
    if (url.includes(":runQuery")) return json([{ document: { name: "due-cloud-release" } }]);
    const name = new URL(url).pathname.split("/documents/")[1];
    if (name === "system/publicDeployment/noBuildPostOwners") return new Response(null, { status: 403 });
    return docs[name] ? json({ fields: firestoreFields(docs[name]) }) : absent();
  }) as typeof fetch;
  expect(await readNoBuildPublicationWork(options, request)).toEqual({ needsRuntime: true, healthy: false,
    diagnostics: { reasons: ["state_unreadable"], oldestDueAt: null } });
});

it.each(["pending", "failed"])("wakes the fourth retained %s release once after its bounded lease expires", async status => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const docs: Record<string, any> = {
    "system/cmsPublicationRuntime": { schemaVersion: 1, phase: "ready", commitSha: COMMIT_SHA, serializerId: SERIALIZER_ID },
    "system/publicDeployment": { state: "idle" },
    "system/publicDeployment/contexts/public": { schemaVersion: 1, revision: 1 },
    [`cmsPublicationSerializerJournals/${SERIALIZER_ID}`]: { runtime: cloudRuntime, job: { queueId: QUEUE_ID, commitSha: COMMIT_SHA } },
    [`system/publicDeployment/buildBatches/cms-${QUEUE_ID}`]: { status: "reserved" },
    [`cmsPublicationSerializerJournals/${SERIALIZER_ID}/releases/${QUEUE_ID}`]: { runtime: cloudRuntime, status, attempts: 4, nextAttemptAt: 1001 },
  };
  const request = (async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return token();
    const name = new URL(url).pathname.split("/documents/")[1];
    if (name === "system/publicDeployment/noBuildPostOwners") return json({});
    return docs[name] ? json({ fields: firestoreFields(docs[name]) }) : absent();
  }) as typeof fetch;
  expect(await readNoBuildPublicationWork(options, request)).toMatchObject({ needsRuntime: false, healthy: true });
  vi.spyOn(Date, "now").mockReturnValue(1001);
  expect(await readNoBuildPublicationWork(options, request)).toEqual({ needsRuntime: true, healthy: false,
    diagnostics: { reasons: ["release_exhausted"], oldestDueAt: null } });
  const path = `cmsPublicationSerializerJournals/${SERIALIZER_ID}/releases/${QUEUE_ID}`;
  docs[path] = { ...docs[path], status: "failed", nextAttemptAt: null };
  expect(await readNoBuildPublicationWork(options, request)).toEqual({ needsRuntime: false, healthy: false,
    diagnostics: { reasons: ["release_exhausted"], oldestDueAt: null } });
  const valid = { ...docs[path], attempts: 1, nextAttemptAt: 1002 };
  for (const invalid of [null, { ...valid, attempts: "1" }, { runtime: cloudRuntime, status: "failed", attempts: 1 },
    { ...valid, nextAttemptAt: null }, { ...valid, runtime: { owner: "node-compute", release: COMMIT_SHA } }]) {
    docs[path] = invalid;
    const result = await readNoBuildPublicationWork(options, request);
    expect(result.healthy).toBe(false);
    expect(result.diagnostics.reasons).toContain("state_unreadable");
  }
});

it("reads the isolated dev owner and refuses mixed credentials, buckets and serializers", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const target = publicationTarget("development");
  const docs = documents();
  docs["system/noBuildPostAdmission"].backgroundBucket = target.backgroundBucket;
  docs["system/cmsPublicationRuntime"] = { schemaVersion: 1, phase: "ready", commitSha: "b".repeat(40), serializerId: "node-compute-primary",
    cloud: { phase: "ready", commitSha: COMMIT_SHA, serializerId: target.serializerId } };
  const devAccount = JSON.stringify({ ...JSON.parse(ACCOUNT), project_id: target.projectId });
  const devOptions = { ...options, account: devAccount, target, serializerId: target.serializerId };
  const request = vi.fn(async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return token();
    expect(url).toContain(`/projects/${target.projectId}/`);
    if (url.includes(":runQuery")) return json([]);
    const name = new URL(url).pathname.split("/documents/")[1];
    if (name === "system/publicDeployment/noBuildPostOwners") return json({});
    return docs[name] ? json({ fields: firestoreFields(docs[name]) }) : absent();
  }) as unknown as typeof fetch;
  expect(await readNoBuildPublicationWork(devOptions, request)).toMatchObject({ needsRuntime: true, healthy: true });
  await expect(readNoBuildPublicationWork({ ...devOptions, account: ACCOUNT }, request)).rejects.toThrow("credential is invalid");
  await expect(readNoBuildPublicationWork({ ...devOptions, serializerId: SERIALIZER_ID }, request)).rejects.toThrow("mixed publication serializer");
  docs["system/noBuildPostAdmission"].backgroundBucket = publicationTarget().backgroundBucket;
  await expect(readNoBuildPublicationWork(devOptions, request)).rejects.toThrow("mixed publication background bucket");
});


it("uses masked preview progress for wake and refuses a malformed verified marker", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const docs = documents();
  docs["system/publicDeployment/aggregateContexts/current"].finalNamespaceOwner = true;
  docs["system/publicDeployment/aggregateContexts/current"].namespaceOperationId = "D".repeat(20);
  delete docs["system/publicDeployment/noBuildPosts/current"];
  delete docs["cmsBackgroundOutputs/listings"];
  docs["system/cmsPublicationRuntime"] = { schemaVersion: 1, phase: "ready", commitSha: COMMIT_SHA, serializerId: SERIALIZER_ID };
  docs["system/noBuildPostAdmission"].backgroundBucket = "njpbs-public-artifacts";
  const path = `cmsPublishQueue/${"D".repeat(20)}`;
  delete docs[path].previewContext;
  const request = vi.fn(async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return token();
    if (url.includes(":runQuery")) return json([]);
    const name = new URL(url).pathname.split("/documents/")[1];
    if (name === "system/publicDeployment/noBuildPostOwners") return json({});
    return docs[name] ? json({ fields: firestoreFields(docs[name]) }) : absent();
  }) as unknown as typeof fetch;
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(true);
  const masks = new URL(String(request.mock.calls.find(([url]) => String(url).includes(`/${path}?`))![0])).searchParams.getAll("mask.fieldPaths");
  expect(masks).toContain("previewContext.status"); expect(masks).toContain("previewContext.publicationGeneration");
  expect(masks).toContain("updatedAt");
  expect(masks).not.toContain("previewContext.claim");
  docs[path].previewContext = { status: "building", contextDigest: digest, publicationGeneration: 1,
    manifestId: "b".repeat(64), publicationArtifactReceiptDigest: "c".repeat(64),
    attempts: 1, startedAt: 900, nextAttemptAt: 1000 };
  const expiredClaim = await readNoBuildPublicationWork(options, request);
  expect(expiredClaim.needsRuntime).toBe(true); expect(expiredClaim.healthy).toBe(true);
  docs[path].previewContext.nextAttemptAt = 1100;
  const liveClaim = await readNoBuildPublicationWork(options, request);
  expect(liveClaim.needsRuntime).toBe(false); expect(liveClaim.healthy).toBe(true);
  docs[path].previewContext = { status: "verified", contextDigest: digest, publicationGeneration: 1,
    manifestId: "bad", publicationArtifactReceiptDigest: "c".repeat(64) };
  const malformed = await readNoBuildPublicationWork(options, request);
  expect(malformed.healthy).toBe(false); expect(malformed.diagnostics.reasons).toContain("state_unreadable");
});

it.each([["ready", "missing"], ["paused", "missing"], ["ready", "malformed"], ["paused", "malformed"]])(
  "wakes accepted public Post work under %s runtime with %s private retention", async (phase, previewState) => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const docs = documents();
  docs["system/cmsPublicationRuntime"] = { schemaVersion: 1, phase, commitSha: COMMIT_SHA, serializerId: SERIALIZER_ID };
  docs["system/noBuildPostAdmission"].backgroundBucket = "njpbs-public-artifacts";
  if (previewState === "missing") delete docs[`cmsPublishQueue/${"D".repeat(20)}`].previewContext;
  else docs[`cmsPublishQueue/${"D".repeat(20)}`].previewContext.manifestId = "bad";
  docs["system/publicDeployment/noBuildPosts/current"].visible = false;
  docs[`cmsPublishQueue/${"A".repeat(20)}`].homeFullBuild = { status: "reserved" };
  const request = vi.fn(async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return token();
    if (url.includes(":runQuery")) return json([]);
    const name = new URL(url).pathname.split("/documents/")[1];
    if (name === "system/publicDeployment/noBuildPostOwners") return json({});
    return docs[name] ? json({ fields: firestoreFields(docs[name]) }) : absent();
  }) as unknown as typeof fetch;
  const result = await readNoBuildPublicationWork(options, request);
  expect(result.needsRuntime).toBe(true);
  if (phase === "paused") expect(result.diagnostics.reasons).toContain("runtime_not_ready");
  if (previewState === "malformed") {
    expect(result.healthy).toBe(false); expect(result.diagnostics.reasons).toContain("state_unreadable");
  }
});

it("refuses retired legacy history in a cloud journal instead of waking or settling it", async () => {
  const docs: Record<string, any> = {
    "system/cmsPublicationRuntime": { schemaVersion: 1, phase: "ready", commitSha: COMMIT_SHA, serializerId: SERIALIZER_ID },
    [`cmsPublicationSerializerJournals/${SERIALIZER_ID}`]: { runtime: cloudRuntime, job: { queueId: QUEUE_ID, commitSha: COMMIT_SHA } },
    [`system/publicDeployment/buildBatches/cms-${QUEUE_ID}`]: { status: "retired" },
  };
  const request = (async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return token();
    const name = new URL(url).pathname.split("/documents/")[1];
    return docs[name] ? json({ fields: firestoreFields(docs[name]) }) : absent();
  }) as typeof fetch;
  await expect(readNoBuildPublicationWork(options, request)).rejects.toThrow(/retired legacy reservation/);
});

it("does not request compute or enumerate work while billing is disabled, then resumes", async () => {
  const docs = documents();
  docs["system/cmsPublicationRuntime"] = { schemaVersion: 1, phase: "ready", commitSha: COMMIT_SHA, serializerId: SERIALIZER_ID };
  docs["system/billing"] = { disabled: true };
  docs["system/noBuildPostAdmission"].backgroundBucket = "njpbs-public-artifacts";
  const reads: string[] = [];
  const request = vi.fn(async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return token();
    if (url.includes(":runQuery")) return json([]);
    const parsed = new URL(url);
    const name = parsed.pathname.split("/documents/")[1];
    reads.push(name);
    if (name === "system/billing") expect(parsed.searchParams.getAll("mask.fieldPaths")).toContain("disabled");
    if (name === "system/publicDeployment/noBuildPostOwners") return json({});
    return docs[name] ? json({ fields: firestoreFields(docs[name]) }) : absent();
  }) as unknown as typeof fetch;
  expect(await readNoBuildPublicationWork(options, request)).toEqual({ needsRuntime: false, healthy: false,
    diagnostics: { reasons: ["billing_disabled"], oldestDueAt: null } });
  expect(reads).toEqual(["system/cmsPublicationRuntime", "system/billing"]);
  docs["system/billing"].disabled = false;
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(true);
});

it.each(["pending", "failed"])("wakes private retention through masked reads while generated outputs leave the aggregate %s", async status => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const docs = documents(), id = "D".repeat(20), path = `cmsPublishQueue/${id}`;
  Object.assign(docs["system/publicDeployment/aggregateContexts/current"], {
    finalNamespaceOwner: true, preparationOperationId: id, namespaceOperationId: id });
  delete docs["system/publicDeployment/noBuildPosts/current"];
  docs["system/cmsPublicationRuntime"] = { schemaVersion: 1, phase: "ready", commitSha: COMMIT_SHA, serializerId: SERIALIZER_ID };
  docs["system/noBuildPostAdmission"].backgroundBucket = "njpbs-public-artifacts";
  Object.assign(docs[path], { status, previewContext: undefined });
  const preparedPath = `${path}/backgroundPreparation/${digest}`;
  docs[preparedPath] = { runtime: { owner: "cloudflare", release: COMMIT_SHA }, status: "verified", contextDigest: digest, preparedDigest: "e".repeat(64) };
  for (const output of ["listings", "authors", "feed", "contentApi", "sitemap", "search"]) {
    const taskPath = `${path}/backgroundOutputs/${output}`;
    docs[`cmsBackgroundOutputs/${output}`] = { runtime: docs[preparedPath].runtime, contextOnly: true,
      taskPath, contextDigest: digest, status: "verified", receipt: { rendererSha: COMMIT_SHA } };
  }
  docs["cmsBackgroundOutputs/search"].status = "failed";
  docs[`${path}/backgroundOutputs/search`] = { runtime: docs[preparedPath].runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  const request = vi.fn(async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return token();
    if (url.includes(":runQuery")) return json([]);
    const name = new URL(url).pathname.split("/documents/")[1];
    if (name === "system/publicDeployment/noBuildPostOwners") return json({});
    const value = docs[name];
    return value ? json({ fields: firestoreFields(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))) }) : absent();
  }) as unknown as typeof fetch;
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(true);
  const url = request.mock.calls.find(([url]) => String(url).includes(`/${preparedPath}?`))![0];
  expect(new URL(String(url)).searchParams.getAll("mask.fieldPaths")).toContain("preparedDigest");
  docs[path].previewContext = { status: "verified", contextDigest: digest, publicationGeneration: 1,
    manifestId: "b".repeat(64), publicationArtifactReceiptDigest: "c".repeat(64) };
  expect((await readNoBuildPublicationWork(options, request)).needsRuntime).toBe(status === "pending");
});
