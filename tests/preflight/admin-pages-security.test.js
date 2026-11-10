import { describe, expect, it } from "vitest";
import {
  adminPagesRoutesErrors,
  adminPagesSecurityErrors,
  guideProbeError,
  guideVideoExposureErrors,
} from "../../scripts/check-admin-pages-security.mjs";

const protectedProject = {
  deployment_configs: {
    production: {
      fail_open: false,
      services: {
        STAFF_ACCESS: {
          service: "njpbs-cms-api",
          entrypoint: "StaffSiteEntrypoint",
        },
      },
      r2_buckets: {
        GUIDE_VIDEOS: { name: "njpbs-admin-guide" },
      },
    },
    preview: {
      fail_open: false,
      services: {
        STAFF_ACCESS: {
          service: "njpbs-cms-api",
          entrypoint: "StaffSiteEntrypoint",
        },
      },
      r2_buckets: [
        { binding: "GUIDE_VIDEOS", bucket_name: "njpbs-admin-guide" },
      ],
    },
  },
};

describe("Admin Pages security check", () => {
  it("requires fail closed before a guide deployment", () => {
    expect(adminPagesSecurityErrors(protectedProject)).toEqual([]);
    expect(adminPagesSecurityErrors({
      deployment_configs: {
        production: { fail_open: true },
        preview: { fail_open: false },
      },
    })).toEqual(["production Pages Functions must use fail closed"]);
  });

  it("requires the exact staff admission binding after deployment", () => {
    expect(adminPagesSecurityErrors(protectedProject, { requireBinding: true })).toEqual([]);
    expect(adminPagesSecurityErrors({
      ...protectedProject,
      deployment_configs: {
        ...protectedProject.deployment_configs,
        production: {
          fail_open: false,
          services: {
            STAFF_ACCESS: { service: "wrong-worker" },
          },
        },
      },
    }, { requireBinding: true })).toEqual([
      "production STAFF_ACCESS must bind to njpbs-cms-api:StaffSiteEntrypoint",
      "production GUIDE_VIDEOS must bind to njpbs-admin-guide",
    ]);
    expect(adminPagesSecurityErrors({
      ...protectedProject,
      deployment_configs: {
        ...protectedProject.deployment_configs,
        preview: {
          ...protectedProject.deployment_configs.preview,
          r2_buckets: { GUIDE_VIDEOS: { name: "njpbs-cms-voiceover" } },
        },
      },
    }, { requireBinding: true })).toEqual([
      "preview GUIDE_VIDEOS must bind to njpbs-admin-guide",
    ]);
  });

  it("keeps every guide content path in the Pages Function", () => {
    expect(adminPagesRoutesErrors({
      version: 1,
      include: ["/*"],
      exclude: [],
    })).toEqual([]);
    expect(adminPagesRoutesErrors({
      version: 1,
      include: ["/*"],
      exclude: ["/guide-content/images/*"],
    })).toEqual(["Admin Pages routes must not exclude protected guide paths"]);
  });

  it("rejects a public guide video bucket", () => {
    expect(guideVideoExposureErrors({}, {})).toEqual(["Guide video bucket privacy metadata is invalid"]);
    expect(guideVideoExposureErrors({ enabled: false }, { domains: [] })).toEqual([]);
    expect(guideVideoExposureErrors({ enabled: true }, { domains: [] })).toEqual([
      "njpbs-admin-guide must not enable its r2.dev domain",
    ]);
    expect(guideVideoExposureErrors({ enabled: false }, {
      domains: [{ domain: "media.example", enabled: true }],
    })).toEqual([
      "njpbs-admin-guide must not have a public custom domain",
    ]);
  });

  it("requires canonical guide files to reject unauthenticated requests", () => {
    expect(guideProbeError("/guide-content/manifest.json", 401, 401)).toBeNull();
    expect(guideProbeError("/guide-content/manifest.json", 200, 401)).toBe(
      "/guide-content/manifest.json returned 200; expected 401",
    );
    expect(guideProbeError("/guide-content/pages%2foverview.md", 404)).toBeNull();
    expect(guideProbeError("/guide-content/pages%2foverview.md", 503)).toBe(
      "/guide-content/pages%2foverview.md returned 503; expected a client error",
    );
  });
});
