// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { main, retryWorkerVersionReceipt } from
  "../scripts/upload-public-worker-candidate";
import { findExactRecentWorkerVersion } from
  "../src/lib/public-worker-version-recovery";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const TAG = "cms-g8-aaaaaaaaaaaaaaaa";
const MESSAGE = "exact candidate";

afterEach(() => vi.unstubAllEnvs());

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID,
    annotations: {
      "workers/tag": TAG,
      "workers/message": MESSAGE,
    },
    ...overrides,
  };
}

describe("public Worker candidate recovery", () => {
  it("validates the CLI pilot environment before credentials or upload", async () => {
    vi.stubEnv("NO_BUILD_POST_ID", "pilot-post");
    vi.stubEnv("NO_BUILD_POST_ENABLED", "true");
    vi.stubEnv("NO_BUILD_POST_BACKGROUND_BUCKET", undefined);
    await expect(main(["/unused/artifact.json", "/unused/prepared.json"]))
      .rejects.toThrow("The instant publication configuration is invalid");
  });

  it("retries a delayed Cloudflare version receipt without another upload", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const receipt = await retryWorkerVersionReceipt(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("version receipt is not ready");
        return { workerVersionId: VERSION_ID };
      },
      async (delayMs) => {
        delays.push(delayMs);
      },
    );

    expect(receipt).toEqual({ workerVersionId: VERSION_ID });
    expect(attempts).toBe(3);
    expect(delays).toEqual([2_000, 5_000]);
  });

  it("reuses one version with the exact deterministic annotations", () => {
    expect(findExactRecentWorkerVersion([
      version({ id: VERSION_ID.toUpperCase() }),
      version({
        id: "22222222-2222-4222-8222-222222222222",
        annotations: {
          "workers/tag": "another-tag",
          "workers/message": "another candidate",
        },
      }),
    ], TAG, MESSAGE)).toBe(VERSION_ID);
  });

  it("returns null when no recent version has the candidate tag", () => {
    expect(findExactRecentWorkerVersion([], TAG, MESSAGE)).toBeNull();
  });

  it.each([
    ["a non-list receipt", {}],
    ["a conflicting message", [version({
      annotations: {
        "workers/tag": TAG,
        "workers/message": "wrong candidate",
      },
    })]],
    ["an invalid version id", [version({ id: "latest" })]],
    ["a duplicate tag", [version(), version({
      id: "22222222-2222-4222-8222-222222222222",
    })]],
  ])("rejects %s", (_label, receipt) => {
    expect(() => findExactRecentWorkerVersion(receipt, TAG, MESSAGE))
      .toThrow();
  });
});
