import { expect, it, vi } from "vitest";
import { admitReleaseAuthority, admitReleaseIngress, ingressRateRefusal, type IngressRateBinding } from "../workers/src/public-release-rate-control";

function request(cf = true) {
  const value = new Request("https://njpbs.org/", { headers: { "cf-connecting-ip": "203.0.113.9",
    "x-forwarded-for": "198.51.100.1", "x-njpbs-proof": "true", "x-njpbs-rate-allowed": "true" } });
  if (cf) Object.defineProperty(value, "cf", { value: { country: "US" } });
  return value;
}
const deadline = () => performance.now() + 1_000;
it("binds public admission to the edge IP and ignores forged proof/success headers", async () => {
  const consumeReleaseViewer = vi.fn(async () => ({ status: 200 as const })), consumeReleaseProof = vi.fn();
  await admitReleaseIngress(request(), { consumeReleaseViewer, consumeReleaseProof }, deadline());
  expect(consumeReleaseViewer).toHaveBeenCalledWith("203.0.113.9", expect.any(Number));
  expect(consumeReleaseProof).not.toHaveBeenCalled();
});
it("only the separate private call selects proof admission without trusting client headers", async () => {
  const consumeReleaseViewer = vi.fn(), consumeReleaseProof = vi.fn(async () => ({ status: 200 as const }));
  await admitReleaseIngress(request(false), { consumeReleaseViewer, consumeReleaseProof }, deadline(), true);
  expect(consumeReleaseProof).toHaveBeenCalledOnce(); expect(consumeReleaseViewer).not.toHaveBeenCalled();
});
it.each([{}, { consumeReleaseViewer: async () => { throw new Error("Unavailable"); } },
  { consumeReleaseViewer: async () => new Promise(() => {}) },
  { consumeReleaseViewer: async () => ({ status: 200, allowed: true }) },
  { consumeReleaseViewer: async () => ({ allowed: true }) },
  { consumeReleaseViewer: async () => ({ status: 429, retryAfterSeconds: -1 }) }])(
  "fails closed on absent/error/stalled/malformed installed limiter %j", async binding => {
    await expect(admitReleaseIngress(request(), binding as IngressRateBinding, performance.now() + 20)).rejects.toMatchObject({ status: 503 });
  });
it("renders bounded429 admission without a response body or cache permission", async () => {
  let failure;
  try { await admitReleaseIngress(request(), { consumeReleaseViewer: async () => ({ status: 429, retryAfterSeconds: 1 }) }, deadline()); }
  catch (error) { failure = error; }
  const response = ingressRateRefusal(failure);
  expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("1");
  expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.text()).toBe("");
});
it("distinguishes a valid unavailable CMS refusal from a malformed failure reply", async () => {
  await expect(admitReleaseIngress(request(), { consumeReleaseViewer: async () => ({ status: 503, retryAfterSeconds: 1 }) }, deadline()))
    .rejects.toMatchObject({ status: 503, reason: "unavailable" });
  await expect(admitReleaseIngress(request(), { consumeReleaseViewer: async () => ({ status: 503, retryAfterSeconds: -1 }) }, deadline()))
    .rejects.toMatchObject({ status: 503, reason: "malformed" });
});
it("expired or invalid admission deadlines perform zero RPC work", async () => {
  const consumeReleaseViewer = vi.fn();
  for (const value of [performance.now() - 1, Number.NaN, Number.POSITIVE_INFINITY, performance.now() + 4_000]) {
    await expect(admitReleaseIngress(request(), { consumeReleaseViewer }, value)).rejects.toMatchObject({ status: 503 });
  }
  expect(consumeReleaseViewer).not.toHaveBeenCalled();
});
it("a late successful limiter reply never starts downstream authority", async () => {
  let at = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => at);
  try {
    const downstream = vi.fn();
    await expect(admitReleaseIngress(request(), { consumeReleaseViewer: async () => {
      at = 501; return { status: 200 };
    } }, 500).then(downstream)).rejects.toMatchObject({ status: 503 });
    expect(downstream).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

it("live authority uses its installed private admission and fails closed without it", async () => {
  const consumeReleaseAuthority = vi.fn(async () => ({ status: 200 as const })), consumeReleaseViewer = vi.fn(), consumeReleaseProof = vi.fn();
  await admitReleaseAuthority({ consumeReleaseAuthority, consumeReleaseViewer, consumeReleaseProof }, deadline());
  expect(consumeReleaseAuthority).toHaveBeenCalledWith(expect.any(Number));
  expect(consumeReleaseViewer).not.toHaveBeenCalled(); expect(consumeReleaseProof).not.toHaveBeenCalled();
  await expect(admitReleaseAuthority({}, deadline())).rejects.toMatchObject({ status: 503 });
});
