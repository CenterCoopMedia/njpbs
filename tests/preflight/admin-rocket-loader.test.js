import { describe, expect, it, vi } from "vitest";
import { configureAdminRocketLoader } from "../../scripts/configure-admin-rocket-loader.mjs";

const TOKEN = "t".repeat(40);
const ZONE_ID = "00000000000000000000000000000000";
const RULESET_ID = "config-ruleset";

function response(result, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFound() {
  return new Response(JSON.stringify({ success: false, errors: [{ code: 10003 }] }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

describe("Admin Rocket Loader configuration", () => {
  it("creates the http_config_settings ruleset when the phase has no entrypoint", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response([{ id: ZONE_ID, name: "njpbs.org" }]))
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(
        response({
          id: RULESET_ID,
          rules: [{ id: "created-rule", ref: "disable_rocket_loader_admin_njpbs" }],
        }),
      );

    await expect(
      configureAdminRocketLoader({ apiToken: TOKEN, fetchFn }),
    ).resolves.toEqual({
      zoneId: ZONE_ID,
      rulesetId: RULESET_ID,
      ruleId: "created-rule",
      ruleRef: "disable_rocket_loader_admin_njpbs",
      operation: "created",
    });

    const [url, init] = fetchFn.mock.calls[2];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      name: "Boardwalk configuration",
      description: "Zone configuration rules for Boardwalk Admin delivery.",
      kind: "zone",
      phase: "http_config_settings",
      rules: [
        {
          ref: "disable_rocket_loader_admin_njpbs",
          expression: 'http.host eq "admin.njpbs.org"',
          description:
            "Disable Rocket Loader on admin.njpbs.org so Vite module tags stay type=module (issue #1897).",
          action: "set_config",
          enabled: true,
          action_parameters: { rocket_loader: false },
        },
      ],
    });
  });

  it("adds the Admin hostname rule to an existing empty ruleset", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response([{ id: ZONE_ID, name: "njpbs.org" }]))
      .mockResolvedValueOnce(response({ id: RULESET_ID, rules: [] }))
      .mockResolvedValueOnce(
        response({
          id: RULESET_ID,
          rules: [{ id: "new-rule", ref: "disable_rocket_loader_admin_njpbs" }],
        }),
      );

    const result = await configureAdminRocketLoader({ apiToken: TOKEN, fetchFn });
    expect(result).toEqual({
      zoneId: ZONE_ID,
      rulesetId: RULESET_ID,
      ruleId: "new-rule",
      ruleRef: "disable_rocket_loader_admin_njpbs",
      operation: "added",
    });
    expect(fetchFn.mock.calls[2][0]).toBe(
      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules`,
    );
    expect(fetchFn.mock.calls[2][1].method).toBe("POST");
  });

  it("leaves a matching Admin rule unchanged", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response([{ id: ZONE_ID, name: "njpbs.org" }]))
      .mockResolvedValueOnce(
        response({
          id: RULESET_ID,
          rules: [
            {
              id: "existing-rule",
              ref: "disable_rocket_loader_admin_njpbs",
              expression: 'http.host eq "admin.njpbs.org"',
              action: "set_config",
              enabled: true,
              action_parameters: { rocket_loader: false },
            },
          ],
        }),
      );

    await expect(
      configureAdminRocketLoader({ apiToken: TOKEN, fetchFn }),
    ).resolves.toMatchObject({ operation: "unchanged", ruleId: "existing-rule" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("updates an owned rule that carries extra configuration settings", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response([{ id: ZONE_ID, name: "njpbs.org" }]))
      .mockResolvedValueOnce(
        response({
          id: RULESET_ID,
          rules: [
            {
              id: "existing-rule",
              ref: "disable_rocket_loader_admin_njpbs",
              expression: 'http.host eq "admin.njpbs.org"',
              action: "set_config",
              enabled: true,
              action_parameters: { rocket_loader: false, ssl: "flexible" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: RULESET_ID,
          rules: [{ id: "existing-rule", ref: "disable_rocket_loader_admin_njpbs" }],
        }),
      );

    const result = await configureAdminRocketLoader({ apiToken: TOKEN, fetchFn });
    expect(result).toEqual({
      zoneId: ZONE_ID,
      rulesetId: RULESET_ID,
      ruleId: "existing-rule",
      ruleRef: "disable_rocket_loader_admin_njpbs",
      operation: "updated",
    });
    expect(fetchFn.mock.calls[2][1].method).toBe("PATCH");
    expect(JSON.parse(fetchFn.mock.calls[2][1].body).action_parameters).toEqual({
      rocket_loader: false,
    });
  });

  it("stops if the njpbs.org zone is missing", async () => {
    const fetchFn = vi.fn(async () => response([]));
    await expect(
      configureAdminRocketLoader({ apiToken: TOKEN, fetchFn }),
    ).rejects.toThrow(/njpbs\.org/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
