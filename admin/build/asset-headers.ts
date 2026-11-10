import type { Plugin } from "vite";
import { readFileSync } from "node:fs";
import path from "node:path";

const IMMUTABLE_ASSET_CACHE = "Cache-Control: public, max-age=31536000, immutable";
const CLOUDFLARE_HEADER_RULE_LIMIT = 100;

function headerRuleCount(source: string): number {
  return source.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith("/")).length;
}

/** Asset growth must not consume Pages rules. The middleware removes immutable
 * caching from errors and HTML fallbacks before they reach the browser. */
export function adminAssetHeadersPlugin(): Plugin {
  let baseHeaders = "";
  return {
    name: "admin-asset-headers",
    configResolved(config) {
      baseHeaders = readFileSync(path.join(config.publicDir, "_headers"), "utf8");
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const assetFiles = Object.values(bundle).map(output => output.fileName)
          .filter(fileName => fileName.startsWith("assets/")).sort();
        if (assetFiles.length === 0) throw new Error("Admin build emitted no fingerprinted assets.");
        for (const fileName of assetFiles) {
          if (!/^assets\/.+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(fileName)) {
            throw new Error(`Admin build emitted a non-fingerprinted asset path: ${fileName}`);
          }
        }
        const ruleCount = headerRuleCount(baseHeaders) + 1;
        if (ruleCount > CLOUDFLARE_HEADER_RULE_LIMIT) {
          throw new Error(`Admin _headers needs ${ruleCount} rules; Cloudflare Pages permits at most ${CLOUDFLARE_HEADER_RULE_LIMIT}.`);
        }
        const assetHeaders = `/assets/*\n  ${IMMUTABLE_ASSET_CACHE}`;
        this.emitFile({ type: "asset", fileName: "_headers",
          source: `${baseHeaders.trimEnd()}\n\n# The Pages middleware keeps missing assets and HTML out of immutable caches.\n${assetHeaders}\n` });
      },
    },
  };
}
