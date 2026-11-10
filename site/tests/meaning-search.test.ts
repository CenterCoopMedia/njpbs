import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_ID,
  MODEL_REVISION,
} from "../../packages/browser-search/contracts";
const engine = vi.hoisted(() => ({
  start: vi.fn(),
  prepare: vi.fn(),
  search: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../../packages/browser-search", () => ({
  createMeaningSearch: () => engine,
}));
import { createPageMeaningSearch } from "../src/lib/meaning-search";
const passage = (url: string) => ({
  id: url,
  url,
  title: "Transcript review",
  text: "Correct words and speaker names.",
  vector: [1],
});
const index = (urls: string[]) => ({
  version: 1,
  model: MODEL_ID,
  revision: MODEL_REVISION,
  passages: urls.map(passage),
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.clearAllMocks();
  engine.start.mockResolvedValue(undefined);
  engine.prepare.mockResolvedValue({ count: 1 });
  engine.search.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());
describe("automatic local page search", () => {
  it("starts without a user action and keeps guide passages available while the model loads", async () => {
    let resolve!: () => void;
    engine.start.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => index(["/admin/docs/media/#transcripts"]),
      }),
    );
    const search = createPageMeaningSearch("guide", vi.fn(), vi.fn());
    expect(engine.start).toHaveBeenCalledOnce();
    await settle();
    expect(search.passages).toHaveLength(1);
    expect(search.ready).toBe(false);
    resolve();
    await settle();
    expect(search.ready).toBe(true);
    search.dispose();
  });
  it.each(["network", "http", "incompatible"])("disposes the concurrent model load after a terminal %s index failure", async (failure) => {
    engine.start.mockReturnValue(new Promise<void>(() => {}));
    const fetch = failure === "network"
      ? vi.fn().mockRejectedValue(new Error("Connection failed"))
      : vi.fn().mockResolvedValue({
        ok: failure !== "http",
        json: async () => ({ ...index(["/admin/docs/media/"]), version: 999 }),
      });
    vi.stubGlobal("fetch", fetch);
    const search = createPageMeaningSearch("guide", vi.fn(), vi.fn());
    await settle();
    expect(engine.start).toHaveBeenCalledOnce();
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(engine.prepare).not.toHaveBeenCalled();
    expect(search.ready).toBe(false);
    expect(search.unavailable).toBe(true);
    expect(search.passages).toEqual([]);
    search.dispose();
  });
  it("does not report ready when model download fails despite valid vectors", async () => {
    engine.start.mockRejectedValue(new Error("Blocked download"));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => index(["/admin/docs/media/"]) }),
    );
    const status = vi.fn();
    const search = createPageMeaningSearch("guide", status, vi.fn());
    await settle();
    expect(search.ready).toBe(false);
    expect(status).toHaveBeenLastCalledWith(
      "Meaning search is unavailable. Keyword search still works.",
    );
    expect(await search.search("station history")).toEqual([]);
    expect(search.passages).toHaveLength(1);
    expect(engine.dispose).toHaveBeenCalledOnce();
    search.dispose();
  });
  it("switches to keyword fallback after a worker timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => index(["/admin/docs/media/"]),
        }),
    );
    const status = vi.fn();
    const search = createPageMeaningSearch("guide", status, vi.fn());
    await settle();
    expect(search.ready).toBe(true);
    engine.search.mockRejectedValueOnce(new Error("search_timeout"));
    expect(await search.search("transcripts")).toEqual([]);
    expect(search.ready).toBe(false);
    expect(search.unavailable).toBe(true);
    expect(search.passages).toHaveLength(1);
    expect(status).toHaveBeenLastCalledWith(
      "Meaning search is unavailable. Keyword search still works.",
    );
    search.dispose();
  });
  it("keeps guide/private and foreign URLs out of public results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          index([
            "/about/",
            "/admin/docs/",
            "/about/../admin/docs/",
            "//other.test/",
            "/\\other.test/",
          ]),
      }),
    );
    const search = createPageMeaningSearch("public", vi.fn(), vi.fn());
    await settle();
    expect(search.passages.map((p) => p.url)).toEqual(["/about/"]);
    search.dispose();
  });
  it("aborts index loading and suppresses late readiness after disposal", async () => {
    let resolve!: (value: unknown) => void;
    const fetch = vi.fn().mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const onReady = vi.fn();
    const search = createPageMeaningSearch("guide", vi.fn(), onReady);
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    search.dispose();
    resolve({ ok: true, json: async () => index(["/admin/docs/"]) });
    await settle();
    expect(signal.aborted).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
    expect(search.passages).toEqual([]);
    expect(engine.dispose).toHaveBeenCalledOnce();
  });
});
