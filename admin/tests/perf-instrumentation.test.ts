import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const appCheckToken = vi.hoisted(() => vi.fn(async () => "app-check-token"));

// functions.ts derives its base URL from the Firebase config. Mock the module so this suite
// times the transport without initializing a real Firebase app, and so the App Check boundary
// can be made to refuse on demand.
vi.mock("../src/lib/firebase", () => ({
  firebaseConfig: { projectId: "demo-njpbs" },
  getRequiredAppCheckToken: appCheckToken,
}));

import { adminPerf, PERF_MEASURES } from "../src/lib/perf-receipts";
import {
  cmsGetBroadcastSchedule,
  cmsGetNewsroomBanner,
  cmsUploadMedia,
  postFunction,
  RequestNotDispatchedError,
  submitStaffAccessRequest,
} from "../src/lib/functions";
import { preloadInitialRoute } from "../src/routes/routeModules";

const adminRoot = process.cwd();

function source(relativePath: string): string {
  return readFileSync(resolve(adminRoot, relativePath), "utf8");
}

function measures(name: string) {
  return adminPerf.receipt().measures.filter((entry) => entry.name === name);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Admin performance instrumentation", () => {
  it("times the addressed route module download by category", async () => {
    const before = adminPerf.receipt().counts.routeLoad;

    await preloadInitialRoute("/content/pages/home/edit", {
      accountSettings: async () => undefined,
      premiereConnect: async () => undefined,
      accountProfile: async () => undefined,
      authorProfiles: async () => undefined,
      adminSettings: async () => undefined,
      costs: async () => undefined,
      activity: async () => undefined,
      analytics: async () => undefined,
      content: async () => undefined,
    open: async () => undefined,
      postTemplates: async () => undefined,
    cuez: async () => undefined,
      dashboard: async () => undefined,
      media: async () => undefined,
      voiceovers: async () => undefined,
      notFound: async () => undefined,
      queue: async () => undefined,
      reports: async () => undefined,
      guide: async () => undefined,
      resources: async () => undefined,
      schedule: async () => undefined,
    liveProduction: async () => undefined,
      staff: async () => undefined,
    });

    const receipt = adminPerf.receipt();
    expect(receipt.counts.routeLoad).toBe(before + 1);
    const routeLoads = measures(PERF_MEASURES.routeLoad);
    expect(routeLoads.at(-1)!.detail).toMatchObject({
      route: "content",
      outcome: "ok",
    });
  });

  it("times a CMS call and carries the edge request receipt only", async () => {
    const requestId = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, heading: "Newsroom" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-njpbs-request-id": requestId,
          },
        }),
      ),
    );

    await cmsGetNewsroomBanner("test-id-token");

    const transport = measures(PERF_MEASURES.cmsTransport).at(-1)!;
    expect(transport.detail).toEqual({
      operation: "settings-read",
      outcome: "ok",
      statusClass: "2xx",
      requestId,
    });
    expect(transport.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("classifies the private schedule request as a schedule read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, source: {}, airings: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await cmsGetBroadcastSchedule("test-id-token");

    expect(measures(PERF_MEASURES.cmsTransport).at(-1)!.detail).toEqual({
      operation: "schedule-read",
      outcome: "ok",
      statusClass: "2xx",
    });
  });

  it("reports a refused CMS call without its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: "You cannot edit the Newark budget page" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(cmsGetNewsroomBanner("test-id-token")).rejects.toThrow();

    const transport = measures(PERF_MEASURES.cmsTransport).at(-1)!;
    expect(transport.detail).toEqual({
      operation: "settings-read",
      outcome: "denied",
      statusClass: "4xx",
    });
  });

  // The media upload posts its own multipart request rather than going through postFunction,
  // so it was the one CMS call with no transport measure -- and it is the slowest one.
  it("times the direct media upload transport", async () => {
    const before = adminPerf.receipt().counts.cmsRequest;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, asset: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await cmsUploadMedia(
      "test-id-token",
      new File(["x"], "newark-budget-hearing.jpg", { type: "image/jpeg" }),
      { category: "image", license: "public" },
    );

    expect(adminPerf.receipt().counts.cmsRequest).toBe(before + 1);
    expect(measures(PERF_MEASURES.cmsTransport).at(-1)!.detail).toMatchObject({
      operation: "media-write",
      outcome: "ok",
    });
  });

  it("closes the upload measure when the upload is canceled", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }),
    );

    await expect(
      cmsUploadMedia(
        "test-id-token",
        new File(["x"], "clip.mp4", { type: "video/mp4" }),
        { category: "image", license: "public" },
        controller.signal,
      ),
    ).rejects.toThrow();

    expect(adminPerf.receipt().counts.open).toBe(0);
    expect(measures(PERF_MEASURES.cmsTransport).at(-1)!.detail).toMatchObject({
      operation: "media-write",
      outcome: "aborted",
    });
  });

  // A failure acquiring the App Check token used to happen after the timing operation opened,
  // leaving a start with no end: a phantom request in the counts and an operation the harness
  // would wait forever to see close.
  it("does not open a transport measure when App Check refuses first", async () => {
    const before = adminPerf.receipt().counts;
    appCheckToken.mockRejectedValueOnce(
      new Error("Account-request protection is not configured"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );

    await expect(
      submitStaffAccessRequest("test-id-token", "I need access"),
    ).rejects.toBeInstanceOf(RequestNotDispatchedError);

    const after = adminPerf.receipt().counts;
    expect(after.cmsRequest).toBe(before.cmsRequest);
    expect(after.open).toBe(0);
  });

  it("does not send an aborted request after App Check arrives late", async () => {
    let resolveAppCheck!: (token: string) => void;
    appCheckToken.mockImplementationOnce(() => new Promise(resolve => { resolveAppCheck = resolve; }));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const request = postFunction("cmsStartSourceMediaUpload", "test-id-token", {}, {},
      { appCheck: true, signal: controller.signal });
    controller.abort();
    resolveAppCheck("late-app-check-token");
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the bootstrap, auth, admission, and confirmed-profile phases", () => {
    // Bootstrap is marked as the receipt module is evaluated, which happens before the entry
    // body runs and therefore before the route preload the entry's own imports start.
    expect(source("src/lib/perf-receipts.ts")).toContain(
      'adminPerf.phase("bootstrap")',
    );
    expect(source("src/main.tsx")).toContain("publishPerfProbe()");
    const authSource = source("src/context/AuthContext.tsx");
    expect(authSource).toContain('adminPerf.phase("authResolved")');
    expect(authSource).toContain('adminPerf.phase("sessionSignedIn")');
    expect(authSource).toContain('adminPerf.phase("admissionComplete")');
    expect(authSource).toContain('adminPerf.phase("profileConfirmed")');
  });

  it("marks the editor mount only inside the deferred editor graph", () => {
    expect(source("src/components/ContentTab.tsx")).not.toContain(
      'adminPerf.phase("editorMounted")',
    );
    expect(source("src/components/EditorWorkspace.tsx")).toContain(
      'adminPerf.phase("editorMounted")',
    );
    // Readiness is not the content request resolving: it is the editor committing a ready
    // state. Keep the mark out of the loader wrappers so a stale, discarded response cannot
    // consume the once-only mark before anything is on screen.
    expect(source("src/components/ContentTab.tsx")).not.toContain(
      'adminPerf.phase("editorReady")',
    );
    expect(source("src/components/EditorWorkspace.tsx")).toContain(
      'adminPerf.phase("editorReady")',
    );
  });

  it("times the page save transaction across its whole commit", () => {
    const workspaceSource = source("src/components/EditorWorkspace.tsx");
    expect(workspaceSource).toContain('adminPerf.begin("save"');
    expect(workspaceSource).toContain('operation: "content-write"');
  });
});
