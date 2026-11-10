import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { consumeReleaseRate, releaseViewerIp, releaseViewerRateIdentity, reportReleaseRateRefusal, ReleaseRateRefusal, type ReleaseRateEnvironment } from "../src/public-release-rate-control";
import type { CmsRateLimiter } from "../src/rate-limiter";

function fixture() {
  const prefix = randomUUID();
  const namespace = env.RATE_LIMITERS as unknown as DurableObjectNamespace<CmsRateLimiter>;
  const binding = { getByName: (name: string) => namespace.getByName(`${prefix}:${name}`) };
  const configuration: ReleaseRateEnvironment = { FIREBASE_PROJECT_ID: "njpbs-site-dev",
    PUBLIC_RELEASE_RATE_CONTROLS_ENABLED: "true", RATE_LIMITERS: binding };
  const stub = (role: string, subject = "all") => binding.getByName(`public-release-v1:njpbs-site-dev:${role}:${createHash("sha256").update(subject).digest("hex")}`);
  return { configuration, stub };
}
const deadline = () => performance.now() + 1_000;
it("bounds refusal telemetry by class/time and never records raw error or viewer data", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const failure = new ReleaseRateRefusal(503, 1, "disabled");
    for (let n = 0; n < 3; n++) reportReleaseRateRefusal("ingress", failure);
    expect(warn.mock.calls).toEqual([["Public release admission refused", { component: "ingress", reason: "disabled", status: 503, count: 1 }]]);
    clock.mockReturnValue(61_000); reportReleaseRateRefusal("ingress", failure);
    reportReleaseRateRefusal("ingress", new Error("203.0.113.7 /private/path sensitive boundary detail"));
    expect(warn.mock.calls.slice(1)).toEqual([
      ["Public release admission refused", { component: "ingress", reason: "disabled", status: 503, count: 3 }],
      ["Public release admission refused", { component: "ingress", reason: "unavailable", status: 503, count: 1 }],
    ]);
  } finally { warn.mockRestore(); clock.mockRestore(); }
});
function viewer(headers: HeadersInit, cf = true) {
  const request = new Request("https://njpbs.org/", { headers });
  if (cf) Object.defineProperty(request, "cf", { value: { country: "US" } });
  return request;
}
async function exhaust(stub: DurableObjectStub<CmsRateLimiter>) {
  await runInDurableObject(stub, (_instance, state) => {
    // Freeze refills at the real clock boundary; high aggregate rates could
    // otherwise regain a token during the test transport round trip.
    state.storage.sql.exec("INSERT INTO token_bucket(singleton,tokens,updated_at) VALUES(1,0,?) ON CONFLICT(singleton) DO UPDATE SET tokens=0,updated_at=excluded.updated_at", Date.now() + 60_000);
  });
}

it("uses only the edge identity and canonicalizes IPv6 without trusting forwarding/assertion headers", () => {
  expect(releaseViewerIp(viewer({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9",
    "x-real-ip": "198.51.100.10", "x-njpbs-proof": "true" }))).toBe("203.0.113.7");
  expect(releaseViewerIp(viewer({ "cf-connecting-ip": "2001:0db8:0000:0000:0000:0000:0000:0001" }))).toBe("2001:db8::1");
});
it.each([undefined, "", "999.1.1.1", "001.2.3.4", "203.0.113.1,198.51.100.2", ":::", "hostname"])(
  "refuses missing or malformed edge identity %s", ip => {
    expect(() => releaseViewerIp(viewer(ip === undefined ? { "x-forwarded-for": "203.0.113.1" } : { "cf-connecting-ip": ip }))).toThrow();
  });
