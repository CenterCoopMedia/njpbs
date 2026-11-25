import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { publicationTarget } from "../../functions/lib/publication-target.js";
import { createCurrentCodeTransport } from "../../functions/lib/current-public-code-source.js";
import schedules from "../../functions/lib/no-build-page-schedule-reader.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const unanswered = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
const CAPABILITY = { schemaVersion: 1, rendererSha: "a".repeat(40), servingEnabled: true, generation: 7,
  terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha: "a".repeat(40) } };
const transport = options => createCurrentCodeTransport({ rendererSha: "a".repeat(40), readSecret: () => "fixture-secret", ...options });

it.each(["development", "production"])("ends a %s read that the caller asks once, so its row can be deferred", async environment => {
  const request = vi.fn(async () => { throw unanswered(); });
  const error = await transport({ target: publicationTarget(environment), request, once: true }).readCurrentCodeReference().catch(error => error);
  expect(request).toHaveBeenCalledTimes(1);
  expect(schedules.isPageScheduleAvailabilityError(error)).toBe(true);
});

it("keeps waiting on development for a caller that does not ask once", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const request = vi.fn(async () => { throw unanswered(); });
  const read = transport({ target: publicationTarget("development"), request }).readCurrentCodeReference();
  read.catch(() => {});
  await vi.advanceTimersByTimeAsync(60_000);
  expect(request.mock.calls.length).toBeGreaterThan(3);
});

// The scheduler reads its due rows in turn: its row asks once and is deferred.
it.each([[true, true], [undefined, false]])("passes a scheduled candidate (%s) to the read as once: %s", async (scheduledCandidate, once) => {
  const load = createRequire(import.meta.url);
  const pages = load("../../functions/lib/no-build-page-publication.js"), readers = load("../../functions/lib/no-build-page-schedule-reader.js");
  const target = load("../../functions/lib/publication-target.js").publicationTarget("development");
  const capture = vi.spyOn(readers, "capturePageSchedule").mockRejectedValue(unanswered());
  const firestore = { projectId: target.projectId, doc: () => ({ get: async () => ({ data: () => CAPABILITY }) }) };
  const error = await pages.capturePageScheduleForPublication({ firestore, collection: "cmsPages", documentId: "schedule", publishing: true,
    target, releaseSelector: {}, ...(scheduledCandidate ? { scheduledCandidate } : {}) }).catch(error => error);
  expect(capture).toHaveBeenCalledWith(expect.objectContaining({ once }));
  expect(error.scheduleDeferred === true).toBe(once);
});
