import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// functions.ts imports firebaseConfig to derive the emulator base URL. Mock the module so
// the test does not initialize a real Firebase app; the projectId is all the URL needs.
vi.mock("../src/lib/firebase", () => ({
  firebaseConfig: { projectId: "demo-njpbs" },
  getRequiredAppCheckToken: vi.fn(async () => "app-check-token"),
}));

import {
  cmsAssignContent,
  cmsBulkArchiveContent,
  cmsDeleteMedia,
  cmsListBinnedMedia,
  cmsRestoreMedia,
  type BinnedMediaAsset,
  cmsGetBroadcastSchedule,
  cmsGetContent,
  cmsGetNewsroomBanner,
  cmsGetRevision,
  cmsGetSettings,
  cmsGetCoverageLabels,
  cmsListAudit,
  cmsListContent,
  cmsListMedia,
  cmsListMediaCorpus,
  cmsListRevisions,
  cmsLoadPagePreviewStatus,
  cmsPublish,
  cmsRequestPagePreview,
  cmsPublishSettings,
  cmsRestoreRevision,
  cmsSaveContent,
  cmsSubmitBugReport,
  type BugReportSubmission,
  cmsSaveSettings,
  cmsTransitionContent,
  cmsUploadMedia,
  cmsReplaceMediaBinary,
  cmsUpdateMediaMetadata,
  deactivateStaff,
  decideStaffAccessRequest,
  getStaffAccessStatus,
  grantRole,
  listStaffAccessRequests,
  registerStaffProfile,
  postFunction,
  requestStaffPasswordReset,
  submitStaffAccessRequest,
  type MediaAssetSummary,
} from "../src/lib/functions";
import { beginSessionScope, bindSessionToken, SESSION_ENDED_EVENT } from "../src/lib/session-ended";

describe("ended session transport contract", () => {
  const sessionToken = `header.${btoa(JSON.stringify({ sub: "ana", auth_time: 100 }))}.signature`;
  const ended = vi.fn();
  beforeEach(() => {
    ended.mockReset();
    // The Functions runner also runs this file, in Node, where the module's event target is absent.
    if (typeof window === "undefined") vi.stubGlobal("window", new EventTarget());
    beginSessionScope(true);
    bindSessionToken(sessionToken);
    window.addEventListener(SESSION_ENDED_EVENT, ended);
  });
  afterEach(() => {
    beginSessionScope(false);
    window.removeEventListener(SESSION_ENDED_EVENT, ended);
  });

  it.each(["json", "upload", "report"])("ends the session once for a rejected %s request without retrying it", async (kind) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Invalid or expired authentication token", code: "session_expired" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = kind === "json" ? postFunction("cmsStartSourceMediaUpload", sessionToken, {})
      : kind === "upload" ? cmsUploadMedia(sessionToken, new File(["image"], "test.png"), { category: "general" })
      : cmsSubmitBugReport(sessionToken, { happened: "The upload failed.", consoleLogs: [] } as unknown as BugReportSubmission, "request-id", null);
    await expect(request).rejects.toMatchObject({ status: 401, message: "Your session ended. Sign in again." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("keeps a permission refusal separate from an ended session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "You cannot upload here" }), { status: 403 })));
    await expect(postFunction("cmsStartSourceMediaUpload", "token", {}))
      .rejects.toMatchObject({ status: 403, message: "You cannot upload here" });
    expect(ended).not.toHaveBeenCalled();
  });

  it.each(["Missing App Check token", "Invalid App Check token", "Video search corpus is unavailable",
    "Transcription credential access denied", "You do not have access to this item."])("keeps uncoded %s separate from an ended session", async (message) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: message }), { status: 401 })));
    await expect(postFunction("cmsStartSourceMediaUpload", "token", {}))
      .rejects.toMatchObject({ status: 401, message });
    expect(ended).not.toHaveBeenCalled();
  });
});

// In vitest import.meta.env.DEV is true, so functions.ts runs in emulator mode and posts to
// the local functions emulator for the mocked projectId.
const BASE = "http://127.0.0.1:5001/demo-njpbs/us-central1";

it("preserves Retry-After on a rate-limited JSON request", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Wait" }), {
    status: 429, headers: { "content-type": "application/json", "retry-after": "37" },
  })));
  await expect(postFunction("cmsGetVideoSearchCorpus", "token", { action: "manifest" }))
    .rejects.toMatchObject({ status: 429, data: { error: "Wait", retryAfterSeconds: 37 } });
});

