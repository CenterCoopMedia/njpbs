import { describe, it, expect } from "vitest";
import api from "../../functions/video-transcript-byok.js";
import credentials from "../../functions/lib/video-transcription-credentials.js";
import renditions from "../../functions/lib/source-media-rendition.js";
import fallbackPolicy from "../../functions/lib/video-transcript-fallback-policy.js";
import transcriptJobs from "../../functions/lib/video-transcript-job.js";
import transcriptContract from "../../functions/lib/video-transcript-contract.js";
import paidFallback from "../../functions/lib/video-transcript-paid-fallback.js";
import transcriptHandlers from "../../functions/video-transcripts.js";
const source = {
  id: "video-library",
  bucket: "originals",
  prefix: "",
  writable: true,
  access: "active_staff",
};
const request = {
  sourceId: "video-library",
  assetId: "asset",
  provider: "elevenlabs",
  credentialScope: "organization",
  credentialRevision: 1,
  languageCode: "en-US",
  maxSpeakers: 10,
};
const actor = {
  uid: "staff",
  authTime: 100,
  displayName: "Staff",
  principal: { grants: [{ role: "staff" }] },
};
const settings = {
  enabled: true,
  amazonFallbackEnabled: true,
  bucket: "renditions",
  accountId: "123456789012",
};
const now = Date.parse("2026-09-15T12:00:00Z");
function asset() {
  const result = {
    id: "asset",
    sourceId: "video-library",
    objectKey: "objects/asset.mxf",
    objectVersionId: "version1",
    sizeBytes: 100,
    lifecycle: "active",
    name: "Video",
    originalName: "video.mxf",
    nameSort: "video",
    updatedAtSort: "2026-09-15T12:00:00Z",
    mimeType: "application/mxf",
    kind: "video",
    version: 1,
    preview: "download_only",
    rightsStatus: "complete",
    tags: [],
  };
  const prefix = `outputs/${renditions.sourceMediaRenditionId(result)}/attempt/`;
  result.rendition = {
    schemaVersion: 1,
    state: "ready",
    sourceObjectKey: result.objectKey,
    sourceObjectVersionId: result.objectVersionId,
    sourceSizeBytes: result.sizeBytes,
    attemptId: "attempt",
    updatedAt: "2026-09-15T12:00:00Z",
    web: {
      objectKey: prefix + "preview.mp4",
      objectVersionId: "web1",
      sizeBytes: 50,
      mimeType: "video/mp4",
      durationSeconds: 60,
    },
    poster: {
      objectKey: prefix + "preview-poster.0000000.jpg",
      objectVersionId: "poster1",
      sizeBytes: 5,
      mimeType: "image/jpeg",
    },
  };
  return result;
}
function memoryStore() {
  const rows = new Map([["mediaSourceAssets/asset", asset()]]);
  let tail = Promise.resolve();
  let next = 1;
  const ref = (collection, id = `auto${next++}`) => {
    const result = { path: `${collection}/${id}`, id };
    result.get = async () => snap(result);
    return result;
  };
  const snap = (reference) => ({
    id: reference.id,
    ref: reference,
    exists: rows.has(reference.path),
    data: () => structuredClone(rows.get(reference.path)),
  });
  const query = (name, filters = [], after = null, count = Infinity, order = "__name__", direction = "asc") => ({
    doc: (id) => ref(name, id),
    where: (field, operator, value) =>
      query(name, [...filters, [field, operator, value]], after, count, order, direction),
    orderBy: (field, dir = "asc") => query(name, filters, after, count, field, dir),
    startAfter: (id) => query(name, filters, id, count, order, direction),
    limit: (value) => query(name, filters, after, value, order, direction),
    get: async () => ({
      docs: [...rows]
        .filter(
          ([key, value]) =>
            key.startsWith(name + "/") &&
            filters.every(
              ([field, operator, expected]) =>
                operator === "==" && value[field] === expected,
            ) &&
            (!after || key.split("/").at(-1) > after),
        )
        .sort(([a,av], [b,bv]) => { const x = order === "__name__" ? a : av[order], y = order === "__name__" ? b : bv[order]; return (x < y ? -1 : x > y ? 1 : 0) * (direction === "desc" ? -1 : 1); })
        .slice(0, count)
        .map(([key]) => snap({ path: key, id: key.split("/").at(-1) })),
    }),
  });
  const firestore = {
    doc: (path) => {
      const [name, id] = path.split("/");
      return ref(name, id);
    },
    collection: (name) => query(name),
    runTransaction: (fn) => {
      const run = tail.then(async () => {
        const writes = [];
        const result = await fn({
          get: async (reference) => reference.path ? snap(reference) : reference.get(),
          create: (reference, value) =>
            writes.push(["create", reference, structuredClone(value)]),
          update: (reference, value) =>
            writes.push(["update", reference, structuredClone(value)]),
          set: (reference, value) =>
            writes.push(["set", reference, structuredClone(value)]),
        });
        for (const [mode, reference, value] of writes) {
          if (mode === "create" && rows.has(reference.path))
            throw Error("already exists");
          rows.set(
            reference.path,
            mode === "create"
              ? value
              : { ...rows.get(reference.path), ...value },
          );
        }
        return result;
      });
      tail = run.catch(() => {});
      return run;
    },
  };
  return { rows, firestore };
}
const audit = (value) => value;
async function queued(store = memoryStore()) {
  const result = await jobs.requestTranscript({
    firestore: store.firestore,
    source,
    request,
    actor,
    audit,
  });
  return { ...store, ...result };
}
function providerJob(job, status = "IN_PROGRESS") {
  return {
    TranscriptionJobName: processorModule.jobName(job),
    LanguageCode: job.languageCode,
    Media: { MediaFileUri: `s3://renditions/${processorModule.inputKey(job)}` },
    Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: job.maxSpeakers },
    TranscriptionJobStatus: status,
  };
}
const missing = () =>
  Object.assign(Error("The requested job couldn't be found."), {
    name: "BadRequestException",
  });
