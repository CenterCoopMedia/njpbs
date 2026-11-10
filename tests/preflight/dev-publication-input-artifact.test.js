import { expect, it } from "vitest";
import { hasRetainedDevInput } from "../../.github/scripts/dev-publication-input-artifact.mjs";

const env = { CANONICAL_GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", CANONICAL_GITHUB_REPOSITORY_ID: "1442374012",  GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", GITHUB_RUN_ID: "38201254803", GH_TOKEN: "synthetic-test-token" };
const metadata = artifacts => ({ total_count: artifacts.length, artifacts });
const lookup = payload => hasRetainedDevInput({ env, fetchImpl: async () => Response.json(payload) });

it("identifies the exact active input from the original run", async () => {
  expect(await lookup(metadata([{ name: "dev-publication-receipt-1", expired: false },
    { name: "dev-publication-input", expired: false }]))).toBe(true);
});
it("reports no retained input when the earlier run stopped before it was uploaded", async () => {
  expect(await lookup(metadata([]))).toBe(false);
});
it.each([
  [{ name: "dev-publication-input", expired: true }],
  [{ name: "dev-publication-input" }],
  [{ name: "dev-publication-input", expired: false }, { name: "dev-publication-input", expired: false }],
].map(artifacts => ({ artifacts })))("refuses expired or ambiguous retained input: %j", async ({ artifacts }) => {
  await expect(lookup(metadata(artifacts))).rejects.toThrow("expired or ambiguous");
});
it.each([{ total_count: 101, artifacts: [] }, { artifacts: [] }, { total_count: 0 }])(
  "refuses incomplete metadata: %j", async payload => {
    await expect(lookup(payload)).rejects.toThrow("inventory is incomplete");
  },
);
it("refuses a failed lookup instead of treating it as missing input", async () => {
  await expect(hasRetainedDevInput({ env, fetchImpl: async () => new Response("", { status: 403 }) }))
    .rejects.toThrow("lookup failed");
});
it.each([{ GITHUB_REPOSITORY: "other/repo" }, { GITHUB_RUN_ID: "not-a-run" }, { GH_TOKEN: "" }])(
  "refuses an invalid lookup target before using a credential: %j", async change => {
    await expect(hasRetainedDevInput({ env: { ...env, ...change }, fetchImpl: () => {
      throw new Error("Credential must not reach an invalid target");
    } })).rejects.toThrow("Invalid dev retry artifact lookup");
  },
);

it.each(["CenterCoopMedia/njpbs"])("queries retained input from the approved owner %s", async repository => {
  await hasRetainedDevInput({ env: { ...env, GITHUB_REPOSITORY: repository }, fetchImpl: async (url, options) => {
    expect(url).toBe(`https://api.github.com/repos/${repository}/actions/runs/${env.GITHUB_RUN_ID}/artifacts?per_page=100`);
    expect(options.redirect).toBe("error");
    return Response.json(metadata([]));
  } });
});