describe("App Check for automation account reads", () => {
  it("sends a transcript or search read without a token when browser verification fails", async () => {
    const { getRequiredAppCheckToken } = await import("../src/lib/firebase");
    vi.mocked(getRequiredAppCheckToken).mockRejectedValueOnce(new Error("Browser verification failed"));
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    await postFunction("cmsGetVideoTranscript", "token", {}, {}, { appCheck: "unless-automation" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("X-Firebase-AppCheck");
  });

  it("shows staff the browser verification refusal when the server requires App Check", async () => {
    const { getRequiredAppCheckToken } = await import("../src/lib/firebase");
    vi.mocked(getRequiredAppCheckToken).mockRejectedValueOnce(new Error("Browser verification failed"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Missing App Check token" }), { status: 401 })));
    await expect(postFunction("cmsGetVideoTranscript", "token", {}, {}, { appCheck: "unless-automation" }))
      .rejects.toMatchObject({ name: "RequestNotDispatchedError", message: "Browser verification failed" });
  });

  it("never sends any other App Check request without a token", async () => {
    const { getRequiredAppCheckToken } = await import("../src/lib/firebase");
    vi.mocked(getRequiredAppCheckToken).mockRejectedValueOnce(new Error("Browser verification failed"));
    const fetchMock = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(postFunction("cmsSaveVideoTranscript", "token", {}, {}, { appCheck: true }))
      .rejects.toMatchObject({ name: "RequestNotDispatchedError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("image bin API", () => {
  it("requests only a bounded corpus batch through the existing media endpoint", async () => {
    const response = { success: true, records: [], nextCursor: "next" };
    const fetchMock = vi.fn(async () => okResponse(response));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await expect(cmsListMediaCorpus("token", { limit: 500, cursor: "previous" }, controller.signal)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/cmsListMedia`, expect.objectContaining({
      body: JSON.stringify({ limit: 500, cursor: "previous", corpus: true }), signal: controller.signal,
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }));
  });

  it("posts bounded page options and forwards cancellation", async () => {
    const response = { success: true, records: [], total: 0, page: 1, pageCount: 1 };
    const fetchMock = vi.fn(async () => okResponse(response));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await expect(cmsListBinnedMedia("token", { page: 2, pageSize: 30 }, controller.signal)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/cmsListBinnedMedia`, expect.objectContaining({
      body: JSON.stringify({ page: 2, pageSize: 30 }), signal: controller.signal,
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }));
  });
  it("restores with the strong ETag and invalidates cached lists and counts", async () => {
    const cache = await import("../src/lib/media-session-cache");
    const revision = cache.mediaListRevision();
    cache.setMediaImagesCount(10, revision);
    const row = { id: "binned", etag: '"media.YmlubmVk.4"' } as BinnedMediaAsset;
    const response = { success: true, changed: true, asset: { id: row.id, lifecycle: "active", version: 5, etag: '"media.YmlubmVk.5"' } };
    const fetchMock = vi.fn(async () => okResponse(response));
    vi.stubGlobal("fetch", fetchMock);
    await expect(cmsRestoreMedia("token", row)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/cmsRestoreMedia`, expect.objectContaining({
      body: JSON.stringify({ assetId: "binned" }),
      headers: expect.objectContaining({ "If-Match": row.etag, Authorization: "Bearer token" }),
    }));
    expect(cache.mediaListRevision()).toBeGreaterThan(revision);
    expect(cache.mediaTabCounts().images).toBeUndefined();
  });
  it("preserves server refusal details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(409, { error: "The active media library is full." })));
    await expect(cmsRestoreMedia("token", { id: "photo", etag: '"media.photo.2"' } as BinnedMediaAsset)).rejects.toMatchObject({ status: 409, message: "The active media library is full." });
  });
});

function okResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    statusText: "Bad Request",
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("registerStaffProfile", () => {
  it("posts an empty authenticated registration request", async () => {
    const result = {
      success: true as const,
      uid: "outside-1",
      created: true,
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(registerStaffProfile("id-token")).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/registerStaffProfile`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({});
  });
});

describe("staff access request API", () => {
  it("requests password recovery with App Check and no bearer token", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse({ success: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestStaffPasswordReset("person@example.org"),
    ).resolves.toEqual({ success: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/requestStaffPasswordReset`);
    expect(init.headers).toMatchObject({
      "X-Firebase-AppCheck": "app-check-token",
    });
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      email: "person@example.org",
    });
  });

  it("submits only the bounded reason with App Check", async () => {
    const result = {
      success: true as const,
      request: {
        state: "pending" as const,
        requestVersion: 1,
        reference: "NJPBS-USER-1",
        role: null,
        requestedAt: null,
        decidedAt: null,
        emailVerified: true,
      },
      mailState: "sent",
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitStaffAccessRequest("id-token", "I edit program pages."),
    ).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/submitStaffAccessRequest`);
    expect(init.headers).toMatchObject({
      Authorization: "Bearer id-token",
      "X-Firebase-AppCheck": "app-check-token",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      reason: "I edit program pages.",
    });
  });

  it("gets only the signed-in request status", async () => {
    const result = {
      success: true as const,
      request: {
        state: "not_requested" as const,
        requestVersion: null,
        reference: null,
        role: null,
        requestedAt: null,
        decidedAt: null,
        emailVerified: true,
      },
      mailState: "not_queued",
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getStaffAccessStatus("id-token");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/getStaffAccessStatus`);
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("lists and decides requests through separate endpoints", async () => {
    const fetchMock = vi
      .fn(async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse({}),
      )
      .mockResolvedValueOnce(okResponse({ success: true, requests: [] }))
      .mockResolvedValueOnce(
        okResponse({
          success: true,
          request: {
            state: "ready",
            requestVersion: 2,
            reference: "NJPBS-USER-2",
            role: "editor",
            requestedAt: null,
            decidedAt: null,
            emailVerified: true,
          },
          mailState: "sent",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await listStaffAccessRequests("joe-token");
    await decideStaffAccessRequest("joe-token", {
      targetUid: "requester-1",
      requestVersion: 2,
      decision: "approve",
      role: "editor",
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/listStaffAccessRequests`);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      `${BASE}/decideStaffAccessRequest`,
    );
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({
      targetUid: "requester-1",
      requestVersion: 2,
      decision: "approve",
      role: "editor",
    });
  });
});

describe("newsroom settings functions", () => {
  it("loads the private broadcast schedule through the admitted staff boundary", async () => {
    const result = {
      success: true as const,
      source: {
        coverageStart: "2026-10-01",
        coverageEnd: "2026-11-05",
        label: "Synthetic broadcast packet A",
        received: "2026-09-01",
        timezone: "America/New_York",
      },
      airings: [],
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cmsGetBroadcastSchedule("id-token")).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsGetBroadcastSchedule`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("loads the safe banner projection for every admitted homepage", async () => {
    const result = {
      success: true as const,
      heading: "Admin interface and user experience",
      milestoneNumber: 16,
      source: "default" as const,
      version: null,
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cmsGetNewsroomBanner("id-token")).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsGetNewsroomBanner`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("loads and saves the manager-only newsroom settings document", async () => {
    const getResult = {
      success: true as const,
      found: true as const,
      id: "newsroom-home",
      settings: {
        schemaVersion: 1,
        values: { bannerHeading: "Admin interface and user experience" },
        version: 2,
      },
    };
    const saveResult = {
      success: true as const,
      changed: true,
      id: "newsroom-home",
      settings: { ...getResult.settings, version: 3 },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse(getResult))
      .mockResolvedValueOnce(okResponse(saveResult));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cmsGetSettings("id-token", { id: "newsroom-home" }),
    ).resolves.toEqual(getResult);
    await expect(
      cmsSaveSettings("id-token", {
        id: "newsroom-home",
        values: { bannerHeading: "Preparing the newsroom publishing workflow" },
        baseVersion: 2,
      }),
    ).resolves.toEqual(saveResult);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}/cmsGetSettings`,
      `${BASE}/cmsSaveSettings`,
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      id: "newsroom-home",
    });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({
      id: "newsroom-home",
      values: { bannerHeading: "Preparing the newsroom publishing workflow" },
      baseVersion: 2,
    });
  });
});

describe("cmsListContent", () => {
  it("posts the canonical query to the authenticated list endpoint", async () => {
    const selection = {
      success: true as const,
      records: [],
      total: 0,
      allCount: 0,
      mineCount: 0,
      assignedCount: 0,
      page: 1,
      pageCount: 1,
      statusCounts: {
        draft: 0,
        in_review: 0,
        scheduled: 0,
        published: 0,
        archived: 0,
      },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(selection),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cmsListContent("id-token", "owner=me&page=2&v=1"),
    ).resolves.toEqual(selection);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsListContent`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      query: "owner=me&page=2&v=1",
    });
  });
});

describe("media library functions", () => {
  const asset: MediaAssetSummary = {
    id: "asset-one",
    name: "Studio control room",
    originalName: "studio.png",
    category: "news",
    categories: ["news"],
    tags: ["studio"],
    description: null,
    altText: "Monitors in a control room",
    license: "NJ PBS owned",
    credit: "NJ PBS",
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 128,
    width: 1,
    height: 1,
    url: "https://media.njpbs.org/studio.png",
    lifecycle: "active",
    version: 2,
    etag: '"media.YXNzZXQtb25l.2"',
    createdAt: "2026-08-13T12:00:00.000Z",
    createdBy: "editor-1",
    updatedAt: "2026-08-13T12:00:00.000Z",
    updatedBy: "editor-1",
  };

  it("posts structured filters to the media list endpoint", async () => {
    const result = {
      success: true as const,
      records: [asset],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cmsListMedia("id-token", {
        q: "studio",
        categories: ["news"],
        kinds: ["image"],
        page: 2,
      }),
    ).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsListMedia`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      q: "studio",
      categories: ["news"],
      kinds: ["image"],
      page: 2,
      paging: "cursor",
    });
  });

  it("keeps exact-id and self-profile media reads on legacy paging", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> => okResponse({
        success: true,
        records: [asset],
        total: 1,
        allCount: 1,
        page: 1,
        pageCount: 1,
        categoryCounts: { news: 1 },
        kindCounts: { image: 1, document: 0 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await cmsListMedia("id-token", { assetIds: [asset.id] });
    await cmsListMedia("id-token", { profilePhotoScope: "self" });

    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string)))
      .toEqual([{ assetIds: [asset.id] }, { profilePhotoScope: "self" }]);
  });

  it("sends the selected asset ETag with an allowed metadata patch", async () => {
    const result = {
      success: true as const,
      changed: true,
      asset: { ...asset, version: 3 },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cmsUpdateMediaMetadata("id-token", asset, {
        originalName: "main-control-room.png",
        name: "Main control room",
        tags: ["studio", "switcher"],
      }),
    ).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(`${BASE}/cmsUpdateMediaMetadata`);
    expect(headers.Authorization).toBe("Bearer id-token");
    expect(headers["If-Match"]).toBe(asset.etag);
    expect(JSON.parse(init.body as string)).toEqual({
      assetId: "asset-one",
      metadata: {
        originalName: "main-control-room.png",
        name: "Main control room",
        tags: ["studio", "switcher"],
      },
    });
  });

  it("sends the selected asset ETag with a media library delete", async () => {
    const result = {
      success: true as const,
      changed: true as const,
      deleted: true as const,
      asset: {
        id: asset.id,
        lifecycle: "tombstoned" as const,
        version: 3,
        etag: '"media.YXNzZXQtb25l.3"',
      },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cmsDeleteMedia("id-token", asset)).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(`${BASE}/cmsUpdateMediaMetadata`);
    expect(headers.Authorization).toBe("Bearer id-token");
    expect(headers["If-Match"]).toBe(asset.etag);
    expect(JSON.parse(init.body as string)).toEqual({
      assetId: "asset-one",
      action: "delete",
    });
  });

  it("replaces with the strong asset ETag and multipart fields, preserving the returned version", async () => {
    const result = { success: true, changed: true, asset: { ...asset, version: 3, etag: '\"next.3\"' } };
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => okResponse(result));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["image bytes"], "replacement.png", { type: "image/png" });
    await expect(cmsReplaceMediaBinary("id-token", asset, file, true)).resolves.toEqual(result);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsReplaceMediaBinary`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer id-token", "X-NJPBS-CMS-Edge": "local-cms-edge-only", "If-Match": asset.etag });
    const body = init.body as FormData;
    expect([...body.keys()]).toEqual(["file", "assetId", "imageProcessing"]);
    expect(body.get("file")).toStrictEqual(file);
    expect(body.get("assetId")).toBe(asset.id);
    expect(body.get("imageProcessing")).toBe("webp");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["news", "image/png", false],
    ["staff-profile", "image/jpeg", true],
    ["news", "image/gif", true],
  ])("omits processing for %s %s optimize=%s", async (category, type, optimize) => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => okResponse({ success: true, changed: false, asset }));
    vi.stubGlobal("fetch", fetchMock);
    await cmsReplaceMediaBinary("id-token", { ...asset, category }, new File(["bytes"], "image", { type }), optimize);
    expect((fetchMock.mock.calls[0]![1].body as FormData).has("imageProcessing")).toBe(false);
  });

  it.each([400, 409, 412, 413, 428, 503])("preserves replacement refusal status %s and server details", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(status, { error: "Server refusal", retryable: true })));
    await expect(cmsReplaceMediaBinary("id-token", asset, new File(["image"], "image.png", { type: "image/png" }), false))
      .rejects.toMatchObject({ status, message: "Server refusal", data: { error: "Server refusal", retryable: true } });
  });

  it("sends one authenticated multipart media upload without a manual content type", async () => {
    const result = { success: true as const, asset };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["image bytes"], "studio.png", { type: "image/png" });

    await expect(
      cmsUploadMedia("id-token", file, {
        category: "news",
        license: "NJ PBS owned",
        tags: ["studio"],
        imageProcessing: "webp",
        metadataUpdateRequested: true,
      }),
    ).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(`${BASE}/cmsUploadMedia`);
    expect(headers).toEqual({
      Authorization: "Bearer id-token",
      "X-NJPBS-CMS-Edge": "local-cms-edge-only",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeInstanceOf(FormData);
    const body = init.body as FormData;
    expect(body.get("file")).toStrictEqual(file);
    expect(body.get("category")).toBe("news");
    expect(body.get("license")).toBe("NJ PBS owned");
    expect(body.get("tags")).toBe('["studio"]');
    expect(body.get("imageProcessing")).toBe("webp");
    expect(body.get("metadataUpdateRequested")).toBe("true");
  });

  it("returns the upload API error without exposing response parsing details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        errorResponse(413, {
          error: "Choose a file that is 25 MB or smaller.",
        }),
      ),
    );
    const file = new File(["image bytes"], "studio.png", {
      type: "image/png",
    });

    await expect(
      cmsUploadMedia("id-token", file, {
        category: "news",
        license: "NJ PBS owned",
      }),
    ).rejects.toMatchObject({
      status: 413,
      message: "Choose a file that is 25 MB or smaller.",
    });
  });
});

