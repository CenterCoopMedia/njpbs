import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hasPendingPreviewWork } from "./pending-work";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = JSON.stringify({
  type: "service_account", project_id: "njpbs-site", client_email: "preview@njpbs-site.iam.gserviceaccount.com",
  private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
});
const rendererSha = "a".repeat(40);
const options = { account, rendererSha, serializerId: "cloud-preview" };
const queueId = "abcdefghijklmnopqrst";
const documents = "https://firestore.googleapis.com/v1/projects/njpbs-site/databases/(default)/documents";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const token = () => json({ access_token: "synthetic-token", token_type: "Bearer" });
const runtime = (phase = "ready", overrides: Record<string, unknown> = {}) => json({ fields: {
  schemaVersion: { integerValue: "1" }, phase: { stringValue: phase },
  rendererSha: { stringValue: rendererSha }, serializerId: { stringValue: options.serializerId }, ...overrides,
} });
const absent = () => new Response(null, { status: 404 });
const job = (commitSha = rendererSha) => json({ fields: { job: { mapValue: { fields: {
  queueId: { stringValue: queueId }, commitSha: { stringValue: commitSha },
} } } } });

function responses(...values: Response[]) {
  const request = vi.fn<typeof fetch>(async () => {
    const response = values.shift();
    if (!response) throw new Error("Unexpected network request in test");
    return response;
  });
  return request;
}

