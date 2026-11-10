import { gzipSync } from "node:zlib";
import { parse as parseHtml } from "parse5";
import { init, parse as parseImports } from "es-module-lexer";

// Per public page, including inline JavaScript. These are asset limits, not CWV.
export const PUBLIC_STARTUP_BUDGET = Object.freeze({ initialGzipBytes: 100 * 1024, heroGzipBytes: 300 * 1024 });
const ORIGIN = "https://njpbs.invalid";
// Match the executable MIME types in src/lib/published-resource-check.ts.
const SCRIPT_TYPES = new Set(["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "text/jscript", "text/livescript", "application/x-javascript"]);
const HEAVY_HERO = /\/(?:nj-hero|nj-points|babylon)(?:[._-][^/]*)?\.m?js$/i;

function assetPath(specifier, parent) {
  const url = new URL(specifier, new URL(parent, ORIGIN));
  if (url.origin !== ORIGIN && url.origin !== "https://njpbs.org") {
    throw new Error(`Startup asset has no local byte receipt: ${url.origin}`);
  }
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some(part => part === "." || part === "..")) {
    throw new Error("Startup asset path escapes its artifact");
  }
  return pathname;
}

function scripts(html, pagePath) {
  const entries = [];
  const inline = new Map();
  function visit(node) {
    const attrs = new Map((node.attrs ?? []).map(attr => [attr.name, attr.value]));
    if (node.tagName === "script") {
      const type = (attrs.get("type") ?? "").trim().toLowerCase().split(";")[0];
      if (SCRIPT_TYPES.has(type)) {
        if (attrs.has("src")) entries.push(assetPath(attrs.get("src"), pagePath));
        else {
          const id = `${pagePath}#inline-${inline.size}`;
          inline.set(id, (node.childNodes ?? []).map(child => child.value ?? "").join(""));
          entries.push(id);
        }
      }
    }
    if (node.tagName === "link") {
      const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
      if (attrs.has("href") && (rel.includes("modulepreload") || (rel.includes("preload") && attrs.get("as") === "script"))) {
        entries.push(assetPath(attrs.get("href"), pagePath));
      }
    }
    // Template contents are inert and are not initial script requests.
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(parseHtml(html));
  return { entries, inline };
}

/** Cache shared chunks across pages. readAsset is a local filesystem boundary. */
export function createPublicStartupAudit(readAsset) {
  const modules = new Map();
  return async function audit(html, pagePath) {
    await init;
    const { entries, inline } = scripts(html, pagePath);
    function module(id) {
      if (modules.has(id) && !inline.has(id)) return modules.get(id);
      const code = inline.get(id) ?? readAsset(id);
      const [imports] = parseImports(code);
      const info = { gzipBytes: gzipSync(code).length, static: [], dynamic: [], unresolvedDynamicImports: 0 };
      for (const item of imports) {
        if (item.d === -2) continue; // import.meta is not a request.
        if (!item.n) { info.unresolvedDynamicImports += 1; continue; }
        const target = assetPath(item.n, id.split("#")[0]);
        (item.d < 0 ? info.static : info.dynamic).push(target);
      }
      if (!inline.has(id)) modules.set(id, info);
      return info;
    }
    function graph(roots, includeDynamic) {
      const found = new Map();
      const pending = [...roots];
      for (let index = 0; index < pending.length; index += 1) {
        const id = pending[index];
        if (found.has(id)) continue;
        const info = module(id);
        found.set(id, info);
        pending.push(...info.static, ...(includeDynamic ? info.dynamic : []));
      }
      return found;
    }
    const initial = graph(entries, false);
    const reachable = graph(entries, true);
    const heavy = graph([...reachable.keys()].filter(id => HEAVY_HERO.test(id)), false);
    const bytes = graph => [...graph.values()].reduce((sum, info) => sum + info.gzipBytes, 0);
    return {
      initialGzipBytes: bytes(initial), reachableGzipBytes: bytes(reachable), heroGzipBytes: bytes(heavy),
      initialAssets: [...initial.keys()], reachableAssets: [...reachable.keys()],
      initialHeavyHeroAssets: [...initial.keys()].filter(id => HEAVY_HERO.test(id)),
      unresolvedDynamicImports: [...reachable.values()].reduce((sum, info) => sum + info.unresolvedDynamicImports, 0),
    };
  };
}

export function publicStartupFailures(report) {
  const failures = [];
  if (report.initialGzipBytes > PUBLIC_STARTUP_BUDGET.initialGzipBytes) failures.push(`Initial JavaScript is ${report.initialGzipBytes} gzip bytes; limit is ${PUBLIC_STARTUP_BUDGET.initialGzipBytes}`);
  if (report.heroGzipBytes > PUBLIC_STARTUP_BUDGET.heroGzipBytes) failures.push(`Hero JavaScript is ${report.heroGzipBytes} gzip bytes; limit is ${PUBLIC_STARTUP_BUDGET.heroGzipBytes}`);
  if (report.initialHeavyHeroAssets.length) failures.push(`Heavy hero entered the initial graph: ${report.initialHeavyHeroAssets.join(", ")}`);
  return failures;
}