describe("cmsListAudit", () => {
  it("posts an optional opaque cursor to the authenticated audit endpoint", async () => {
    const result = {
      success: true as const,
      entries: [],
      nextCursor: null,
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cmsListAudit("id-token", "opaque-cursor")).resolves.toEqual(
      result,
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsListAudit`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      cursor: "opaque-cursor",
    });
  });
});

describe("cmsGetContent", () => {
  it("posts an addressed collection read to the authenticated content endpoint", async () => {
    const result = {
      success: true as const,
      found: true,
      document: { id: "home", type: "page", version: 3 },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cmsGetContent("id-token", { collection: "cmsPages", id: "home" }),
    ).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsGetContent`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      collection: "cmsPages",
      id: "home",
    });
  });
});

describe("revision history", () => {
  it("posts an addressed record and optional cursor to the summary endpoint", async () => {
    const result = {
      success: true as const,
      entries: [],
      nextCursor: null,
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cmsListRevisions("id-token", {
        collection: "cmsPages",
        id: "home",
        cursor: "opaque-cursor",
      }),
    ).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsListRevisions`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      collection: "cmsPages",
      id: "home",
      cursor: "opaque-cursor",
    });
  });

  it("posts the immutable revision id to the full-row endpoint", async () => {
    const result = {
      success: true as const,
      revision: {
        id: "revision-1",
        collection: "cmsPosts" as const,
        documentId: "post-1",
        action: "update",
        actorUid: "editor-1",
        actorEmail: "account-8@example.org",
        at: "2026-08-12T20:15:00.000Z",
        before: { title: "Before" },
        after: { title: "After" },
        beforeTruncated: false,
      },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cmsGetRevision("id-token", {
        collection: "cmsPosts",
        id: "post-1",
        revisionId: "revision-1",
      }),
    ).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsGetRevision`);
    expect(JSON.parse(init.body as string)).toEqual({
      collection: "cmsPosts",
      id: "post-1",
      revisionId: "revision-1",
    });
  });

  it("posts the selected revision and exact current version to the restore endpoint", async () => {
    const result = {
      success: true as const,
      collection: "cmsPages" as const,
      id: "home",
      revisionId: "new-revision",
      sourceRevisionId: "revision-1",
      sourceVersion: 2,
      version: 5,
      document: { id: "home", title: "Restored title", version: 5 },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cmsRestoreRevision("id-token", {
        collection: "cmsPages",
        id: "home",
        revisionId: "revision-1",
        baseVersion: 4,
      }),
    ).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsRestoreRevision`);
    expect(JSON.parse(init.body as string)).toEqual({
      collection: "cmsPages",
      id: "home",
      revisionId: "revision-1",
      baseVersion: 4,
    });
  });
});

describe("revision restore errors", () => {
  it("preserves the pre-migration refusal message for staff", async () => {
    const message = "That revision was saved before this page's layout was migrated. Restore a revision saved after the layout migration.";
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(400, { error: message })));

    await expect(cmsRestoreRevision("id-token", {
      collection: "cmsPages", id: "support", revisionId: "revision-1", baseVersion: 8,
    })).rejects.toMatchObject({ status: 400, message });
  });
});

describe("cmsBulkArchiveContent", () => {
  it("posts exact record versions to the authenticated bulk endpoint", async () => {
    const result = {
      success: true as const,
      outcomes: [
        { id: "a-1", status: "archived" as const, version: 4 },
        { id: "a-2", status: "conflict" as const },
      ],
      counts: {
        archived: 1,
        already_archived: 0,
        conflict: 1,
        missing: 0,
        failed: 0,
      },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cmsBulkArchiveContent("id-token", [
        { id: "a-1", baseVersion: 3 },
        { id: "a-2", baseVersion: 8 },
      ]),
    ).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsBulkArchiveContent`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      items: [
        { id: "a-1", baseVersion: 3 },
        { id: "a-2", baseVersion: 8 },
      ],
    });
  });
});