describe("cloud preview pending work", () => {
  it("signs a short-lived datastore assertion and requests only projected server identities", async () => {
    const request = responses(token(), runtime(), absent(), json([]));
    const before = Math.floor(Date.now() / 1000);
    expect(await hasPendingPreviewWork(options, request)).toBe(false);
    const [tokenUrl, tokenInit] = request.mock.calls[0];
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(tokenInit).toMatchObject({ method: "POST", redirect: "manual" });
    const form = tokenInit!.body as URLSearchParams;
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, payload, signature] = form.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({
      iss: "preview@njpbs-site.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/datastore", aud: tokenUrl,
    });
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(claims.exp - claims.iat).toBe(300);
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);

    const runtimeUrl = new URL(String(request.mock.calls[1][0]));
    expect(runtimeUrl.origin + runtimeUrl.pathname).toBe(`${documents}/system/cmsPreviewRuntime`);
    expect(runtimeUrl.searchParams.getAll("mask.fieldPaths")).toEqual(["schemaVersion", "phase", "rendererSha", "serializerId", "selectedPairId", "recoveryPairId"]);
    const [journalUrl, journalInit] = request.mock.calls[2];
    const parsed = new URL(String(journalUrl));
    expect(parsed.origin + parsed.pathname).toBe(`${documents}/cmsPreviewSerializerJournals/cloud-preview`);
    expect(parsed.searchParams.getAll("mask.fieldPaths")).toEqual(["job.queueId", "job.commitSha"]);
    expect(new Headers(journalInit!.headers).get("Authorization")).toBe("Bearer synthetic-token");
    const [queryUrl, queryInit] = request.mock.calls[3];
    expect(queryUrl).toBe(`${documents}:runQuery`);
    expect(new Headers(queryInit!.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(queryInit!.body))).toEqual({ structuredQuery: {
      from: [{ collectionId: "cmsPreviewQueue" }], select: { fields: [{ fieldPath: "__name__" }] }, limit: 1,
      where: { compositeFilter: { op: "AND", filters: Object.entries({ status: "pending", transport: "serializer", rendererSha })
        .map(([fieldPath, stringValue]) => ({ fieldFilter: { field: { fieldPath }, op: "EQUAL", value: { stringValue } } })) } },
    } });
    // No snapshot or raw-token field appears in either Firestore projection.
    expect(String(journalUrl) + String(queryInit!.body)).not.toMatch(/claimToken|snapshot|cmsPosts/);
  });

  it("resumes a matching journal without querying the queue", async () => {
    const request = responses(token(), runtime(), job());
    expect(await hasPendingPreviewWork(options, request)).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("rejects a journal for another renderer without querying the queue", async () => {
    const request = responses(token(), runtime(), job("b".repeat(40)));
    await expect(hasPendingPreviewWork(options, request)).rejects.toThrow("original renderer");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([{ fields: {} }, { fields: { job: { nullValue: null } } }])(
    "returns false for an empty journal and empty queue", async journal => {
      const request = responses(token(), runtime(), json(journal), json([{ readTime: "2026-09-09T12:00:00Z" }]));
      expect(await hasPendingPreviewWork(options, request)).toBe(false);
      expect(request).toHaveBeenCalledTimes(4);
    },
  );

  it("returns true when the projected queue name belongs to this project", async () => {
    const request = responses(token(), runtime(), absent(), json([{ document: {
      name: `projects/njpbs-site/databases/(default)/documents/cmsPreviewQueue/${queueId}`,
    } }]));
    expect(await hasPendingPreviewWork(options, request)).toBe(true);
  });

  it.each(["oauth", "journal", "query"])("fails closed on a non-ok %s response", async stage => {
    const prefix = stage === "oauth" ? [] : stage === "journal" ? [token(), runtime()] : [token(), runtime(), absent()];
    const request = responses(...prefix, new Response("private provider diagnostic", { status: 503 }));
    await expect(hasPendingPreviewWork(options, request)).rejects.toThrow("Cloud preview work check failed");
    expect(request).toHaveBeenCalledTimes(prefix.length + 1);
  });

  it.each(["oauth", "runtime", "journal", "query"])("refuses a %s redirect without forwarding credentials", async stage => {
    const prefix = stage === "oauth" ? [] : stage === "runtime" ? [token()]
      : stage === "journal" ? [token(), runtime()] : [token(), runtime(), absent()];
    const request = responses(...prefix, new Response(null, {
      status: 302, headers: { Location: "https://untrusted.example/" },
    }));
    await expect(hasPendingPreviewWork(options, request)).rejects.toThrow(/Cloud preview/);
    expect(request).toHaveBeenCalledTimes(prefix.length + 1);
    for (const [, init] of request.mock.calls) expect(init?.redirect).toBe("manual");
  });

  it.each(["oauth", "journal", "query"])("bounds and sanitizes malformed %s responses", async stage => {
    for (const body of ["private invalid JSON", "x".repeat(64 * 1024 + 1)]) {
      const prefix = stage === "oauth" ? [] : stage === "journal" ? [token(), runtime()] : [token(), runtime(), absent()];
      const request = responses(...prefix, new Response(body));
      await expect(hasPendingPreviewWork(options, request)).rejects.toThrow(/Cloud preview/);
      expect(request).toHaveBeenCalledTimes(prefix.length + 1);
    }
  });

  it.each([{}, [null], [{ document: { name: "projects/another-project/documents/secret" } }], [{}, {}, {}]].map(result => [result]))(
    "rejects invalid queue response identities or shapes", async result => {
      await expect(hasPendingPreviewWork(options, responses(token(), runtime(), absent(), json(result)))).rejects.toThrow(/Cloud preview/);
    },
  );

  it("boots a starting runtime without reading a journal or inventing a queue job", async () => {
    const request = responses(token(), runtime("starting"));
    expect(await hasPendingPreviewWork(options, request)).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["paused", "ready"])("continues draining admitted journal and queue work while %s", async phase => {
    expect(await hasPendingPreviewWork(options, responses(token(), runtime(phase), job()))).toBe(true);
    expect(await hasPendingPreviewWork(options, responses(token(), runtime(phase), absent(), json([{ document: {
      name: `projects/njpbs-site/databases/(default)/documents/cmsPreviewQueue/${queueId}`,
    } }])))).toBe(true);
    expect(await hasPendingPreviewWork(options, responses(token(), runtime(phase), absent(), json([])))).toBe(false);
  });

  it.each([
    () => absent(), () => json({}), () => runtime("unknown"),
    () => runtime("ready", { phase: { stringValue: ["ready"] } }),
    () => runtime("ready", { schemaVersion: { integerValue: "2" } }),
    () => runtime("ready", { schemaVersion: { stringValue: "1" } }),
    () => runtime("ready", { rendererSha: { stringValue: "b".repeat(40) } }),
    () => runtime("starting", { serializerId: { stringValue: "other" } }),
    () => new Response("private diagnostic", { status: 503 }),
    () => new Response("private invalid JSON"),
  ])("rejects absent, invalid or mismatched runtime control before journal access", async response => {
    const request = responses(token(), response());
    await expect(hasPendingPreviewWork(options, request)).rejects.toThrow(/^Cloud preview runtime control is invalid$/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects another project's credential before any fetch", async () => {
    const request = responses();
    const wrongAccount = JSON.stringify({ ...JSON.parse(account), project_id: "another-project" });
    await expect(hasPendingPreviewWork({ ...options, account: wrongAccount }, request)).rejects.toThrow("credential is invalid");
    expect(request).not.toHaveBeenCalled();
  });

  it("reads dev control and queue names only in the dev project", async () => {
    const projectId = "njpbs-site-dev";
    const devAccount = JSON.stringify({ ...JSON.parse(account), project_id: projectId,
      client_email: `preview@${projectId}.iam.gserviceaccount.com` });
    const request = responses(token(), runtime(), absent(), json([{ document: {
      name: `projects/${projectId}/databases/(default)/documents/cmsPreviewQueue/${queueId}`,
    } }]));
    expect(await hasPendingPreviewWork({ ...options, account: devAccount,
      deploymentEnvironment: "development", projectId }, request)).toBe(true);
    expect(request.mock.calls.slice(1).every(([url]) => String(url).includes(`/projects/${projectId}/`))).toBe(true);
  });

  it.each([["development", "njpbs-site"], ["production", "njpbs-site-dev"]])(
    "refuses %s polling against %s before OAuth", async (deploymentEnvironment, projectId) => {
      const request = responses();
      await expect(hasPendingPreviewWork({ ...options, deploymentEnvironment, projectId }, request)).rejects.toThrow("target differs");
      expect(request).not.toHaveBeenCalled();
    });
});

describe("retained preview pair pending work", () => {
  const serializerId = "preview-old";
  const workerVersion = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const paired = { ...options, serializerId, workerVersion };
  const selector = (overrides = {}) => runtime("ready", { schemaVersion: { integerValue: "2" },
    selectedPairId: { stringValue: "preview-new" }, recoveryPairId: { stringValue: serializerId },
    rendererSha: { stringValue: "b".repeat(40) }, serializerId: { stringValue: "preview-new" }, ...overrides });
  const pair = (overrides = {}) => json({ fields: { pairId: { stringValue: serializerId },
    serializerId: { stringValue: serializerId }, rendererSha: { stringValue: rendererSha },
    workerVersion: { stringValue: workerVersion }, ...overrides } });
  it("wakes OLD's own journal after NEW selection and validates provider version", async () => {
    const request = responses(token(), selector(), pair(), job());
    expect(await hasPendingPreviewWork(paired, request)).toBe(true);
    expect(String(request.mock.calls[2][0])).toContain(`/cmsPreviewPairs/${serializerId}?`);
  });
  it("filters missed-wake recovery by incarnation even for the same source SHA", async () => {
    const request = responses(token(), selector(), pair(), absent(), json([]));
    expect(await hasPendingPreviewWork(paired, request)).toBe(false);
    const query = JSON.parse(String(request.mock.calls.at(-1)![1]!.body));
    expect(query.structuredQuery.where.compositeFilter.filters).toContainEqual({ fieldFilter: {
      field: { fieldPath: "serializerId" }, op: "EQUAL", value: { stringValue: serializerId } } });
  });
  it.each([
    { workerVersion: { stringValue: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" } },
    { rendererSha: { stringValue: "b".repeat(40) } },
    { pairId: { stringValue: "preview-other" } },
  ])("refuses immutable pair drift before journal or container work", async drift => {
    const request = responses(token(), selector(), pair(drift));
    await expect(hasPendingPreviewWork(paired, request)).rejects.toThrow("runtime control is invalid");
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("refuses an unretained incarnation or a missing provider version", async () => {
    const request = responses(token(), selector({ recoveryPairId: { stringValue: "preview-retired" } }));
    await expect(hasPendingPreviewWork(paired, request)).rejects.toThrow("runtime control is invalid");
    expect(request).toHaveBeenCalledTimes(2);
    await expect(hasPendingPreviewWork({ ...paired, workerVersion: undefined }, responses(token(), selector())))
      .rejects.toThrow("runtime control is invalid");
  });
});