it("refuses a caller-created request carrying only the edge header", () => {
  expect(() => releaseViewerIp(viewer({ "cf-connecting-ip": "203.0.113.7" }, false))).toThrow();
});
it("uses the original durable owner for per-IP, live authority and decision admission", async () => {
  const { configuration, stub } = fixture();
  await consumeReleaseRate(configuration, "viewer", deadline(), "203.0.113.7");
  await consumeReleaseRate(configuration, "authority", deadline());
  await consumeReleaseRate(configuration, "rpc", deadline());
  const values = await runInDurableObject(stub("viewerIp", "203.0.113.7"), (_instance, state) => [...state.storage.sql.exec("SELECT tokens FROM token_bucket")]);
  expect(values).toEqual([{ tokens: 59 }]);
});
it("exhausted live authority does not refuse independent viewer admission", async () => {
  const { configuration, stub } = fixture();
  await exhaust(stub("viewerAggregate"));
  await expect(consumeReleaseRate(configuration, "authority", deadline())).rejects.toMatchObject({ status: 429 });
  await expect(consumeReleaseRate(configuration, "viewer", deadline(), "203.0.113.7")).resolves.toBeUndefined();
});
it("IPv6 rotation shares a /64 budget while another network retains its own IP capacity", async () => {
  const { configuration, stub } = fixture();
  expect(releaseViewerRateIdentity("2001:db8:1:2::7")).toBe("2001:db8:1:2::/64");
  expect(releaseViewerRateIdentity("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
  await exhaust(stub("viewerIp", releaseViewerRateIdentity("2001:db8:1:2::7")));
  await expect(consumeReleaseRate(configuration, "viewer", deadline(), "2001:db8:1:2::99")).rejects.toMatchObject({ status: 429 });
  await expect(consumeReleaseRate(configuration, "viewer", deadline(), "2001:db8:1:3::99")).resolves.toBeUndefined();
});
it("IPv4-mapped spellings share the actual IPv4 budget", async () => {
  const { configuration, stub } = fixture();
  expect(releaseViewerRateIdentity("::ffff:203.0.113.7")).toBe("203.0.113.7");
  expect(releaseViewerRateIdentity("::ffff:cb00:7107")).toBe("203.0.113.7");
  await exhaust(stub("viewerIp", "203.0.113.7"));
  await expect(consumeReleaseRate(configuration, "viewer", deadline(), "::ffff:cb00:7107")).rejects.toMatchObject({ status: 429 });
});
it("IP exhaustion does not admit a viewer and does not exhaust another address", async () => {
  const { configuration, stub } = fixture();
  await exhaust(stub("viewerIp", "203.0.113.7"));
  await expect(consumeReleaseRate(configuration, "viewer", deadline(), "203.0.113.7")).rejects.toMatchObject({ status: 429 });
  await expect(consumeReleaseRate(configuration, "viewer", deadline(), "203.0.113.8")).resolves.toBeUndefined();
});
it("repeated IP refusals leave aggregate capacity intact for another viewer", async () => {
  const { configuration, stub } = fixture(), aggregate = stub("viewerAggregate");
  await exhaust(stub("viewerIp", "203.0.113.7"));
  await consumeReleaseRate(configuration, "authority", deadline());
  await runInDurableObject(aggregate, (_instance, state) => state.storage.sql.exec("UPDATE token_bucket SET tokens=10,updated_at=?", Date.now() + 60_000));
  for (let n = 0; n < 3; n++) await expect(consumeReleaseRate(configuration, "viewer", deadline(), "203.0.113.7")).rejects.toMatchObject({ status: 429 });
  expect(await runInDurableObject(aggregate, (_instance, state) => [...state.storage.sql.exec("SELECT tokens FROM token_bucket")])).toEqual([{ tokens: 10 }]);
  await expect(consumeReleaseRate(configuration, "viewer", deadline(), "203.0.113.8")).resolves.toBeUndefined();
  expect(await runInDurableObject(aggregate, (_instance, state) => [...state.storage.sql.exec("SELECT tokens FROM token_bucket")])).toEqual([{ tokens: 10 }]);
  await consumeReleaseRate(configuration, "authority", deadline());
  expect(await runInDurableObject(aggregate, (_instance, state) => [...state.storage.sql.exec("SELECT tokens FROM token_bucket")])).toEqual([{ tokens: 9 }]);
});
it("public RPC exhaustion never spends private proof capacity", async () => {
  const { configuration, stub } = fixture();
  await exhaust(stub("rpc"));
  await expect(consumeReleaseRate(configuration, "rpc", deadline())).rejects.toMatchObject({ status: 429 });
  await expect(consumeReleaseRate(configuration, "proof", deadline())).resolves.toBeUndefined();
});
it.each([{ PUBLIC_RELEASE_RATE_CONTROLS_ENABLED: undefined }, { PUBLIC_RELEASE_RATE_CONTROLS_ENABLED: "false" }, { RATE_LIMITERS: undefined }, { FIREBASE_PROJECT_ID: "foreign" }])(
  "fails closed before object access for disabled/missing/foreign configuration %j", async changes => {
    let accessed = false;
    const configuration: ReleaseRateEnvironment = { ...fixture().configuration,
      RATE_LIMITERS: { getByName: () => { accessed = true; throw new Error(); } }, ...changes };
    await expect(consumeReleaseRate(configuration, "rpc", deadline())).rejects.toMatchObject({ status: 503 });
    expect(accessed).toBe(false);
  });
it.each(["throw", "stall", "malformed"])("fails closed on limiter %s", async mode => {
  const configuration: ReleaseRateEnvironment = { ...fixture().configuration, RATE_LIMITERS: { getByName: () => ({ consume: () => {
    if (mode === "throw") throw new Error("Unavailable");
    if (mode === "stall") return new Promise(() => {});
    return Promise.resolve({ allowed: true });
  } }) as unknown as DurableObjectStub<CmsRateLimiter> } };
  await expect(consumeReleaseRate(configuration, "rpc", performance.now() + 20)).rejects.toMatchObject({ status: 503 });
});