describe("cmsTransitionContent", () => {
  it("posts one exact lifecycle action and current version", async () => {
    const result = {
      success: true as const,
      collection: "cmsPages" as const,
      id: "watch",
      action: "unpublish" as const,
      fromStatus: "published" as const,
      toStatus: "draft" as const,
      version: 5,
      document: { id: "watch", status: "draft", version: 5 },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cmsTransitionContent("id-token", {
        collection: "cmsPages",
        id: "watch",
        action: "unpublish",
        baseVersion: 4,
      }),
    ).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsTransitionContent`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      collection: "cmsPages",
      id: "watch",
      action: "unpublish",
      baseVersion: 4,
    });
  });
});

describe("cmsAssignContent", () => {
  it("posts one exact record version and nullable assignee", async () => {
    const result = {
      success: true as const,
      id: "a-1",
      document: { id: "a-1", assignee: "editor-2", version: 4 },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cmsAssignContent("id-token", {
        id: "a-1",
        baseVersion: 3,
        assignee: "editor-2",
      }),
    ).resolves.toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/cmsAssignContent`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      id: "a-1",
      baseVersion: 3,
      assignee: "editor-2",
    });
  });
});

describe("CMS page preview", () => {
  it("requests one canonical page and polls one opaque queue id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          success: true,
          queueId: "queue123",
          pageId: "contact",
          sourceVersion: 7,
          dispatched: true,
          status: "building",
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          success: true,
          queueId: "queue123",
          pageId: "contact",
          sourceVersion: 7,
          status: "ready",
          previewUrl: "https://abc123.njpbs-preview.pages.dev",
          error: null,
          requestedAt: "2026-07-23T12:00:00.000Z",
          completedAt: "2026-07-23T12:01:00.000Z",
          expiresAt: "2026-07-30T12:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await cmsRequestPagePreview("id-token", "contact");
    await cmsLoadPagePreviewStatus("id-token", "queue123");

    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/cmsPreview`);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
      pageId: "contact",
    });
    expect(fetchMock.mock.calls[1]![0]).toBe(`${BASE}/cmsPreviewStatus`);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({
      queueId: "queue123",
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer id-token",
      );
    }
  });
});

describe("cmsSaveContent", () => {
  it("posts the document to cmsSaveContent with the bearer token and returns the result", async () => {
    const persisted = {
      success: true,
      collection: "cmsPages",
      id: "home",
      created: true,
      mintedIds: { "temp-1": "srv-1" },
      document: { id: "home", blocks: [{ id: "srv-1", type: "headline" }] },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(persisted),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await cmsSaveContent("id-token", {
      collection: "cmsPages",
      id: "home",
      document: { blocks: [{ id: "temp-1", type: "headline" }] },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(`${BASE}/cmsSaveContent`);
    expect(init.method).toBe("POST");
    expect(headers.Authorization).toBe("Bearer id-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      collection: "cmsPages",
      id: "home",
      document: { blocks: [{ id: "temp-1", type: "headline" }] },
    });
    // The caller adopts the returned document's server-owned block ids.
    expect(result.document).toEqual(persisted.document);
    expect(result.mintedIds).toEqual({ "temp-1": "srv-1" });
    expect(result.created).toBe(true);
  });

  it("derives a positional id receipt only for an older save response without mintedIds", async () => {
    const persisted = {
      success: true,
      collection: "cmsPages",
      id: "home",
      created: false,
      document: {
        id: "home",
        blocks: [
          { id: "srv-1", type: "headline" },
          { id: "srv-2", type: "divider" },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => okResponse(persisted)),
    );

    const result = await cmsSaveContent("id-token", {
      collection: "cmsPages",
      id: "home",
      document: {
        blocks: [
          { id: "temp-1", type: "headline" },
          { id: "temp-2", type: "divider" },
        ],
      },
    });

    expect(result.mintedIds).toEqual({
      "temp-1": "srv-1",
      "temp-2": "srv-2",
    });
  });

  it("throws the server's error message when the save is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        errorResponse(400, {
          error:
            "Save cannot publish a document; publishing is a separate action",
        }),
      ),
    );

    await expect(
      cmsSaveContent("id-token", {
        collection: "cmsPages",
        id: "home",
        document: { status: "published" },
      }),
    ).rejects.toThrow(
      "Save cannot publish a document; publishing is a separate action",
    );
  });

  it("falls back to the status code when the error body carries no message", async () => {
    // A valid-but-empty JSON error body has no `error` field, so the message stays the
    // status-code default rather than inventing a reason.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init: RequestInit): Promise<Response> =>
        errorResponse(503, {}),
      ),
    );

    await expect(
      cmsSaveContent("id-token", { collection: "cmsPosts", document: {} }),
    ).rejects.toThrow("Request failed with 503");
  });

  it("falls back to the status text when the error body is not JSON", async () => {
    // A non-JSON body makes response.json() throw, so the message uses the status text.
    const nonJson = {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, _init: RequestInit): Promise<Response> => nonJson,
      ),
    );

    await expect(
      cmsSaveContent("id-token", { collection: "cmsPosts", document: {} }),
    ).rejects.toThrow("Bad Gateway");
  });
});

describe("grantRole (shared post helper regression)", () => {
  it("posts to the grantRole endpoint through the same helper", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse({ success: true, uid: "u1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await grantRole("id-token", {
      targetUid: "u1",
      role: "editor",
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/grantRole`);
    expect(result).toEqual({ success: true, uid: "u1" });
  });
});

