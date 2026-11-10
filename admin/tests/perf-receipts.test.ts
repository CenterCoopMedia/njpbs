import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERF_MARKS,
  PERF_MEASURES,
  PERF_RECEIPT_SCHEMA_VERSION,
  createPerfRecorder,
  operationCategoryForEndpoint,
  publishPerfProbe,
  registerAdminPerfEditorLeaseRelease,
  sanitizePerfDetail,
  type TimingSink,
} from "../src/lib/perf-receipts";
import { routeCategoryForPath } from "../src/lib/routes";

interface RecordedMark {
  name: string;
  detail: unknown;
  startTime: number;
}

interface RecordedMeasure {
  name: string;
  detail: unknown;
  duration: number;
}

function fakeSink(): {
  sink: TimingSink;
  marks: RecordedMark[];
  measures: RecordedMeasure[];
} {
  const marks: RecordedMark[] = [];
  const measures: RecordedMeasure[] = [];
  let clock = 0;
  const sink: TimingSink = {
    now: () => (clock += 100),
    mark(name, options) {
      marks.push({
        name,
        detail: options?.detail,
        startTime: options?.startTime ?? clock,
      });
    },
    measure(name, options) {
      measures.push({
        name,
        detail: options?.detail,
        duration: (options?.end ?? clock) - (options?.start ?? 0),
      });
    },
  };
  return { sink, marks, measures };
}

describe("Admin performance mark inventory", () => {
  it("categorizes access-level changes with the other staff administration mutations", () => {
    expect(operationCategoryForEndpoint("setStaffAccessLevel")).toBe("staff-admin");
  });
  it("lets the capture harness await the current editor lease release", async () => {
    const { sink } = fakeSink();
    const recorder = createPerfRecorder(sink);
    const target: Record<string, unknown> = {};
    const unregister = registerAdminPerfEditorLeaseRelease(async () => true);
    try {
      publishPerfProbe(target, recorder);
      const probe = target.__njpbsAdminPerf as {
        releaseEditorLease(): Promise<boolean>;
      };
      await expect(probe.releaseEditorLease()).resolves.toBe(true);
    } finally {
      unregister();
    }
  });

  it("names every contracted phase under one reserved prefix", () => {
    const names = [
      ...Object.values(PERF_MARKS),
      ...Object.values(PERF_MEASURES),
    ];

    expect(names.every((name) => name.startsWith("njpbs.admin."))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(PERF_MARKS)).toEqual([
      "bootstrap",
      "authResolved",
      "sessionSignedIn",
      "admissionComplete",
      "profileConfirmed",
      "routeLoadStart",
      "routeLoadEnd",
      "cmsRequestStart",
      "cmsRequestEnd",
      "editorMounted",
      "editorReady",
      "saveStart",
      "saveCommitted",
    ]);
    expect(Object.keys(PERF_MEASURES)).toEqual([
      "auth",
      "admission",
      "profile",
      "routeLoad",
      "cmsTransport",
      "editorRender",
      "saveTransaction",
      "workspaceReady",
    ]);
  });

  it("classifies a route by category rather than by its address", () => {
    expect(routeCategoryForPath("/")).toBe("dashboard");
    expect(routeCategoryForPath("/content/pages/home/edit")).toBe("content");
    expect(routeCategoryForPath("/content/post/abc123/edit")).toBe("content");
    expect(routeCategoryForPath("/media")).toBe("media");
    expect(routeCategoryForPath("/media/favorites")).toBe("media");
    expect(routeCategoryForPath("/media/collections")).toBe("media");
    expect(routeCategoryForPath("/media/videos/archive-originals")).toBe("media");
    expect(routeCategoryForPath("/voiceovers")).toBe("voiceovers");
    expect(routeCategoryForPath("/staff-access")).toBe("staff-access");
    expect(routeCategoryForPath("/nowhere")).toBe("not-found");
  });

  it("classifies a CMS endpoint into a closed operation vocabulary", () => {
    expect(operationCategoryForEndpoint("cmsNudgeBugReport")).toBe("report-write");
    expect(operationCategoryForEndpoint("cmsGetContent")).toBe("content-read");
    expect(operationCategoryForEndpoint("cmsListContent")).toBe("content-list");
    expect(operationCategoryForEndpoint("cmsListAuthorPagePosts")).toBe(
      "content-read",
    );
    expect(operationCategoryForEndpoint("cmsSaveContent")).toBe("content-write");
    expect(operationCategoryForEndpoint("cmsRestoreRevision")).toBe(
      "revision-write",
    );
    expect(operationCategoryForEndpoint("cmsListMedia")).toBe("media-read");
    expect(operationCategoryForEndpoint("cmsGetVoiceoverAudio")).toBe("voiceover-read");
    expect(operationCategoryForEndpoint("cmsVoiceoverReview")).toBe("voiceover-write");
    expect(operationCategoryForEndpoint("cmsListMediaCategories")).toBe("media-read");
    expect(operationCategoryForEndpoint("cmsListMediaFavorites")).toBe("media-read");
    expect(operationCategoryForEndpoint("cmsListMediaCollections")).toBe("media-read");
    expect(operationCategoryForEndpoint("cmsListMediaCollectionItems")).toBe("media-read");
    expect(operationCategoryForEndpoint("cmsListBinnedMedia")).toBe("media-read");
    expect(operationCategoryForEndpoint("cmsRestoreMedia")).toBe("media-write");
    expect(operationCategoryForEndpoint("cmsMutateMediaCategory")).toBe("media-write");
    expect(operationCategoryForEndpoint("cmsSetMediaFavorite")).toBe("media-write");
    expect(operationCategoryForEndpoint("cmsMutateMediaCollection")).toBe("media-write");
    expect(operationCategoryForEndpoint("cmsSetMediaCollectionItems")).toBe("media-write");
    expect(operationCategoryForEndpoint("registerStaffProfile")).toBe(
      "admission",
    );
    expect(operationCategoryForEndpoint("somethingUnmapped")).toBe("other");
  });

  // The classifier named endpoints that the wrappers do not actually send: the page-preview
  // calls post `cmsPreview` and `cmsPreviewStatus`, so preview traffic was landing in `other`
  // while the contract claimed it was categorised. Read the real strings out of the transport
  // module so a renamed or added endpoint fails here instead of quietly losing its category.
  it("classifies every endpoint the transport module actually calls", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/functions.ts"),
      "utf8",
    );
    const endpoints = new Set<string>();
    for (const match of source.matchAll(
      /(?:postFunction|postMediaFile)(?:<[^>]*>)?\(\s*"([A-Za-z]+)"/g,
    )) {
      endpoints.add(match[1]!);
    }
    for (const match of source.matchAll(/\$\{baseUrl\}\/([A-Za-z]+)/g)) {
      endpoints.add(match[1]!);
    }

    expect(endpoints.size).toBeGreaterThan(20);
    expect(endpoints.has("cmsPreview")).toBe(true);
    expect(endpoints.has("cmsUploadMedia")).toBe(true);
    expect(endpoints.has("cmsReplaceMediaBinary")).toBe(true);
    expect(operationCategoryForEndpoint("cmsReplaceMediaBinary")).toBe("media-write");
    expect(operationCategoryForEndpoint("cmsRecheckPublication")).toBe("publish");
    expect(
      [...endpoints]
        .filter((endpoint) => operationCategoryForEndpoint(endpoint) === "other")
        .sort(),
    ).toEqual([]);
  });
});

