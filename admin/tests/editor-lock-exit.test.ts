import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const firebase = vi.hoisted(() => ({
  appCheck: { name: "test-app-check" } as object | null,
  auth: {
    currentUser: null as {
      uid: string;
      getIdToken: () => Promise<string>;
    } | null,
  },
}));
const getAppCheckToken = vi.hoisted(() =>
  vi.fn(async () => ({ token: "test-app-check-token" })),
);

vi.mock("firebase/app-check", () => ({ getToken: getAppCheckToken }));
vi.mock("../src/lib/firebase", () => ({
  get appCheck() {
    return firebase.appCheck;
  },
  ensureAppCheck() {
    return firebase.appCheck;
  },
  auth: firebase.auth,
  firebaseConfig: { projectId: "demo-njpbs" },
  firestoreRestOrigin: "https://firestore.googleapis.test",
}));

import { prepareEditorLockExitRelease } from "../src/lib/editor-lock-exit";

function user(uid = "owner-1") {
  return {
    uid,
    getIdToken: vi.fn(async () => "test-id-token"),
  };
}

function pendingFetch() {
  const fetchMock = vi.fn<typeof fetch>(
    () => new Promise<Response>(() => undefined),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("editor lock exit release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firebase.appCheck = { name: "test-app-check" };
    firebase.auth.currentUser = user();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("starts one addressed keepalive commit synchronously", async () => {
    const fetchMock = pendingFetch();
    const currentUser = firebase.auth.currentUser!;
    const release = await prepareEditorLockExitRelease(
      "cmsPages:home",
      "owner-1",
      "session-1",
    );

    expect(currentUser.getIdToken).toHaveBeenCalledTimes(1);
    expect(getAppCheckToken).toHaveBeenCalledWith(firebase.appCheck);
    expect(release()).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://firestore.googleapis.test/v1/projects/demo-njpbs/databases/(default)/documents:commit",
    );
    expect(request).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-id-token",
        "X-Firebase-AppCheck": "test-app-check-token",
      },
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      writes: [{
        update: {
          name: "projects/demo-njpbs/databases/(default)/documents/cmsEditorLocks/cmsPages:home",
          fields: {
            surfaceKey: { stringValue: "cmsPages:home" },
            contentCollection: { stringValue: "cmsPages" },
            contentId: { stringValue: "home" },
            ownerId: { stringValue: "owner-1" },
            sessionId: { stringValue: "session-1" },
          },
        },
        updateTransforms: [{
          fieldPath: "releasedAt",
          setToServerValue: "REQUEST_TIME",
        }],
        currentDocument: { exists: true },
      }],
    });
  });

  it.each([
    ["an owner mismatch", "cmsPages:home", "other-owner"],
    ["an invalid surface", "cmsSettings:site", "owner-1"],
  ])("refuses %s before it gets credentials", async (_label, surfaceKey, actorId) => {
    const fetchMock = pendingFetch();

    await expect(
      prepareEditorLockExitRelease(surfaceKey, actorId, "session-1"),
    ).rejects.toThrow("Editor lease owner is unavailable.");
    expect(firebase.auth.currentUser?.getIdToken).not.toHaveBeenCalled();
    expect(getAppCheckToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send after the authenticated user changes", async () => {
    const fetchMock = pendingFetch();
    const release = await prepareEditorLockExitRelease(
      "cmsPosts:story-1",
      "owner-1",
      "session-1",
    );
    firebase.auth.currentUser = user("owner-1");

    release();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends without an App Check header when App Check is not configured", async () => {
    const fetchMock = pendingFetch();
    firebase.appCheck = null;
    const release = await prepareEditorLockExitRelease(
      "cmsPages:about",
      "owner-1",
      "session-2",
    );

    release();

    expect(getAppCheckToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-id-token",
    });
  });
});