describe("deactivateStaff", () => {
  it("posts the exact target uid to the authenticated offboarding endpoint", async () => {
    const result = {
      success: true as const,
      uid: "staff-1",
      alreadyInactive: false,
      authUserMissing: false,
    };
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(result),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(deactivateStaff("id-token", "staff-1")).resolves.toEqual(
      result,
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/deactivateStaff`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer id-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({ targetUid: "staff-1" });
  });
});

describe("CMS settings API", () => {
  it.each(["public-homepage-banner", "public-site-chrome", "site-navigation", "nj-decides-brand", "coverage-labels"])(
    "marks %s for atomic publication with one request", async (id) => {
      const fetchMock = vi.fn(async (): Promise<Response> => okResponse({ success: true }));
      vi.stubGlobal("fetch", fetchMock);
      await cmsPublishSettings("id-token", { id, baseVersion: 4 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${BASE}/cmsPublishSettings`);
      expect(JSON.parse(init.body as string)).toEqual({ id, baseVersion: 4,
        publicationTransport: "public-context-no-build-v1" });
    },
  );

  it("reads only published coverage choices and forwards cancellation", async () => {
    const published = { schemaVersion: 1, sourceVersion: 2, publishedAt: "2026-10-29T12:00:00.000Z", values: { labels: [
      { id: "election", name: "Election coverage", textColor: "#011375", backgroundColor: "#e9eaee", retired: false },
    ] } };
    const fetchMock = vi.fn(async () => okResponse({ success: true, id: "coverage-labels", found: true, published,
      values: { labels: [{ name: "PRIVATE DRAFT" }] } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const result = await cmsGetCoverageLabels("id-token", controller.signal);
    expect(result?.labels).toEqual(published.values.labels);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/cmsGetCoverageLabels`, expect.objectContaining({
      body: JSON.stringify({ id: "coverage-labels" }), signal: controller.signal,
    }));
  });

  it("omits an unpublished registry and rejects malformed published choices", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okResponse({ success: true, id: "coverage-labels", found: false }))
      .mockResolvedValueOnce(okResponse({ success: true, id: "coverage-labels", found: true, published: { values: { labels: [] } } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(cmsGetCoverageLabels("id-token")).resolves.toBeUndefined();
    await expect(cmsGetCoverageLabels("id-token")).rejects.toThrow("Published coverage labels are invalid.");
  });

  it("uses the closed settings endpoints and exact version guards", async () => {
    const responses = [
      { success: true, found: false, id: "newsroom-home" },
      { success: true, id: "newsroom-home", changed: true, settings: {} },
      { success: true, id: "newsroom-home", changed: true, settings: {} },
      {
        success: true,
        queueId: "public-banner-3",
        dispatched: true,
        status: "publishing",
        message: "Publish queued.",
      },
    ];
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        okResponse(responses.shift()),
    );
    vi.stubGlobal("fetch", fetchMock);

    await cmsGetSettings("id-token", { id: "newsroom-home" });
    await cmsSaveSettings("id-token", {
      id: "newsroom-home",
      values: { bannerHeading: "Preparing the newsroom publishing workflow" },
      createOnly: true,
    });
    await cmsPublishSettings("id-token", {
      id: "newsroom-home",
      baseVersion: 3,
    });
    await cmsPublish(
      "id-token",
      [
        {
          collection: "cmsSettings",
          id: "public-homepage-banner",
          sourceVersion: 3,
        },
      ],
      { runtimeFirst: true },
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}/cmsGetSettings`,
      `${BASE}/cmsSaveSettings`,
      `${BASE}/cmsPublishSettings`,
      `${BASE}/cmsPublish`,
    ]);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string)),
    ).toEqual([
      { id: "newsroom-home" },
      {
        id: "newsroom-home",
        values: { bannerHeading: "Preparing the newsroom publishing workflow" },
        createOnly: true,
      },
      { id: "newsroom-home", baseVersion: 3 },
      {
        changes: [
          {
            collection: "cmsSettings",
            id: "public-homepage-banner",
            sourceVersion: 3,
          },
        ],
        runtimeFirst: true,
      },
    ]);
  });
});


