import { describe, expect, it, vi } from "vitest";
import adminStatus from "../../functions/lib/admin-status-revision.js";

const REVISION = "a".repeat(40);

function jsonResponse(body, headers = {}) {
  const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  let sent = false;
  return {
    ok: true,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? (name.toLowerCase() === "content-length" ? String(bytes.length) : null),
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
      }),
    },
  };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 2,
    status: "current",
    environment: "Production",
    generatedAt: "2026-09-21T13:00:00.000Z",
    refreshAfter: "2026-09-24T13:00:00.000Z",
    build: { revision: REVISION, builtAt: "2026-09-21T13:00:00.000Z" },
    ...overrides,
  };
}

describe("live Admin revision", () => {
  it("accepts a production current manifest", () => {
    expect(adminStatus.parseProductionAdminRevision(manifest())).toBe(REVISION);
  });

  it("refuses an unavailable or non-production manifest", () => {
    expect(() => adminStatus.parseProductionAdminRevision(manifest({ status: "unavailable", build: null })))
      .toThrow(/could not be read/i);
    expect(() => adminStatus.parseProductionAdminRevision(manifest({ environment: "preview" })))
      .toThrow(/could not be read/i);
    expect(() => adminStatus.parseProductionAdminRevision(manifest({
      build: { revision: "main", builtAt: "2026-09-21T13:00:00.000Z" },
    }))).toThrow(/could not be read/i);
  });

  it("reads the fixed production URL without following redirects", async () => {
    const fetchFn = vi.fn(async (url, init) => {
      expect(url).toBe(adminStatus.ADMIN_STATUS_URL);
      expect(init.redirect).toBe("error");
      expect(init.cache).toBe("no-store");
      return jsonResponse(manifest());
    });

    await expect(adminStatus.readLiveAdminBuildRevision({ fetchFn })).resolves.toBe(REVISION);
  });

  it("refuses an oversized Admin status body before buffering it", async () => {
    await expect(adminStatus.readLiveAdminBuildRevision({
      fetchFn: async () => jsonResponse(manifest(), { "content-length": String(300 * 1024) }),
    })).rejects.toMatchObject({ status: 503, name: "AdminStatusRevisionError" });
  });

  it("fails closed when the manifest cannot be fetched", async () => {
    await expect(adminStatus.readLiveAdminBuildRevision({
      fetchFn: async () => { throw new Error("network"); },
    })).rejects.toMatchObject({ status: 503, name: "AdminStatusRevisionError" });
  });
});