function processing(
  job,
  { provider = null, startError = null, s3Send, billingDisabled = false } = {},
) {
  const calls = [];
  const processor = processorModule.createVideoTranscriptProcessor(config, {
    firestore: {
      doc: () => ({
        get: async () => ({
          exists: true,
          data: () => ({
            disabled:
              typeof billingDisabled === "function"
                ? billingDisabled()
                : billingDisabled,
          }),
        }),
      }),
    },
    credentials: async () => ({}),
    transcribe: {
      send: async (command) => {
        calls.push(command);
        if (command.constructor.name === "GetTranscriptionJobCommand") {
          if (!provider) throw missing();
          return { TranscriptionJob: provider };
        }
        if (startError) throw startError;
        return {};
      },
    },
    s3: {
      send:
        s3Send ??
        (async (command) => {
          calls.push(command);
          return command.constructor.name === "HeadObjectCommand"
            ? { VersionId: "web1", ContentLength: 50 }
            : { VersionId: "output1" };
        }),
    },
  });
  const save = async (changes) => {
    Object.assign(job, changes);
    return true;
  };
  return { processor, calls, save };
}

function setup() {
  const store = memoryStore();
  store.rows.set("users/staff", { active: true });
  const key = credentials.credentialIdentity(actor, {
    scope: "organization",
    provider: "elevenlabs",
  });
  store.rows.set(`${credentials.CREDENTIAL_COLLECTION}/${key.id}`, {
    ...key,
    revision: 1,
    enabled: true,
    ciphertext: "never-return",
  });
  return { ...store, source, request, actor, settings, now, audit: (x) => x };
}
async function call(operation, args, body = request, overrides = {}) {
  const res = {
    statusCode: 200,
    set() {},
    status(x) {
      this.statusCode = x;
      return this;
    },
    json(x) {
      this.body = x;
      return this;
    },
  };
  await api.createByokHandler(operation, {
    firestore: args.firestore,
    registryFn: () => new Map([[source.id, source]]),
    configFn: () => settings,
    now: () => now,
    verifyAppCheckFn: async () => {},
    requirePrincipalFn: async () => actor,
    audit: (x) => x,
    ...overrides,
  })(
    { method: "POST", headers: { "content-type": "application/json" }, body },
    res,
  );
  return res;
}
describe("BYOK admission and safe discovery", () => {
  function fallbackSetup() {
    const args = setup();
    const media = asset();
    args.fallbackParentId = transcriptContract.transcriptId(media, source.bucket, request);
    const parent = { id: args.fallbackParentId, active: true, phase: "pending",
      processingPolicy: fallbackPolicy.PAID_FALLBACK_POLICY, paidFallbackState: "pending",
      provider: "amazon-transcribe", requestedBy: actor.uid, requestedAuthTime: actor.authTime,
      createdAt: new Date(now).toISOString(),
      languageCode: request.languageCode, maxSpeakers: request.maxSpeakers,
      assetId: media.id, sourceId: source.id, sourceBucket: source.bucket,
      sourceObjectKey: media.objectKey, sourceObjectVersionId: media.objectVersionId,
      sourceSizeBytes: media.sizeBytes, input: media.rendition.web, durationSeconds: media.rendition.web.durationSeconds };
    args.rows.set(`mediaSourceTranscriptJobs/${args.fallbackParentId}`, parent);
    return { args, parent };
  }
  async function requestedFallbackSetup() {
    const args=setup();
    const created=await transcriptJobs.requestTranscript({firestore:args.firestore,source,
      request:{sourceId:source.id,assetId:request.assetId,languageCode:request.languageCode,maxSpeakers:request.maxSpeakers},
      actor,audit:args.audit,now,localEnabled:false,paidFallbackEnabled:true});
    args.fallbackParentId=created.job.id;
    return {args,parent:created.job};
  }
  it("admits one child under concurrent scheduler retries without starting Amazon", async () => {
    const { args }=await requestedFallbackSetup();let amazonCalls=0;
    const tick=()=>transcriptHandlers.processTranscriptTick({firestore:args.firestore,
      config:{enabled:true,source,bucket:settings.bucket,accountId:settings.accountId,controlRoleArn:"control",
        dataRoleArn:"data",localEnabled:false,fallbackEnabled:true},now:()=>now,
      paidFallback:{config:()=>settings,admit:api.admit},processor:{process:async()=>{amazonCalls++;}}});
    const results=await Promise.all([tick(),tick()]);
    const parent=args.rows.get(`mediaSourceTranscriptJobs/${args.fallbackParentId}`);
    const child=args.rows.get(`mediaSourceTranscriptJobs/${parent.fallbackTranscriptId}`);
    expect(results.every(result=>result.enabled===true)).toBe(true);expect(amazonCalls).toBe(0);
    expect(parent).toMatchObject({paidFallbackState:"waiting",active:true});
    expect(child).toMatchObject({provider:"elevenlabs",active:true,requestedAuthTime:actor.authTime});
    expect([...args.rows].filter(([path,row])=>path.startsWith("mediaSourceTranscriptJobs/")&&row.provider==="elevenlabs")).toHaveLength(1);
    const budget=args.rows.get(`mediaTranscriptionBudgets/global-${new Date(now).toISOString().slice(0,10)}`);
    expect(budget.reservedSubmissions).toBe(1);
  });
  it("atomically binds one paid fallback and reserves one submission under concurrent admission", async () => {
    const { args } = fallbackSetup();
    const results = await Promise.allSettled([api.admit(args), api.admit(args)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const child = results.find(result => result.status === "fulfilled").value.job;
    expect(args.rows.get(`mediaSourceTranscriptJobs/${args.fallbackParentId}`)).toMatchObject({
      paidFallbackState: "waiting", fallbackTranscriptId: child.id,
    });
    const global = args.rows.get(`mediaTranscriptionBudgets/global-${new Date(now).toISOString().slice(0, 10)}`);
    expect(global.reservedSubmissions).toBe(1);
  });
  it("does not admit paid fallback after parent source, identity, or intent changes", async () => {
    for (const changes of [{ sourceObjectVersionId: "replaced" }, { requestedAuthTime: 101 },
      { startIntentAt: new Date(now).toISOString() }, { paidFallbackState: "amazon" }, { active: false }]) {
      const { args, parent } = fallbackSetup();
      Object.assign(parent, changes);
      await expect(api.admit(args)).rejects.toMatchObject({ status: 409 });
      expect([...args.rows.values()].some(row => row.budgetReservation)).toBe(false);
    }
  });
  it("resolves the default transcript to its source-bound station fallback", async () => {
    const { args } = fallbackSetup();
    const admitted = await api.admit(args);
    const selected = await transcriptJobs.getTranscriptJob({ firestore: args.firestore, source,
      request: { sourceId: source.id, assetId: "asset", languageCode: request.languageCode, maxSpeakers: request.maxSpeakers },
      renditionBucket: settings.bucket });
    expect(selected.id).toBe(admitted.job.id);
    expect(selected.provider).toBe("elevenlabs");
    args.rows.get(`mediaSourceTranscriptJobs/${admitted.job.id}`).identity.credentialScope = "personal";
    await expect(transcriptJobs.getTranscriptJob({ firestore: args.firestore, source,
      request: { ...request, transcriptId: args.fallbackParentId }, renditionBucket: settings.bucket })).rejects.toMatchObject({ status: 409 });
  });
  function route(args) {
    return paidFallback.routePaidFallback({ ...args, admit: api.admit,
      ref: args.firestore.collection("mediaSourceTranscriptJobs").doc(args.fallbackParentId) });
  }
  it("runs the station paid path once and reuses its completed transcript", async () => {
    const { args } = fallbackSetup();
    expect(await route(args)).toBe(false);
    const parent = args.rows.get(`mediaSourceTranscriptJobs/${args.fallbackParentId}`);
    const child = args.rows.get(`mediaSourceTranscriptJobs/${parent.fallbackTranscriptId}`);
    expect(await route(args)).toBe(false);
    expect(await transcriptJobs.claimTranscript(args.firestore, args.firestore.collection("mediaSourceTranscriptJobs").doc(parent.id), source, now)).toBeNull();
    Object.assign(child, { active: false, phase: "ready", totalSegments: 1 });
    expect(await route(args)).toBe(false);
    expect(args.rows.get(`mediaSourceTranscriptJobs/${parent.id}`)).toMatchObject({ active: false, paidFallbackState: "ready" });
    expect(transcriptContract.transcriptSummary(parent).processing.provider).toBe("elevenlabs");
    const listed = await api.listFor(args);
    expect(listed.transcripts.map(transcript => transcript.id)).toEqual([child.id]);
  });
  it("uses Amazon when a video can never fit the station daily audio limit", async () => {
    const { args, parent } = fallbackSetup();
    const durationSeconds = fallbackPolicy.REQUESTER_DAILY_AUDIO_SECONDS + 1;
    parent.durationSeconds = durationSeconds;
    parent.input.durationSeconds = durationSeconds;
    args.rows.get("mediaSourceAssets/asset").rendition.web.durationSeconds = durationSeconds;
    expect(await route(args)).toBe(true);
    expect(args.rows.get(`mediaSourceTranscriptJobs/${parent.id}`)).toMatchObject({
      paidFallbackState: "amazon", phase: "pending", active: true,
    });
    expect([...args.rows].some(([path, row]) =>
      path.startsWith("mediaSourceTranscriptJobs/") && row.provider === "elevenlabs")).toBe(false);
  });
  it("recovers a committed child after the admission response is lost", async () => {
    const { args }=fallbackSetup();
    await expect(paidFallback.routePaidFallback({...args,
      ref:args.firestore.collection("mediaSourceTranscriptJobs").doc(args.fallbackParentId),
      admit:async(input)=>{await api.admit(input);throw Error("lost response");}})).rejects.toThrow("lost response");
    expect(await route(args)).toBe(false);
    const parent=args.rows.get(`mediaSourceTranscriptJobs/${args.fallbackParentId}`);
    expect(parent).toMatchObject({paidFallbackState:"waiting"});
    expect([...args.rows].filter(([path,row])=>path.startsWith("mediaSourceTranscriptJobs/")&&row.provider==="elevenlabs")).toHaveLength(1);
  });
  it("keeps uncertain ElevenLabs submission out of Amazon", async () => {
    const { args } = fallbackSetup();
    await route(args);
    const parent = args.rows.get(`mediaSourceTranscriptJobs/${args.fallbackParentId}`);
    Object.assign(args.rows.get(`mediaSourceTranscriptJobs/${parent.fallbackTranscriptId}`), {
      active: false, phase: "needs_reconciliation", errorCode: "elevenlabs_submission_uncertain",
    });
    expect(await route(args)).toBe(false);
    expect(args.rows.get(`mediaSourceTranscriptJobs/${parent.id}`)).toMatchObject({ active: false, phase: "needs_reconciliation" });
  });
  it("permits Amazon only after a definitive failed paid request", async () => {
    const { args } = fallbackSetup();
    await route(args);
    const parent = args.rows.get(`mediaSourceTranscriptJobs/${args.fallbackParentId}`);
    Object.assign(args.rows.get(`mediaSourceTranscriptJobs/${parent.fallbackTranscriptId}`), {
      active: false, phase: "failed", errorCode: "elevenlabs_request_rejected",
    });
    expect(await route(args)).toBe(true);
    const claimed = await transcriptJobs.claimTranscript(args.firestore,
      args.firestore.collection("mediaSourceTranscriptJobs").doc(parent.id), source, now);
    expect(claimed.paidFallbackState).toBe("amazon");
  });
  it("does not use a personal key when the station key is absent", async () => {
    const { args } = fallbackSetup();
    const key = credentials.credentialIdentity(actor, { scope: "organization", provider: "elevenlabs" });
    args.rows.delete(`${credentials.CREDENTIAL_COLLECTION}/${key.id}`);
    const personal = credentials.credentialIdentity(actor, { scope: "personal", provider: "elevenlabs" });
    args.rows.set(`${credentials.CREDENTIAL_COLLECTION}/${personal.id}`, { ...personal, revision: 1, enabled: true });
    expect(await route(args)).toBe(true);
    expect([...args.rows.values()].some(row => row.budgetReservation)).toBe(false);
  });
  it("keeps Amazon available when local processing is off and the station key is absent", async () => {
    const { args } = await requestedFallbackSetup();
    const key = credentials.credentialIdentity(actor, { scope: "organization", provider: "elevenlabs" });
    args.rows.delete(`${credentials.CREDENTIAL_COLLECTION}/${key.id}`);
    const amazonCalls = [];
    await transcriptHandlers.processTranscriptTick({ firestore: args.firestore,
      config: { enabled: true, source, bucket: settings.bucket, accountId: settings.accountId,
        controlRoleArn: "control", dataRoleArn: "data", localEnabled: false, fallbackEnabled: false },
      now: () => now, paidFallback: { config: () => settings, admit: api.admit },
      processor: { process: async job => amazonCalls.push(job.id) } });
    expect(amazonCalls).toEqual([args.fallbackParentId]);
    expect(args.rows.get(`mediaSourceTranscriptJobs/${args.fallbackParentId}`)).toMatchObject({
      paidFallbackState: "amazon",
    });
  });
  it("keeps a quota-blocked station request pending without using Amazon", async () => {
    const { args } = fallbackSetup();
    const refs=api.budgetRefs(args.firestore,actor.uid,new Date(now).toISOString().slice(0,10));
    args.rows.set(refs.global.path,{consumedSubmissions:api.LIMITS.global.submissions});
    expect(await route(args)).toBe(false);
    expect(args.rows.get(`mediaSourceTranscriptJobs/${args.fallbackParentId}`)).toMatchObject({
      active:true,phase:"pending",paidFallbackState:"pending",
    });
    expect([...args.rows].some(([path,row])=>path.startsWith("mediaSourceTranscriptJobs/")&&row.provider==="elevenlabs")).toBe(false);
  });
  it("stops an invalid station credential or replaced source before another paid provider", async () => {
    for (const change of ["credential","source"]) {
      const { args }=fallbackSetup();
      if (change==="credential") {
        const key=credentials.credentialIdentity(actor,{scope:"organization",provider:"elevenlabs"});
        args.rows.get(`${credentials.CREDENTIAL_COLLECTION}/${key.id}`).revision="invalid";
      } else args.rows.get("mediaSourceAssets/asset").objectVersionId="replaced";
      expect(await route(args)).toBe(false);
      expect(args.rows.get(`mediaSourceTranscriptJobs/${args.fallbackParentId}`)).toMatchObject({
        active:false,phase:"needs_reconciliation",
      });
      expect([...args.rows].some(([path,row])=>path.startsWith("mediaSourceTranscriptJobs/")&&row.provider==="elevenlabs")).toBe(false);
    }
  });
  it("stopped billing and revoked staff access block both paid providers", async () => {
    for (const [path, value] of [["system/billing", { disabled: true }], ["users/staff", { active: false }]]) {
      const { args } = fallbackSetup();
      args.rows.set(path, value);
      expect(await route(args)).toBe(false);
      expect([...args.rows.values()].some(row => row.budgetReservation)).toBe(false);
      expect(args.rows.get(`mediaSourceTranscriptJobs/${args.fallbackParentId}`)).toMatchObject({ active: false });
    }
  });
  it("authenticates before interpreting malformed request", async () => {
    const res = await call(
      "request",
      setup(),
      {},
      {
        requirePrincipalFn: async () => {
          throw Object.assign(Error("Denied"), { status: 401 });
        },
      },
    );
    expect(res.statusCode).toBe(401);
  });
  it("allows active staff to use station credentials without settings management", async () => {
    const args = setup();
    const result = await call("request", args);
    expect(result.statusCode).toBe(200);
    expect(result.body.transcript.processing.provider).toBe("elevenlabs");
    const job = [...args.rows.values()].find((x) => x.budgetReservation);
    expect(job).toMatchObject({
      requestedBy: "staff",
      requestedAuthTime: 100,
      budgetReservation: { state: "reserved", audioSeconds: 60 },
    });
  });
  it("rejects sub-minimum input before creating a job or reserving budget", async () => {
    const args = setup();
    args.rows.get("mediaSourceAssets/asset").rendition.web.durationSeconds = 0.05;
    const before = structuredClone([...args.rows]);
    expect((await call("request", args)).statusCode).toBe(400);
    expect([...args.rows]).toEqual(before);
  });
  it("advertises and admits the exact provider minimum once", async () => {
    const args = setup();
    args.rows.get("mediaSourceAssets/asset").rendition.web.durationSeconds = 0.1;
    expect((await api.optionsFor(args)).provider.minDurationSeconds).toBe(0.1);
    const first = await api.admit(args);
    const cached = await api.admit(args);
    expect(first.job.durationSeconds).toBe(0.1);
    expect(cached.cached).toBe(true);
    const budget = (await api.optionsFor(args)).budget.requester;
    expect(budget.reservedSubmissions).toBe(1);
    expect(budget.reservedAudioSeconds).toBe(1);
    expect(budget.consumedSubmissions).toBe(0);
  });
  it("reuses an active audio canary on repeated preparation without reserving again", async () => {
    const args = { ...setup(), operatorCanaryId: "a".repeat(64), settings: { ...settings, audioEnabled: true } };
    const first = await api.admit(args);
    const saved = structuredClone([...args.rows]);
    const second = await api.admit(args);
    expect(first).toMatchObject({ cached: false, job: { active: true, phase: "pending", operatorCanaryId: args.operatorCanaryId } });
    expect(second).toEqual({ cached: true, job: first.job });
    expect([...args.rows]).toEqual(saved);
  });
  it("denies inactive staff and does not reserve", async () => {
    const args = setup();
    args.rows.set("users/staff", { active: false });
    expect((await call("request", args)).statusCode).toBe(403);
    expect(
      [...args.rows.keys()].some((x) =>
        x.startsWith("mediaTranscriptionBudgets/"),
      ),
    ).toBe(false);
  });
  it("concurrent duplicate admissions reserve once", async () => {
    const args = setup();
    const values = await Promise.all([api.admit(args), api.admit(args)]);
    expect(values.map((x) => x.cached)).toEqual([false, true]);
    const budget = await api.optionsFor(args);
    expect(budget.budget.requester).toMatchObject({
      reservedSubmissions: 1,
      reservedAudioSeconds: 60,
      consumedSubmissions: 0,
      outstanding: 1,
    });
    expect(budget.budget.global.reservedSubmissions).toBe(1);
  });
  it("rejects a second distinct outstanding request, even across UTC days", async () => {
    const args = setup();
    await api.admit(args);
    await expect(
      api.admit({
        ...args,
        now: now + 86400000,
        request: { ...request, languageCode: "es-US" },
      }),
    ).rejects.toMatchObject({ status: 429 });
  });
  it.each(["key", "deleted", "billing"])(
    "blocks stale or denied %s before reservation",
    async (kind) => {
      const args = setup();
      if (kind === "key") args.request = { ...request, credentialRevision: 2 };
      if (kind === "deleted")
        args.rows.get("mediaSourceAssets/asset").lifecycle = "deleted";
      if (kind === "billing")
        args.rows.set("system/billing", { disabled: true });
      await expect(api.admit(args)).rejects.toThrow();
      expect(
        [...args.rows.keys()].some((x) =>
          x.startsWith("mediaTranscriptionBudgets/"),
        ),
      ).toBe(false);
    },
  );
  it.each(["requester", "global"])(
    "enforces %s consumed and reserved budget together",
    async (scope) => {
      const args = setup();
      const refs = api.budgetRefs(args.firestore, actor.uid, "2026-09-15");
      args.rows.set(refs[scope].path, {
        reservedSubmissions: 1,
        consumedSubmissions: api.LIMITS[scope].submissions - 1,
      });
      await expect(api.admit(args)).rejects.toMatchObject({ status: 429 });
    },
  );
  it("enforces rounded audio reservation budget", async () => {
    const args = setup();
    const refs = api.budgetRefs(args.firestore, actor.uid, "2026-09-15");
    args.rows.set(refs.requester.path, { consumedAudioSeconds: 3541 });
    await expect(api.admit(args)).rejects.toMatchObject({ status: 429 });
  });
  it("returns safe key availability with feature disabled", async () => {
    const args = setup();
    const result = await api.optionsFor({
      ...args,
      settings: { ...settings, enabled: false },
    });
    expect(result.enabled).toBe(false);
    expect(result.credentials).toContainEqual({
      scope: "organization",
      provider: "elevenlabs",
      revision: 1,
      configured: true,
    });
    expect(JSON.stringify(result)).not.toContain("never-return");
    expect(JSON.stringify(result)).not.toContain("ownerUid");
  });
  it("rejects client ownership, URLs, model and unsupported settings", () => {
    for (const patch of [
      { ownerUid: "other" },
      { url: "https://bad" },
      { model: "other" },
      { maxSpeakers: 1 },
      { provider: "openai" },
    ])
      expect(() => api.parse({ ...request, ...patch }, "request")).toThrow();
  });
  it("lists selected variants and excludes changed rendition or unknown providers", async () => {
    const args = setup();
    const { job } = await api.admit(args);
    expect((await api.listFor(args)).transcripts).toHaveLength(1);
    args.rows.get(`mediaSourceTranscriptJobs/${job.id}`).provider = "unknown";
    expect((await api.listFor(args)).transcripts).toEqual([]);
    args.rows.get(`mediaSourceTranscriptJobs/${job.id}`).provider =
      "elevenlabs";
    args.rows.get("mediaSourceAssets/asset").rendition.web.objectVersionId =
      "replaced";
    expect((await api.listFor(args)).transcripts).toEqual([]);
  });
  it("binds pagination cursor to the immutable original and advances by document ID", () => {
    const key = api.binding(asset(), source),
      after = "a".repeat(64),
      cursor = Buffer.from(JSON.stringify({ binding: key, after })).toString(
        "base64url",
      );
    expect(api.cursorAfter(cursor, key)).toBe(after);
    expect(() =>
      api.cursorAfter(
        cursor,
        api.binding({ ...asset(), objectVersionId: "other" }, source),
      ),
    ).toThrow();
    expect(() => api.cursorAfter("bad", key)).toThrow();
  });
  it("fails request closed when the feature is disabled or auth time is missing", async () => {
    const args = setup();
    await expect(
      api.admit({ ...args, settings: { ...settings, enabled: false } }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      api.admit({ ...args, actor: { ...actor, authTime: null } }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("advances a filtered twenty-record page without losing the next valid variant", async () => {
    const args = setup(); await api.admit(args);
    for (let i = 1; i <= 20; i++) { const id = i.toString(16).padStart(64, "0"); args.rows.set(`mediaSourceTranscriptJobs/${id}`, { id, assetId:"asset", provider:"unsupported" }); }
    const first = await api.listFor(args);
    expect(first.transcripts).toEqual([]); expect(first.nextCursor).toBeTruthy();
    const next = await api.listFor({...args,request:{...request,cursor:first.nextCursor}});
    expect(next.transcripts).toHaveLength(1); expect(next.nextCursor).toBeNull();
  });

});

describe('explicit paid attempt admission', () => {
  it('keeps consumed history and reserves a new ElevenLabs generation once', async () => {
    const args = setup();
    const first = await call('request', args);
    expect(first.statusCode).toBe(200);
    const id = first.body.transcript.id, path = `mediaSourceTranscriptJobs/${id}`;
    const original = args.rows.get(path), reservation = original.budgetReservation;
    Object.assign(original, { active: false, phase: 'needs_reconciliation', submissionIntentAt: new Date(now).toISOString(),
      budgetReservation: { ...reservation, state: 'consumed' } });
    for (const record of [reservation.requesterRecord, reservation.globalRecord]) args.rows.set(`mediaTranscriptionBudgets/${record}`,
      { reservedSubmissions: 0, reservedAudioSeconds: 0, consumedSubmissions: 1, consumedAudioSeconds: 60 });
    args.rows.set(`mediaTranscriptionBudgets/${reservation.slotRecord}`, { jobId: null });
    const before = structuredClone(original), body = { ...request, newAttemptOf: id };
    const results = await Promise.all([call('request', args, body), call('request', args, body)]);
    expect(results.map(value => value.statusCode)).toEqual([200, 200]);
    expect(results.map(value => value.body.cached)).toEqual([false, true]);
    const nextId = results[0].body.transcript.id;
    expect(nextId).not.toBe(id);
    expect(args.rows.get(path)).toEqual(before);
    expect(args.rows.get(`mediaSourceTranscriptJobs/${nextId}`).identity).toMatchObject({ attemptGeneration: 1, previousTranscriptId: id });
    expect(args.rows.get(`mediaTranscriptionBudgets/${reservation.globalRecord}`)).toMatchObject({ consumedSubmissions: 1, consumedAudioSeconds: 60, reservedSubmissions: 1, reservedAudioSeconds: 60 });
    expect((await call('request', args, { ...request, newAttemptOf: nextId })).statusCode).toBe(409);
    expect((await call('list', args, { sourceId: source.id, assetId: 'asset' })).body.transcripts.map(value => value.id)).toEqual(expect.arrayContaining([id, nextId]));
  });
  it.each([['system/billing', { disabled: true }, 503], ['users/staff', { active: false }, 403]])('keeps %s checks for a fresh paid attempt', async (path, value, status) => {
    const args = setup(), first = await call('request', args), id = first.body.transcript.id;
    Object.assign(args.rows.get(`mediaSourceTranscriptJobs/${id}`), { active: false, phase: 'failed' });
    args.rows.set(path, value);
    expect((await call('request', args, { ...request, newAttemptOf: id })).statusCode).toBe(status);
  });
});
