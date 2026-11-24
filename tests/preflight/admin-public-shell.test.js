import { describe, expect, it, vi } from "vitest";
import { configureAdminPublicShell } from "../../scripts/configure-admin-public-shell.mjs";

const ACCOUNT_ID = "a".repeat(32);
const TOKEN = "t".repeat(40);

function response(result, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Admin public authentication shell", () => {
  it("creates a bypass-everyone policy on the exact Admin application", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          { id: "admin-app", domain: "admin.njpbs.org", type: "self_hosted" },
          { id: "preview-app", domain: "preview.njpbs.org", type: "self_hosted" },
        ]),
      )
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: "public-policy" }));

    await expect(
      configureAdminPublicShell({ accountId: ACCOUNT_ID, apiToken: TOKEN, fetchFn }),
    ).resolves.toEqual({
      applicationId: "admin-app",
      policyId: "public-policy",
      operation: "created",
    });

    const [url, init] = fetchFn.mock.calls[2];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/apps/admin-app/policies`,
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      name: "Public Admin authentication shell",
      decision: "bypass",
      precedence: 1,
      include: [{ everyone: {} }],
      exclude: [],
      require: [],
    });
  });

  it("updates the named policy without changing another application", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        response([{ id: "admin-app", domain: "admin.njpbs.org", type: "self_hosted" }]),
      )
      .mockResolvedValueOnce(
        response([{ id: "existing-policy", name: "Public Admin authentication shell" }]),
      )
      .mockResolvedValueOnce(response({ id: "existing-policy" }));

    const result = await configureAdminPublicShell({
      accountId: ACCOUNT_ID,
      apiToken: TOKEN,
      fetchFn,
    });

    expect(result.operation).toBe("updated");
    expect(fetchFn.mock.calls[2][0]).toMatch(/policies\/existing-policy$/);
    expect(fetchFn.mock.calls[2][1].method).toBe("PUT");
  });

  it("matches Admin when it is an attached self-hosted domain", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          {
            id: "admin-app",
            domain: "njpbs-admin.pages.dev",
            self_hosted_domains: [
              "njpbs-admin.pages.dev",
              "*.njpbs-admin.pages.dev",
              "admin.njpbs.org",
            ],
            type: "self_hosted",
          },
        ]),
      )
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ id: "public-policy" }));

    await expect(
      configureAdminPublicShell({ accountId: ACCOUNT_ID, apiToken: TOKEN, fetchFn }),
    ).resolves.toEqual({
      applicationId: "admin-app",
      policyId: "public-policy",
      operation: "created",
    });
  });

  it("reads the policies back before it repeats a lost policy creation", async () => {
    const app = response([{ id: "admin-app", domain: "admin.njpbs.org", type: "self_hosted" }]);
    const policy = { id: "public-policy", name: "Public Admin authentication shell" };
    const landed = vi.fn().mockResolvedValueOnce(app.clone()).mockResolvedValueOnce(response(null, 503))
      .mockResolvedValueOnce(response([])).mockResolvedValueOnce(response(null, 502)).mockResolvedValueOnce(response([policy]));
    await expect(configureAdminPublicShell({ accountId: ACCOUNT_ID, apiToken: TOKEN, fetchFn: landed, wait: async () => {} }))
      .resolves.toMatchObject({ policyId: "public-policy", operation: "created" });
    expect(landed.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);

    const lost = vi.fn().mockResolvedValueOnce(app.clone()).mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(null, 502)).mockResolvedValueOnce(response([])).mockResolvedValueOnce(response(policy));
    await expect(configureAdminPublicShell({ accountId: ACCOUNT_ID, apiToken: TOKEN, fetchFn: lost, wait: async () => {} }))
      .resolves.toMatchObject({ policyId: "public-policy", operation: "created" });
    expect(lost.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(2);
  });

  it("stops if the exact Access application is not unique", async () => {
    const fetchFn = vi.fn(async () => response([]));

    await expect(
      configureAdminPublicShell({ accountId: ACCOUNT_ID, apiToken: TOKEN, fetchFn }),
    ).rejects.toThrow(/found 0/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
