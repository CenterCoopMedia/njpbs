import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IsolateStartEnvironment } from "../../workers/src/public-isolate-start";
const version = "12345678-1234-4234-8234-123456789abc";
const isolate = "87654321-4321-4321-8321-cba987654321";
let observe: typeof import("../../workers/src/public-isolate-start").observePublicIsolateStart;
let rate: number;
type WriteDataPoint = NonNullable<IsolateStartEnvironment["ISOLATE_START_ANALYTICS"]>["writeDataPoint"];
let random: ReturnType<typeof vi.fn>, uuid: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn<WriteDataPoint>>;
const enabled = (): IsolateStartEnvironment => ({ PUBLIC_ISOLATE_START_MEASUREMENT_ENABLED: "true",
  ISOLATE_START_ANALYTICS: { writeDataPoint: write }, CF_VERSION_METADATA: { id: version } });
beforeEach(async () => {
  vi.resetModules();
  const module = await import("../../workers/src/public-isolate-start"); observe = module.observePublicIsolateStart; rate = module.ISOLATE_START_SAMPLE_RATE;
  random = vi.fn((values: Uint32Array) => { values[0] = 0; return values; });
  uuid = vi.fn(() => isolate); write = vi.fn<WriteDataPoint>();
  vi.stubGlobal("crypto", { getRandomValues: random, randomUUID: uuid });
});
afterEach(() => { vi.unstubAllGlobals(); });
it.each([undefined, "false", "", "TRUE", "1"])("is a no-op when the flag is %s", flag => {
  const accessed = vi.fn(() => { throw new Error("Disabled binding must not be touched"); });
  const allocation = vi.fn(() => { throw new Error("Disabled random allocation must not occur"); });
  vi.stubGlobal("Uint32Array", allocation);
  const env = { PUBLIC_ISOLATE_START_MEASUREMENT_ENABLED: flag,
    get ISOLATE_START_ANALYTICS() { return accessed(); }, get CF_VERSION_METADATA() { return accessed(); } };
  for (let request = 0; request < 3; request++) expect(observe(env)).toBeUndefined();
  expect(accessed).not.toHaveBeenCalled(); expect(allocation).not.toHaveBeenCalled();
  expect(random).not.toHaveBeenCalled(); expect(uuid).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});
it("writes one anonymous start with the actual provider version and exact sampling weight", () => {
  observe(enabled()); observe(enabled());
  expect(random).toHaveBeenCalledTimes(1); expect(uuid).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith({ indexes: [version], blobs: ["isolate-start-v1", isolate, version], doubles: [1, rate, 1 / rate] });
  expect(rate).toBeGreaterThan(0.00999); expect(rate).toBeLessThanOrEqual(0.01);
});
it("keeps an unsampled isolate unsampled through warm requests", () => {
  random.mockImplementation((values: Uint32Array) => { values[0] = 0xffffffff; return values; });
  observe(enabled()); random.mockImplementation((values: Uint32Array) => { values[0] = 0; return values; }); observe(enabled());
  expect(random).toHaveBeenCalledTimes(1); expect(uuid).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});
it.each(["binding", "version", "malformed-version"])("refuses a missing or invalid %s without random allocation", mode => {
  const env = enabled();
  if (mode === "binding") delete env.ISOLATE_START_ANALYTICS;
  else env.CF_VERSION_METADATA = mode === "version" ? undefined : { id: "not-a-provider-version" };
  observe(env); observe(enabled());
  expect(random).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});
it("contains binding failures and never retries a start", () => {
  write.mockImplementation(() => { throw new Error("synthetic telemetry failure"); });
  expect(() => observe(enabled())).not.toThrow(); expect(() => observe(enabled())).not.toThrow();
  expect(write).toHaveBeenCalledTimes(1);
});
it("does not await telemetry or inspect its return value", () => {
  const then = vi.fn(() => { throw new Error("Must not await telemetry"); });
  write.mockImplementation(() => ({ get then() { return then(); } }));
  expect(observe(enabled())).toBeUndefined(); expect(then).not.toHaveBeenCalled();
});
it("does not allocate an isolate id until the one-percent sample selects it", () => {
  random.mockImplementation((values: Uint32Array) => { values[0] = Math.floor(rate * 2 ** 32); return values; });
  observe(enabled()); expect(uuid).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});