describe("Admin performance recorder", () => {
  it("emits the bootstrap and admission phases once each", () => {
    const { sink, marks } = fakeSink();
    const recorder = createPerfRecorder(sink);

    recorder.phase("bootstrap");
    recorder.phase("bootstrap");
    recorder.phase("authResolved");
    recorder.phase("sessionSignedIn");
    recorder.phase("admissionComplete");
    recorder.phase("profileConfirmed");

    expect(marks.map((mark) => mark.name)).toEqual([
      PERF_MARKS.bootstrap,
      PERF_MARKS.authResolved,
      PERF_MARKS.sessionSignedIn,
      PERF_MARKS.admissionComplete,
      PERF_MARKS.profileConfirmed,
    ]);
  });

  it("measures each admitted boundary between its own phase marks", () => {
    const { sink, measures } = fakeSink();
    const recorder = createPerfRecorder(sink);

    recorder.phase("bootstrap");
    recorder.phase("authResolved");
    recorder.phase("sessionSignedIn");
    recorder.phase("admissionComplete");
    recorder.phase("profileConfirmed");

    expect(measures.map((measure) => measure.name)).toEqual([
      PERF_MEASURES.auth,
      PERF_MEASURES.admission,
      PERF_MEASURES.profile,
    ]);
    expect(measures.every((measure) => measure.duration > 0)).toBe(true);
  });

  // A signed-out first answer is still a resolved auth state, but the credential typing that
  // follows it is a person's time, not the server's. Admission has to start from the moment a
  // session exists or every interactive sign-in reports typing time as admission latency.
  it("measures admission from the signed-in session, not the signed-out answer", () => {
    const { sink, measures } = fakeSink();
    const recorder = createPerfRecorder(sink);

    recorder.phase("bootstrap"); // 100
    recorder.phase("authResolved"); // 200: signed out, the form is shown
    recorder.phase("sessionSignedIn"); // 300: credentials accepted
    recorder.phase("admissionComplete"); // 400

    const admission = measures.find(
      (measure) => measure.name === PERF_MEASURES.admission,
    );
    expect(admission?.duration).toBe(100);
    expect(
      measures.find((measure) => measure.name === PERF_MEASURES.auth)?.duration,
    ).toBe(100);
  });

  it("pairs a route load with one measure and a fixed mark name", () => {
    const { sink, marks, measures } = fakeSink();
    const recorder = createPerfRecorder(sink);

    const operation = recorder.begin("route-load", { route: "content" });
    operation.end({ outcome: "ok" });

    expect(marks.map((mark) => mark.name)).toEqual([
      PERF_MARKS.routeLoadStart,
      PERF_MARKS.routeLoadEnd,
    ]);
    expect(measures).toHaveLength(1);
    expect(measures[0]!.name).toBe(PERF_MEASURES.routeLoad);
    expect(measures[0]!.detail).toEqual({ route: "content", outcome: "ok" });
  });

  it("keeps concurrent CMS requests independent", () => {
    const { sink, measures } = fakeSink();
    const recorder = createPerfRecorder(sink);

    const first = recorder.begin("cms-request", { operation: "content-read" });
    const second = recorder.begin("cms-request", { operation: "content-list" });
    second.end({ outcome: "ok", statusClass: "2xx" });
    first.end({ outcome: "error", statusClass: "5xx" });

    expect(measures).toHaveLength(2);
    expect(measures[0]!.detail).toMatchObject({ operation: "content-list" });
    expect(measures[1]!.detail).toMatchObject({ operation: "content-read" });
    expect(measures[1]!.duration).toBeGreaterThan(measures[0]!.duration);
  });

  it("ignores a second end on the same operation", () => {
    const { sink, measures } = fakeSink();
    const recorder = createPerfRecorder(sink);

    const operation = recorder.begin("save", { operation: "content-write" });
    operation.end({ outcome: "ok" });
    operation.end({ outcome: "ok" });

    expect(measures).toHaveLength(1);
  });

  it("counts operations deterministically beside the measured timings", () => {
    const { sink } = fakeSink();
    const recorder = createPerfRecorder(sink);

    recorder.phase("bootstrap");
    recorder.begin("route-load", { route: "content" }).end({ outcome: "ok" });
    recorder.begin("cms-request", { operation: "content-read" }).end({
      outcome: "ok",
    });
    recorder.begin("cms-request", { operation: "content-list" }).end({
      outcome: "ok",
    });
    recorder.begin("save", { operation: "content-write" }).end({
      outcome: "ok",
    });

    const receipt = recorder.receipt();

    expect(receipt.schemaVersion).toBe(PERF_RECEIPT_SCHEMA_VERSION);
    expect(receipt.counts.routeLoad).toBe(1);
    expect(receipt.counts.cmsRequest).toBe(2);
    expect(receipt.counts.save).toBe(1);
    expect(receipt.counts.byOperation["content-read"]).toBe(1);
    expect(receipt.counts.byRoute.content).toBe(1);
    expect(receipt.measures.map((measure) => measure.name)).toContain(
      PERF_MEASURES.cmsTransport,
    );
  });

  // The harness settles a sample on this number. A start without its end is exactly the
  // slow-operation regression the receipt exists to expose, so it has to be visible rather
  // than silently absent from the measures.
  it("reports operations that started and have not finished", () => {
    const { sink } = fakeSink();
    const recorder = createPerfRecorder(sink);

    const slow = recorder.begin("cms-request", { operation: "content-read" });
    recorder.begin("route-load", { route: "content" }).end({ outcome: "ok" });

    expect(recorder.receipt().counts.open).toBe(1);

    slow.end({ outcome: "ok" });

    expect(recorder.receipt().counts.open).toBe(0);
  });

  it("survives a runtime with no User Timing support", () => {
    const recorder = createPerfRecorder(null);

    recorder.phase("bootstrap");
    const operation = recorder.begin("cms-request", {
      operation: "content-read",
    });
    operation.end({ outcome: "ok" });

    expect(recorder.receipt().counts.cmsRequest).toBe(1);
    expect(recorder.receipt().measures).toEqual([]);
  });
});

describe("performance detail sanitizer", () => {
  it("keeps only the accepted safe keys and vocabularies", () => {
    expect(
      sanitizePerfDetail({
        route: "content",
        operation: "content-write",
        outcome: "ok",
        statusClass: "2xx",
        requestId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
        build: "a1b2c3d",
      }),
    ).toEqual({
      route: "content",
      operation: "content-write",
      outcome: "ok",
      statusClass: "2xx",
      requestId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
      build: "a1b2c3d",
    });
  });

  it("drops unknown keys and values outside the vocabulary", () => {
    expect(
      sanitizePerfDetail({
        route: "/content/pages/home/edit",
        operation: "content-write",
        title: "Draft headline about Newark",
        email: "account-8@example.org",
        uid: "6mE1oQ2sVbTfKk9RzcJH8pWnA0x2",
        requestId: "not-a-uuid",
        ip: "203.0.113.7",
      }),
    ).toEqual({ operation: "content-write" });
  });
});
