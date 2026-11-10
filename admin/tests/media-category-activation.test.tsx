import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMediaSessionCache, setMediaCachePrincipal, setMediaCacheUser } from "../src/lib/media-session-cache";
import {
  CATEGORY_REGISTRY_MAX_AGE_MS,
  resetMediaCategoryRegistry,
  useMediaCategories,
} from "../src/lib/use-media-categories";

const editorPrincipal = { id: "editor-1", grants: [{ role: "editor" }] };

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  list: vi.fn(),
  authState: {
    status: "signed-in" as const,
    user: { uid: "editor-1", email: "editor@example.com" },
    principal: { id: "editor-1", grants: [{ role: "editor" }] },
    userDoc: null,
  },
}));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ getIdToken: mocks.token, state: mocks.authState }),
}));
vi.mock("../src/lib/functions", () => ({ cmsListMediaCategories: mocks.list }));

beforeEach(() => {
  clearMediaSessionCache();
  resetMediaCategoryRegistry();
  mocks.authState = {
    status: "signed-in",
    user: { uid: "editor-1", email: "editor@example.com" },
    principal: editorPrincipal,
    userDoc: null,
  };
  mocks.token.mockReset().mockResolvedValue("token");
  mocks.list.mockReset().mockResolvedValue({ categories: [] });
});

describe("category activation", () => {
  it("does not look up a token until enabled and preserves eager callers", async () => {
    const view = renderHook(({ enabled }) => useMediaCategories(enabled), { initialProps: { enabled: false } });
    await act(async () => {});
    expect(mocks.token).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    await waitFor(() => expect(view.result.current.state.status).toBe("ready"));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    view.unmount();
    renderHook(() => useMediaCategories());
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
  });

  it("shares one in-flight registry request across callers", async () => {
    let resolve!: (response: { categories: [] }) => void;
    mocks.list.mockReturnValue(new Promise(done => { resolve = done; }));
    const first = renderHook(() => useMediaCategories());
    const second = renderHook(() => useMediaCategories());
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    await act(async () => { resolve({ categories: [] }); });
    await waitFor(() => expect(first.result.current.state.status).toBe("ready"));
    expect(second.result.current.state.status).toBe("ready");
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it.each(["disable", "unmount"])("does not dispatch after %s during token lookup", async (action) => {
    let resolve!: (token: string) => void;
    mocks.token.mockReturnValue(new Promise<string>(done => { resolve = done; }));
    const view = renderHook(({ enabled }) => useMediaCategories(enabled), { initialProps: { enabled: true } });
    if (action === "disable") view.rerender({ enabled: false });
    else view.unmount();
    await act(async () => { resolve("old-token"); });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("cancels a pending token lookup when its provider changes", async () => {
    let resolve!: (token: string) => void;
    mocks.token.mockReturnValueOnce(new Promise<string>(done => { resolve = done; }));
    const view = renderHook(() => useMediaCategories());
    mocks.token = vi.fn().mockResolvedValue("new-token");
    view.rerender();
    await waitFor(() => expect(view.result.current.state.status).toBe("ready"));
    await act(async () => { resolve("old-token"); });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith("new-token");
  });

  it("ignores a response from the previous activation", async () => {
    let resolve!: (response: { categories: [] }) => void;
    mocks.list.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const view = renderHook(({ enabled }) => useMediaCategories(enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    view.rerender({ enabled: false });
    await act(async () => { resolve({ categories: [] }); });
    expect(view.result.current.state.status).toBe("loading");
    view.rerender({ enabled: true });
    await waitFor(() => expect(view.result.current.state.status).toBe("ready"));
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("keeps one registry read when a route remounts after the ID token rotates", async () => {
    const first = renderHook(() => useMediaCategories());
    await waitFor(() => expect(first.result.current.state.status).toBe("ready"));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    first.unmount();
    mocks.token.mockResolvedValue("rotated-token");
    const second = renderHook(() => useMediaCategories());
    await waitFor(() => expect(second.result.current.state.status).toBe("ready"));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith("token");
    second.unmount();
  });

  it("does not show another role's categories and reads again after the role change", async () => {
    const editorCategories = [{ id: "news", label: "News", canUpload: true }];
    const contributorCategories = [{ id: "news", label: "News", canUpload: false }];
    mocks.list.mockResolvedValueOnce({ categories: editorCategories });
    setMediaCachePrincipal("editor-1", JSON.stringify(editorPrincipal));
    const view = renderHook(() => useMediaCategories());
    await waitFor(() => expect(view.result.current.state.status).toBe("ready"));
    expect(view.result.current.state.categories).toEqual(editorCategories);

    const contributor = { id: "editor-1", grants: [{ role: "contributor" }] };
    mocks.authState = { ...mocks.authState, principal: contributor };
    mocks.list.mockResolvedValueOnce({ categories: contributorCategories });
    setMediaCachePrincipal("editor-1", JSON.stringify(contributor));
    view.rerender();

    expect(view.result.current.state.status).toBe("loading");
    expect(view.result.current.state.categories).toEqual([]);
    await waitFor(() => expect(view.result.current.state.status).toBe("ready"));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(view.result.current.state.categories).toEqual(contributorCategories);
  });

  it("reads the registry again when the cached copy is older than one minute", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const first = renderHook(() => useMediaCategories());
    await waitFor(() => expect(first.result.current.state.status).toBe("ready"));
    first.unmount();
    now.mockReturnValue(1_000 + CATEGORY_REGISTRY_MAX_AGE_MS);
    const refreshed = [{ id: "news", label: "News desk", canUpload: true }];
    mocks.list.mockResolvedValueOnce({ categories: refreshed });
    const second = renderHook(() => useMediaCategories());
    await waitFor(() => expect(second.result.current.state.categories).toEqual(refreshed));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    now.mockRestore();
    second.unmount();
  });

  it("reads again after sign-out clears the account registry", async () => {
    setMediaCachePrincipal("editor-1", JSON.stringify(editorPrincipal));
    const first = renderHook(() => useMediaCategories());
    await waitFor(() => expect(first.result.current.state.status).toBe("ready"));
    first.unmount();
    setMediaCacheUser(null);
    const second = renderHook(() => useMediaCategories());
    await waitFor(() => expect(second.result.current.state.status).toBe("ready"));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    second.unmount();
  });
});