it("keeps escaped report evidence within the multipart field limit", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, created: true, report: { id: "report-1" } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const submission = {
    category: "bug", severity: "work_impaired", area: "other", tryingToDo: "", happened: "A detailed report.", expected: "", route: "/content", correlationIds: [],
    clientContext: { browser: "Browser", operatingSystem: "System", viewport: { width: 1000, height: 800 }, online: true, timeZone: "UTC" },
    consoleLogs: Array.from({ length: 100 }, (_, index) => ({ level: "error", message: '"'.repeat(1000), timestamp: new Date(index * 1000).toISOString() })),
  } satisfies BugReportSubmission;
  await cmsSubmitBugReport("id-token", submission, "request-1", null);
  const form = fetchMock.mock.calls[0][1].body as FormData;
  const serialized = String(form.get("report"));
  expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(120 * 1024);
  const sent = JSON.parse(serialized);
  expect(sent.consoleLogs.length).toBeLessThan(100);
  expect(sent.consoleLogs.at(-1)).toEqual(submission.consoleLogs.at(-1));
  expect(submission.consoleLogs).toHaveLength(100);
});

it.each(["development", "production", "emulator"])("sends the Admin build revision only for %s report intake", async (environment) => {
  vi.stubEnv("VITE_CMS_DEPLOYMENT_ENVIRONMENT", environment);
  vi.stubGlobal("__ADMIN_SOURCE_REVISION__", "a".repeat(40));
  try {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, report: { id: "report-1" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const submission = {
      severity: "work_impaired", area: "other", tryingToDo: "", happened: "The guide did not open.", expected: "", route: "/guide", correlationIds: [], consoleLogs: [],
      clientContext: { browser: "Browser", operatingSystem: "System", viewport: { width: 1000, height: 800 }, online: true, timeZone: "UTC" },
    } satisfies BugReportSubmission;
    await cmsSubmitBugReport("id-token", submission, "request-1", null);
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("adminBuildRevision")).toBe(environment === "development" ? "a".repeat(40) : null);
    expect(JSON.parse(String(form.get("report")))).toEqual(submission);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("a malformed enabled reader manifest refuses only the adopting endpoint", async () => {
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubEnv("VITE_CMS_READER_BRIDGE_ENABLED", "true");
  vi.stubEnv("VITE_CMS_READER_BRIDGE_MANIFEST", "{}");
  vi.resetModules();
  const fetchMock = vi.fn(async () => okResponse({ success: true }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const current = await import("../src/lib/functions");
    await expect(current.postFunction("cmsGetContent", "token", {})).resolves.toEqual({ success: true });
    await expect(current.postFunction("cmsPreview", "token", {})).rejects.toThrow("configuration unavailable");
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});
