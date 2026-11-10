import { beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { preparePrivatePairPublisherInstall } from "../../scripts/lib/private-pair-publisher-prepare.mjs";

// Only the Git process boundary is modeled. A source refusal must happen
// before any bundler or provider operation, even with an otherwise valid pair.
vi.mock("node:child_process", async importActual => ({ ...await importActual(), execFileSync: vi.fn() }));
const pairTemplate = releasePair();
delete pairTemplate.publisher.workerVersionId;
const input = { pairTemplate, retainedPairs: [], legacyConfig: {},
  imageReference: `registry.cloudflare.com/${"c".repeat(32)}/pair@${pairTemplate.publisher.imageDigest}` };
beforeEach(() => { vi.mocked(execFileSync).mockReset(); });

it("refuses a checkout whose actual HEAD differs from the pair source", async () => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => args.includes("rev-parse") ? "f".repeat(40) : "");
  await expect(preparePrivatePairPublisherInstall(input)).rejects.toMatchObject({ code: "source-check-failed" });
});

it.each([" M publisher/pair-worker.ts", "?? unreviewed-runtime.mjs"])("refuses tracked or untracked source changes: %s", async status => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => args.includes("rev-parse") ? pairTemplate.commitSha : status);
  await expect(preparePrivatePairPublisherInstall(input)).rejects.toMatchObject({ code: "source-check-failed" });
});


it.each(["true", 1, null])("requires a boolean executor option before source or provider access: %s", async executorReady => {
  await expect(preparePrivatePairPublisherInstall({ ...input, executorReady })).rejects.toMatchObject({ code: "invalid-executor-ready-mode" });
});
