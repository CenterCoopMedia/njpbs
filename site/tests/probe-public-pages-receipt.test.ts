import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  probePublicPagesReceipt,
  PublicPagesReceiptProbeError,
} from "../scripts/probe-public-pages-receipt";

function receipt() {
  const publication = {
    schemaVersion: 1 as const,
    digestAlgorithm: "sha256" as const,
    buildBatchId: "cms-queue-123",
    generation: 7,
    commitSha: "a".repeat(40),
    artifactDigest: "b".repeat(64),
    artifactReceiptDigest: "c".repeat(64),
    mediaManifestDigest: "d".repeat(64),
  };
  const body = `${JSON.stringify(publication, null, 2)}\n`;
  return {
    body,
    prepared: {
      ...publication,
      publicationReceiptDigest: createHash("sha256").update(body).digest("hex"),
      artifactFileCount: 2,
      artifactBytes: Buffer.byteLength(body) + 1,
    },
  };
}

describe("public Pages receipt probe", () => {
  it("accepts only the exact public artifact receipt", async () => {
    const exact = receipt();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(exact.body, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cf-ray": "a348250acdb08c69-EWR",
          "cf-cache-status": "DYNAMIC",
        },
      }));
    let time = 1_000;
    const result = await probePublicPagesReceipt({
      publicUrl: "https://njpbs.org/",
      preparedArtifact: exact.prepared,
      fetchImpl,
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
      timeoutMs: 2_000,
      pollIntervalMs: 100,
    });

    expect(result).toMatchObject({
      buildBatchId: "cms-queue-123",
      generation: 7,
      visibleAtMs: 1_100,
      attempts: 2,
      cfRay: "a348250acdb08c69-EWR",
      cfCacheStatus: "DYNAMIC",
    });
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toContain(
      "candidate=cms-queue-123",
    );
  });

  it("fails closed when the exact receipt does not appear", async () => {
    const exact = receipt();
    let time = 1_000;
    await expect(probePublicPagesReceipt({
      publicUrl: "https://njpbs.org/",
      preparedArtifact: exact.prepared,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
      timeoutMs: 100,
      pollIntervalMs: 100,
    })).rejects.toBeInstanceOf(PublicPagesReceiptProbeError);
  });

  it("refuses a non-apex URL", async () => {
    await expect(probePublicPagesReceipt({
      publicUrl: "https://example.com/",
      preparedArtifact: receipt().prepared,
    })).rejects.toThrow("not the NJ PBS apex");
  });
});
