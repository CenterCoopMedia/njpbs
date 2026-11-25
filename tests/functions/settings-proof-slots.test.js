import { createRequire } from "node:module";
import { expect, it } from "vitest";
// One module graph: the confirmation and the reader share the slots of a request.
const load = createRequire(import.meta.url);
const confirmation = load("../../functions/lib/no-build-post-settings-confirmation.js");
const recovery = load("../../functions/lib/no-build-post-recovery.js");

it("holds one of eight places for every request, also while routes report their refresh", async () => {
  let running = 0, most = 0;
  const polls = new Map();
  const fetchPublic = async url => {
    running += 1;
    most = Math.max(most, running);
    await new Promise(resolve => setTimeout(resolve, 5));
    running -= 1;
    const seen = (polls.get(url) ?? 0) + 1;
    polls.set(url, seen);
    return new Response(null, { headers: seen <= 2 ? { "x-njpbs-publication-refresh": "pending", "retry-after": "1" } : {} });
  };
  const values = Array.from({ length: 40 }, (_, index) => `https://example.org/posts/${index}/`);
  const results = await confirmation.readSettingsProofs(values, async (url, signal) => {
    await recovery.readPublicPostAfterRefresh(url, fetchPublic, signal, {});
    return url;
  });
  expect(results).toEqual(values);
  expect([...polls.values()].every(count => count === 3)).toBe(true);
  expect(most).toBe(8);
}, 30_000);

it("ends with the first refusal while other routes still report their refresh", async () => {
  const refused = new Error("refused"), requested = new Set();
  const pending = () => new Response(null, { headers: { "x-njpbs-publication-refresh": "pending", "retry-after": "1" } });
  await expect(confirmation.readSettingsProofs(Array.from({ length: 40 }, (_, index) => index), async (index, signal) => {
    if (index === 30) throw refused;
    await recovery.readPublicPostAfterRefresh(`https://example.org/posts/${index}/`, async url => { requested.add(url); return pending(); }, signal, {});
  })).rejects.toBe(refused);
  // Route 30 was reached while all earlier routes waited, so they gave their places back.
  expect(requested.size).toBeGreaterThanOrEqual(30);
});
