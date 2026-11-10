import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parse, parseFragment, serialize } from "parse5";
import * as css from "css-tree";
import { previewOutputTarget } from "./preview-output-target.mjs";

const require = createRequire(import.meta.url);
const { previewTargetPath } = require("../../functions/lib/preview-target.js");
const EXTENSIONS = new Set([".avif", ".css", ".gif", ".html", ".ico", ".jpeg", ".jpg", ".js", ".json", ".mjs", ".png", ".svg", ".ttf", ".webmanifest", ".webp", ".woff", ".woff2", ".xml"]);
const RESOURCE_LINKS = new Set(["stylesheet", "icon", "apple-touch-icon", "preload", "modulepreload", "manifest"]);
const HOME_HERO_IMAGE_ATTRIBUTES = new Set(["data-home-hero-src", "data-fallback-src"]);

function safeFile(value) {
  if (typeof value !== "string" || value.split("/").some(segment =>
    segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/.test(segment)) ||
    !EXTENSIONS.has(path.posix.extname(value).toLowerCase())) {
    throw new Error(`Invalid private preview file: ${String(value)}`);
  }
  return value;
}

function rewriteCss(source, rewrite, context = "stylesheet") {
  const ast = css.parse(source, { context, positions: true, onParseError: error => { throw error; } });
  const edits = [];
  css.walk(ast, function (node) {
    const importedString = node.type === "String" && this.atrule?.name === "import";
    if (node.type !== "Url" && !importedString) return;
    const value = rewrite(node.value);
    if (value === node.value) return;
    edits.push({ start: node.loc.start.offset, end: node.loc.end.offset,
      text: importedString ? JSON.stringify(value) : `url(${JSON.stringify(value)})` });
  });
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}

function rewriteSrcset(source, rewrite) {
  const candidates = [];
  let remaining = source;
  // HTML tokenizes the URL before its descriptor. Commas within a URL (such
  // as an image-service query or data URL) are not candidate separators.
  while ((remaining = remaining.replace(/^[\t\n\f\r ,]+/, ""))) {
    const token = /^[^\t\n\f\r ]+/.exec(remaining)[0];
    remaining = remaining.slice(token.length);
    const url = token.replace(/,+$/, "");
    let descriptor = "";
    if (!token.endsWith(",")) {
      const end = remaining.indexOf(",");
      descriptor = (end < 0 ? remaining : remaining.slice(0, end)).trim();
      remaining = end < 0 ? "" : remaining.slice(end + 1);
      if (descriptor && !/^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor)) {
        throw new Error("Invalid preview srcset descriptor");
      }
    }
    candidates.push(`${rewrite(url)}${descriptor ? ` ${descriptor}` : ""}`);
  }
  return candidates.join(", ");
}

/** Pack only the requested HTML, its browser module graph and referenced assets.
 * No upload or filesystem write. The source build and frozen input stay intact.
 */
