import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/firebase", () => ({
  firebaseConfig: { projectId: "demo-njpbs" },
  getRequiredAppCheckToken: vi.fn(async () => "app-check-token"),
}));

import { resetNavigationPreferences, saveNavigationPreferences, shareNavigationItem } from "../src/lib/navigation-preferences-store";
import { NAVIGATION_PREFERENCES_VERSION } from "../src/lib/navigation-preferences";

const record = {
  version: NAVIGATION_PREFERENCES_VERSION,
  custom: [],
  order: ["home", "media", "pages"],
  hidden: ["pages"],
};
const getIdToken = async () => "session-token";
const endpoint = "http://127.0.0.1:5001/demo-njpbs/us-central1/cmsSetNavigationPreferences";
const failed = "Your rail could not be saved. Try again.";

function response(status = 200): Response {
  return { ok: status === 200, status, json: async () => status === 200
    ? { success: true } : { error: "PERMISSION_DENIED: users/editor-1" } } as Response;
}

describe("navigation preferences store", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => response())));
  afterEach(() => vi.unstubAllGlobals());

  it("saves through the authenticated CMS API without a caller-selected account", async () => {
    await saveNavigationPreferences(getIdToken, record);
    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer session-token", "X-Firebase-AppCheck": "app-check-token" }),
    }));
    const body = vi.mocked(fetch).mock.calls[0][1]?.body;
    expect(JSON.parse(String(body))).toEqual({ action: "save", navigation: record });
  });

  it("sends the share intent with the save and does not send an owner name", async () => {
    await saveNavigationPreferences(getIdToken, record, ["custom:desk"]);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      action: "save", navigation: record, sharedItemIds: ["custom:desk"],
    });
    await saveNavigationPreferences(getIdToken, record, []);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual({
      action: "save", navigation: record, sharedItemIds: [],
    });
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("ownerName");
  });

  it("sends a share toggle without navigation", async () => {
    await shareNavigationItem(getIdToken, "custom:desk", true);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      action: "share", itemId: "custom:desk", shared: true,
    });
    await shareNavigationItem(getIdToken, "custom:desk", false);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual({
      action: "share", itemId: "custom:desk", shared: false,
    });
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("navigation");
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("ownerName");
  });

  it("requests an explicit reset instead of storing a default copy", async () => {
    await resetNavigationPreferences(getIdToken);
    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      body: JSON.stringify({ action: "reset" }),
    }));
  });

  it("refuses unsafe custom data before dispatch", async () => {
    await expect(saveNavigationPreferences(getIdToken, { ...record, custom: [{
      id: "custom:unsafe", kind: "link", label: "Unsafe", destination: { kind: "url", url: "javascript:alert(1)" },
    }] })).rejects.toThrow(failed);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps backend detail out of the message an editor reads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(403)));
    await expect(saveNavigationPreferences(getIdToken, record)).rejects.toThrow(failed);
  });

  it("fails without a session and does not send a request", async () => {
    await expect(resetNavigationPreferences(undefined)).rejects.toThrow(failed);
    expect(fetch).not.toHaveBeenCalled();
  });
});
