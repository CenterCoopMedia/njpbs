// @vitest-environment node

import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import sitePackage from "../package.json";

const wrappers = [
  {
    command: "activate:public-worker-candidate",
    path: "../../scripts/activate-public-worker-candidate.sh",
    operator: "activate-public-worker-candidate.ts",
    descriptors: [
      [3, "cloudflare-api-token"],
      [4, "firebase-service-account"],
    ],
  },
  {
    command: "activate:public-media-lifecycle",
    path: "../../scripts/activate-public-media-lifecycle.sh",
    operator: "activate-public-media-lifecycle.ts",
    descriptors: [
      [3, "cloudflare-api-token"],
      [4, "firebase-service-account"],
      [6, "cloudflare-route-read-token"],
    ],
  },
  {
    command: "cancel-unclaimed:cms-publication-baseline",
    path: "../../scripts/cancel-unclaimed-cms-publication-baseline.sh",
    operator: "cancel-unclaimed-cms-publication-baseline.ts",
    descriptors: [[3, "firebase-service-account"]],
  },
  {
    command: "cancel-claimed:cms-publication-baseline",
    path: "../../scripts/cancel-claimed-cms-publication-baseline.sh",
    operator: "cancel-claimed-cms-publication-baseline.ts",
    descriptors: [[3, "firebase-service-account"]],
  },
] as const;

describe("CMS publication operator wrappers", () => {
  it.each(wrappers)(
    "opens credentials in the wrapper and execs Node for $command",
    ({ command, path, operator, descriptors }) => {
      const url = new URL(path, import.meta.url);
      const source = readFileSync(url, "utf8");
      const packageCommand = sitePackage.scripts[command];

      expect(statSync(url).mode & 0o111).toBe(0o111);
      expect(packageCommand).toBe(`bash ../scripts/${path.split("/").at(-1)}`);
      expect(source).toContain("set -euo pipefail");
      expect(source).toContain("umask 077");
      expect(source).toContain("CREDENTIALS_DIRECTORY");
      expect(source).toContain("FIRESTORE_EMULATOR_HOST");
      expect(source).toContain("GOOGLE_APPLICATION_CREDENTIALS");
      expect(source).toContain("NODE_OPTIONS");
      expect(source).toContain(`operator_path=\"$site_root/scripts/${operator}\"`);
      expect(source).toContain(
        'exec /usr/bin/node --import "$tsx_import" "$operator_path" "$@"',
      );
      expect(source).not.toContain("tsx/dist/cli.mjs");
      expect(source).not.toMatch(/\bnpm\b/);
      for (const [descriptor, credential] of descriptors) {
        expect(source).toContain(
          `exec ${descriptor}<\"$CREDENTIALS_DIRECTORY/${credential}\"`,
        );
        expect(source.indexOf(`exec ${descriptor}<`)).toBeLessThan(
          source.indexOf("unset CREDENTIALS_DIRECTORY"),
        );
      }
      expect(source.indexOf("unset CREDENTIALS_DIRECTORY")).toBeLessThan(
        source.indexOf("exec /usr/bin/node"),
      );
    },
  );
});