export async function preparePrivatePreview({ buildDirectory, pageId, queueId, expiresAtMs,
  collection = "cmsPages", snapshot = undefined, contentKey = undefined, now = Date.now(),
  deploymentEnvironment = "production", projectId = "njpbs-site" }) {
  const ORIGIN = previewOutputTarget(deploymentEnvironment, projectId).origin;
  const page = { path: previewTargetPath(collection, pageId, snapshot) };
  if (!page || !/^[A-Za-z0-9]{20}$/.test(queueId) || !Number.isSafeInteger(expiresAtMs) ||
      !/^\d{13}$/.test(String(expiresAtMs)) || expiresAtMs <= now) {
    throw new Error("Invalid private preview artifact identity or expiry");
  }
  if (contentKey !== undefined && !/^[a-f0-9]{64}$/.test(contentKey)) throw new Error("Invalid persistent preview identity");
  const root = await realpath(buildDirectory);
  const base = `/${contentKey ? "s" : "p"}/${queueId}/`;
  const pageFile = `${page.path.slice(1)}index.html`;
  const manifest = JSON.parse(await readFile(path.join(root, "_preview-assets.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Missing preview browser dependency graph");
  const modulesByFile = new Map(Object.values(manifest).map(entry => [safeFile(entry.file), entry]));
  const pending = [];
  const queued = new Set();
  const files = new Map();

  function add(file) {
    safeFile(file);
    if (path.posix.extname(file).toLowerCase() === ".html" && file !== pageFile) throw new Error("A preview cannot include another page's HTML");
    if (!queued.has(file)) { queued.add(file); pending.push(file); }
  }

  function resource(value, currentFile) {
    if (!value || value.startsWith("#") || value.startsWith("data:")) return value;
    const url = new URL(value, `${ORIGIN}${base}${currentFile}`);
    if (["https://preview.njpbs.org", "https://dev-preview.example.org"].includes(url.origin) && url.origin !== ORIGIN) {
      throw new Error("Cross-environment preview asset");
    }
    // Site-seed URLs name files copied from the pinned renderer into dist.
    // Freeze those bytes with the preview; never depend on a later apex deploy.
    const siteSeed = url.origin === "https://njpbs.org" && url.pathname.startsWith("/brand/");
    if (url.origin !== ORIGIN && !siteSeed) return value;
    if (/^\/(?:p|s)\//.test(url.pathname) && !url.pathname.startsWith(base)) throw new Error("Cross-queue preview asset");
    const file = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname.slice(1);
    add(file);
    return `${base}${file}${url.search}${url.hash}`;
  }

  function navigation(value) {
    if (!value || value.startsWith("#")) return value;
    const url = new URL(value, `https://njpbs.org${page.path}`);
    if (url.origin !== "https://njpbs.org") return value;
    if (url.pathname === page.path) return `${base}${page.path.slice(1)}${url.search}${url.hash}`;
    // Other pages are not frozen in this artifact. Review links go to their
    // public address, not a missing or differently versioned private route.
    return url.href;
  }

  function html(source, currentFile) {
    const document = parse(source);
    const moduleRoots = new Set();
    const preloaded = new Set();
    let head;
    function localModule(value) {
      if (!value) return undefined;
      const url = new URL(value, `${ORIGIN}${base}${currentFile}`);
      if (["https://preview.njpbs.org", "https://dev-preview.example.org"].includes(url.origin) && url.origin !== ORIGIN) {
        throw new Error("Cross-environment preview module");
      }
      if (url.origin !== ORIGIN || !url.pathname.startsWith(base)) return undefined;
      return url.pathname.slice(base.length);
    }
    function visit(node, active = true) {
      const attributes = node.attrs ?? [];
      const get = name => attributes.find(attribute => attribute.name === name)?.value;
      // A target-only base, such as the custom HTML frame's, leaves the base URL alone.
      if (node.tagName === "base" && get("href") !== undefined) throw new Error("Preview HTML cannot change its base URL");
      for (const attribute of attributes) {
        const resourceHref = attribute.name === "href" && (
          ["image", "use", "feImage"].includes(node.tagName) ||
          (node.tagName === "link" && (get("rel") ?? "").toLowerCase().split(/\s+/).some(rel => RESOURCE_LINKS.has(rel))));
        const homeHeroImage = node.tagName === "img" && HOME_HERO_IMAGE_ATTRIBUTES.has(attribute.name);
        if (["src", "poster", "data"].includes(attribute.name) || resourceHref || homeHeroImage) {
          const rewritten = resource(attribute.value, currentFile);
          if (rewritten !== attribute.value && get("integrity")) throw new Error("Local preview integrity metadata needs recomputation");
          attribute.value = rewritten;
        } else if (attribute.name === "srcset" || attribute.name === "imagesrcset") {
          attribute.value = rewriteSrcset(attribute.value, value => resource(value, currentFile));
        } else if (attribute.name === "href" || attribute.name === "action") {
          attribute.value = navigation(attribute.value);
        } else if (attribute.name === "style") {
          attribute.value = rewriteCss(attribute.value, value => resource(value, currentFile), "declarationList");
        } else if (attribute.name === "srcdoc") {
          attribute.value = html(attribute.value, currentFile);
        }
      }
      if (active && node.tagName === "head") head = node;
      if (active && node.tagName === "script" && (get("type") ?? "").toLowerCase() === "module") {
        const file = localModule(get("src"));
        if (file) moduleRoots.add(file);
      }
      if (active && node.tagName === "link" && (get("rel") ?? "").toLowerCase().split(/\s+/).includes("modulepreload")) {
        const file = localModule(get("href"));
        if (file) preloaded.add(new URL(get("href"), `${ORIGIN}${base}${currentFile}`).href);
      }
      if (node.tagName === "style") {
        for (const child of node.childNodes ?? []) if (child.nodeName === "#text") {
          child.value = rewriteCss(child.value, value => resource(value, currentFile));
        }
      }
      if (node.tagName === "noscript") {
        for (const child of node.childNodes ?? []) if (child.nodeName === "#text") {
          const fallback = parseFragment(child.value);
          visit(fallback, false);
          child.value = serialize(fallback);
        }
      }
      for (const child of node.childNodes ?? []) visit(child, active);
      if (node.content) visit(node.content, false);
    }
    visit(document);
    // Advance only the static imports the emitted module scripts already need.
    // Dynamic imports remain lazy, even though their bytes must be in the package.
    const staticFiles = [...moduleRoots];
    const seen = new Set(staticFiles);
    for (let index = 0; index < staticFiles.length; index++) {
      const file = staticFiles[index];
      const module = modulesByFile.get(file);
      if (!module) throw new Error(`Missing browser dependency entry: ${file}`);
      for (const key of module.imports ?? []) {
        if (!manifest[key]) throw new Error(`Missing browser dependency: ${key}`);
        const dependency = safeFile(manifest[key].file);
        if (!seen.has(dependency)) { seen.add(dependency); staticFiles.push(dependency); }
      }
    }
    for (const file of staticFiles) {
      if (moduleRoots.has(file) || preloaded.has(`${ORIGIN}${base}${file}`)) continue;
      const link = parseFragment(`<link rel="modulepreload" href="${base}${file}">`).childNodes[0];
      link.parentNode = head;
      head.childNodes.push(link);
    }
    return serialize(document);
  }

  add(pageFile);
  for (let index = 0; index < pending.length; index++) {
    const file = pending[index];
    const resolved = await realpath(path.join(root, file));
    const relative = path.relative(root, resolved);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Preview asset escapes the build directory");
    let body = await readFile(resolved);
    const extension = path.posix.extname(file).toLowerCase();
    if (extension === ".html") body = Buffer.from(html(body.toString("utf8"), file));
    if (extension === ".css") body = Buffer.from(rewriteCss(body.toString("utf8"), value => resource(value, file)));
    const module = modulesByFile.get(file);
    if ([".js", ".mjs"].includes(extension) && !module) throw new Error(`Missing browser dependency entry: ${file}`);
    if (module) {
      for (const key of [...module.imports ?? [], ...module.dynamicImports ?? []]) {
        if (!manifest[key]) throw new Error(`Missing browser dependency: ${key}`);
        add(manifest[key].file);
      }
      for (const asset of [...module.css ?? [], ...module.assets ?? []]) add(asset);
    }
    files.set(file, { key: `${contentKey ? "saved" : "v1"}/${queueId}/${file}`, body,
      sha256: createHash("sha256").update(body).digest("hex"),
      customMetadata: { schema: "njpbs-preview-v1", queueid: queueId, expiresatms: String(expiresAtMs),
        ...(contentKey ? { contentkey: contentKey } : {}) } });
  }
  return { previewUrl: `${ORIGIN}${base}`, pageUrl: `${ORIGIN}${base}${page.path.slice(1)}`, files };
}
