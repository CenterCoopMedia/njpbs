import { describe, expect, it } from "vitest";
import { devCloudflareAccount } from "../scripts/dev-cloudflare-account.mjs";

const expected = "a".repeat(32);
describe("development Cloudflare account boundary", () => {
  it("accepts the active account only when it matches the separately configured development account", () => {
    expect(devCloudflareAccount({ CMS_DEV_CLOUDFLARE_ACCOUNT_ID: expected, CLOUDFLARE_ACCOUNT_ID: expected })).toBe(expected);
  });
  it.each([
    {},
    { CLOUDFLARE_ACCOUNT_ID: expected },
    { CMS_DEV_CLOUDFLARE_ACCOUNT_ID: expected },
    { CMS_DEV_CLOUDFLARE_ACCOUNT_ID: expected, CLOUDFLARE_ACCOUNT_ID: "b".repeat(32) },
    { CMS_DEV_CLOUDFLARE_ACCOUNT_ID: "invalid", CLOUDFLARE_ACCOUNT_ID: "invalid" },
    { CMS_DEV_CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_ACCOUNT_ID: "" },
  ])("rejects missing, malformed or different account intent (%#)", env => {
    expect(() => devCloudflareAccount(env)).toThrow("Development Cloudflare account configuration is missing or differs");
  });
});
