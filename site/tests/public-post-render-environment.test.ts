import { describe, expect, it } from "vitest";
import { publicPostRenderEnvironment } from "../scripts/public-post-render-environment";

const publicSettings = { PUBLIC_GA4_MEASUREMENT_ID: "G-TEST123", PUBLIC_REPORT_ENDPOINT: "https://report.example.test/",
  PUBLIC_TURNSTILE_SITEKEY: "public-test-sitekey", PUBLIC_SHARE_INTAKE_ENDPOINT: "https://intake.example.test/" };

describe("public Post compiler environment", () => {
  it("retains required public settings and excludes credentials and private render mode", () => {
    const selected = publicPostRenderEnvironment({ ...publicSettings, CMS_CONTENT_MODE: "draft",
      FIREBASE_SERVICE_ACCOUNT: "private-placeholder", UNKNOWN_SETTING: "private-placeholder" });
    expect(selected).toMatchObject({ ...publicSettings, CMS_CONTENT_MODE: "published", PUBLIC_GA4_REQUIRED: "1", PUBLIC_REPORT_REQUIRED: "1" });
    expect(Object.values(selected)).not.toContain("private-placeholder");
  });
  it.each([
    { PUBLIC_GA4_MEASUREMENT_ID: undefined }, { PUBLIC_GA4_MEASUREMENT_ID: "UA-123" },
    { PUBLIC_REPORT_ENDPOINT: "http://report.example.test" }, { PUBLIC_TURNSTILE_SITEKEY: "" },
  ])("refuses incomplete or unsafe public configuration: %j", change => {
    expect(() => publicPostRenderEnvironment({ ...publicSettings, ...change })).toThrow();
  });
  it("seals the dev renderer with analytics, reporting and sharing disabled", () => {
    const selected = publicPostRenderEnvironment({ ...publicSettings, CMS_DEPLOYMENT_ENVIRONMENT: "development",
      FIREBASE_PROJECT_ID: "njpbs-site-dev", CMS_CONTENT_MODE: "draft", PUBLIC_GA4_REQUIRED: "1",
      PUBLIC_REPORT_REQUIRED: "1", PUBLIC_SHARE_REQUIRED: "1", PUBLIC_SHARE_PAGE: "1",
      FIREBASE_SERVICE_ACCOUNT: "private-placeholder", UNKNOWN_SETTING: "private-placeholder" });
    expect(selected).toEqual({ NODE_ENV: "production", CMS_CONTENT_MODE: "published", CMS_DEPLOYMENT_ENVIRONMENT: "development",
      PUBLIC_GA4_REQUIRED: "0", PUBLIC_REPORT_REQUIRED: "0", PUBLIC_SHARE_REQUIRED: "0" });
  });
  it.each([
    { CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site" },
    { CMS_DEPLOYMENT_ENVIRONMENT: "production", FIREBASE_PROJECT_ID: "njpbs-site-dev" },
    { FIREBASE_PROJECT_ID: "njpbs-site-dev" }, { CMS_DEPLOYMENT_ENVIRONMENT: "staging" },
  ])("refuses mixed or unknown compiler targets: %j", change => {
    expect(() => publicPostRenderEnvironment({ ...publicSettings, ...change })).toThrow();
  });
});

describe("public upload settings at the compiler boundary", () => {
  const origin = "https://uploads.example.test";
  it("carries the validated origin with an enabled share page", () => {
    expect(publicPostRenderEnvironment({ ...publicSettings, PUBLIC_SHARE_PAGE: "1", PUBLIC_SHARE_UPLOAD_ORIGIN: origin }))
      .toMatchObject({ PUBLIC_SHARE_PAGE: "1", PUBLIC_SHARE_UPLOAD_ORIGIN: origin });
  });
  it("keeps an explicitly configured origin consistent before the form is enabled", () => {
    const selected = publicPostRenderEnvironment({ ...publicSettings, PUBLIC_SHARE_UPLOAD_ORIGIN: origin });
    expect(selected.PUBLIC_SHARE_UPLOAD_ORIGIN).toBe(origin);
    expect(selected.PUBLIC_SHARE_PAGE).toBeUndefined();
  });
  it.each([undefined, "https://uploads.example.org", "http://uploads.example.test"])("rejects missing/template/unsafe origin before enabled compilation (%s)", value => {
    expect(() => publicPostRenderEnvironment({ ...publicSettings, PUBLIC_SHARE_PAGE: "1", PUBLIC_SHARE_UPLOAD_ORIGIN: value }))
      .toThrow("PUBLIC_SHARE_UPLOAD_ORIGIN");
  });
});
