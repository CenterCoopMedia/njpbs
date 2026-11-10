import { describe, expect, it } from "vitest";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("replacement Function startup isolation", () => {
  it.each([
    ["source-media-uploads", "cmsStartSourceMediaUpload"],
    ["source-video-replacement", "onSourceVideoReplacementTick"],
  ])("loads %s without the image/PDF media graph and retains required secret bindings", (moduleName, endpoint) => {
    const probe = `
      const Module = require("node:module");
      const path = require("node:path");
      const original = Module._load;
      const media = path.resolve("functions/media.js");
      Module._load = function(request, parent, isMain) {
        if (Module._resolveFilename(request, parent, isMain) === media || ["sharp", "pdf-lib", "busboy"].includes(request)) {
          throw new Error("Unrelated media dependency at startup");
        }
        return original.apply(this, arguments);
      };
      const api = require(path.resolve("functions/" + process.argv[1] + ".js"));
      const endpoint = api[process.argv[2]];
      if (typeof endpoint !== "function") throw new Error("Function endpoint missing");
      process.stdout.write(JSON.stringify(endpoint.__endpoint.secretEnvironmentVariables.map(item => item.key).sort()));
    `;
    const output = execFileSync(process.execPath, ["-e", probe, moduleName, endpoint], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 5000, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(JSON.parse(output)).toEqual([
      ...(moduleName === "source-media-uploads" ? ["CMS_EDGE_ORIGIN_SECRET"] : [
        "CMS_MEDIA_CACHE_PURGE_TOKEN", "CMS_MEDIA_R2_ACCESS_KEY_ID", "CMS_MEDIA_R2_SECRET_ACCESS_KEY",
        "CMS_PRIVATE_VIDEO_R2_WRITE_ACCESS_KEY_ID", "CMS_PRIVATE_VIDEO_R2_WRITE_SECRET_ACCESS_KEY",
      ]),
    ]);
  });
});

describe("Cloud Functions startup graph", () => {
  it("loads isolated modules only when their exports are accessed", () => {
    const loaded = [];
    const original = Module._load;
    Module._load = function load(request, parent, isMain) {
      if (typeof request === "string" && request.startsWith("./")) {
        loaded.push(request);
      }
      return original.apply(this, arguments);
    };
    try {
      const indexPath = require.resolve("../../functions/index.js");
      delete require.cache[indexPath];
      const api = require("../../functions/index.js");
      expect(api.cmsSaveContent).toBeTypeOf("function");
      expect(loaded).not.toContain("./bug-report");
      expect(loaded).not.toContain("./roles");
      expect(loaded).not.toContain("./save-warmup");
      expect(api.cmsListContent).toBeTypeOf("function");
      expect(api.registerStaffProfile).toBeTypeOf("function");
      expect(api.cmsGetContent).toBeTypeOf("function");
      expect(api.cmsGetNewsroomBanner).toBeTypeOf("function");
      expect(loaded).not.toContain("./media");
      expect(loaded).not.toContain("./analytics");
      expect(loaded).not.toContain("./broadcast-schedule");
      expect(loaded).not.toContain("./navigation-preferences");
      expect(loaded).not.toContain("./lib/navigation-preferences");
      expect(loaded).not.toContain("./source-media");
      expect(loaded).not.toContain("./video-previews");
      expect(loaded).not.toContain("./media-purge-sweep");
      // Tab counts on the eager media list read the source registry without the AWS SDK.
      expect(api.cmsListMedia).toBeTypeOf("function");
      expect(loaded).not.toContain("./source-media");
      expect(loaded).not.toContain("./lib/s3-media-source");
      expect(loaded).not.toContain("./s3-media-source");
      expect(api.cmsGetBroadcastSchedule).toBeTypeOf("function");
      expect(loaded).toContain("./broadcast-schedule");
      expect(loaded).not.toContain("./navigation-preferences");
      expect(api.cmsSetNavigationPreferences).toBeTypeOf("function");
      expect(loaded).toContain("./navigation-preferences");
      expect(loaded).toContain("./lib/navigation-preferences");
      const purge = Object.getOwnPropertyDescriptor(api, "onMediaPurgeSweep");
      expect(purge.get).toBeTypeOf("function");
      expect(loaded).not.toContain("./media-purge-sweep");
      expect(api.onMediaPurgeSweep).toBeTypeOf("function");
      expect(loaded).toContain("./media-purge-sweep");
    } finally {
      Module._load = original;
    }
  });
});
