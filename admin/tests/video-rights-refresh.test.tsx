import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearVideoRightsReads, useVideoRightsWarnings, videoRightsSaved } from "../src/lib/video-rights";
import { listSourceMedia, type SourceMediaAssetSummary } from "../src/lib/source-media";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
vi.mock("../src/lib/source-media", () => ({ listSourceMedia: vi.fn() }));
const asset = { id: "clip", sourceId: "video-library", name: "Boardwalk", rightsStatus: "pending", license: "Station owned" } as SourceMediaAssetSummary;
const shell = { getIdToken: async () => "local-test-only" } as ShellData;
const wrapper = ({ children }: { children: React.ReactNode }) => <ShellProvider value={shell}>{children}</ShellProvider>;
afterEach(() => { cleanup(); clearVideoRightsReads(); vi.clearAllMocks(); });
describe("mounted rights save refresh (#3674)", () => {
  it("updates duplicate consumers from the saved asset and refuses a stale pre-save result", async () => {
    vi.mocked(listSourceMedia).mockResolvedValueOnce({ records: [asset] } as never);
    const first = renderHook(() => useVideoRightsWarnings([asset.id]), { wrapper });
    const second = renderHook(() => useVideoRightsWarnings([asset.id]), { wrapper });
    await waitFor(() => expect(first.result.current).toHaveLength(1));
    expect(second.result.current).toHaveLength(1);
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
    let stale!: (value: unknown) => void;
    vi.mocked(listSourceMedia).mockImplementationOnce(() => new Promise(resolve => { stale = resolve; }) as never);
    const pending = renderHook(() => useVideoRightsWarnings([asset.id], 1), { wrapper });
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(2));
    act(() => videoRightsSaved({ ...asset, rightsStatus: "complete", version: 2 }));
    await waitFor(() => expect([first, second, pending].map(hook => hook.result.current)).toEqual([[], [], []]));
    await act(async () => stale({ records: [asset] }));
    expect([first, second, pending].map(hook => hook.result.current)).toEqual([[], [], []]);
    expect(listSourceMedia).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["pending", "Station owned", "Rights are not confirmed"], ["complete", "", "no license recorded"],
  ] as const)("keeps the advisory for a saved %s status with license=%s", async (rightsStatus, license, message) => {
    vi.mocked(listSourceMedia).mockResolvedValue({ records: [asset] } as never);
    const hook = renderHook(() => useVideoRightsWarnings([asset.id]), { wrapper });
    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    act(() => videoRightsSaved({ ...asset, rightsStatus, license, version: 2 }));
    await waitFor(() => expect(hook.result.current[0].message).toContain(message));
  });
});
