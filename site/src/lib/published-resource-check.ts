import { parseFragment, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { hasVideoPlayer } from "../../../packages/content-core/src/video-page";
import {
  ANALYTICS_DEFAULT_SNIPPET,
  MAILCHIMP_CONSENT_SNIPPET,
  WISEPOPS_CONSENT_SNIPPET,
} from "./analytics-consent-head";
import { CMS_MEDIA_ORIGIN } from "../../../packages/content-core/src/media-origin";
import { isKidsPath } from "./analytics-page-policy";
import { visibleLayoutBlocks, type LayoutBlock } from "../../../packages/content-core/src/content-layout";

const SITE_ORIGIN = "https://njpbs.org";
// Approved public integrations from public-security-headers.ts. Analytics hosts
// are deliberately absent: their loaders belong inside the existing consent code.
const SCRIPT_HOSTS = new Set(["jaws-prod.cdn.pbs.org", "challenges.cloudflare.com", "public.flourish.studio"]);
// These players load directly; site analytics must be absent on every page
// that contains one.
const FRAME_HOSTS = new Set([
  "player.pbs.org", "www.youtube-nocookie.com", "www.youtube.com",
  "player.vimeo.com", "www.tiktok.com", "www.instagram.com",
  "www.facebook.com", "challenges.cloudflare.com",
  // Existing map/chart embeds: release 22 and Data Hub safeEmbed().
  "flo.uri.sh", "datawrapper.dwcdn.net",
  "interactives.apelections.org",
]);
// PBS artwork and the station's public media CDN. No tracking-pixel hosts.
const IMAGE_HOSTS = new Set(["image.pbs.org", "media.njpbs.org", new URL(CMS_MEDIA_ORIGIN).hostname, "public.flourish.studio"]);
type Element = DefaultTreeAdapterTypes.Element;

function resourceIssue(tag: string, source: string, origin: string): string | undefined {
  let url: URL;
  try { url = new URL(source, origin); }
  catch { return `Invalid ${tag} resource URL`; }
  if (url.protocol === "data:" && (tag === "img" || tag === "source")) return;
  if (url.protocol !== "https:" || url.username || url.password || url.port) return `Unsupported ${tag} resource URL`;
  if (url.origin === SITE_ORIGIN || url.origin === origin) return;
  const allowed = tag === "script" ? SCRIPT_HOSTS
    : ["iframe", "embed", "object"].includes(tag) ? FRAME_HOSTS
    : tag === "link" ? new Set<string>() : IMAGE_HOSTS;
  if (!allowed.has(url.hostname)) return `Unreviewed ${tag} resource host: ${url.hostname}`;
}

// Follow the URL/descriptor shape of srcset; a data URL can contain commas.
function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let rest = value.trim();
  while (rest) {
    const token = /^[^\s]+/.exec(rest)![0];
    urls.push(token.replace(/,+$/, ""));
    rest = rest.slice(token.length).trimStart();
    if (!token.endsWith(",")) rest = rest.slice(rest.indexOf(",") < 0 ? rest.length : rest.indexOf(",") + 1).trimStart();
  }
  return urls;
}

function elements(html: string): Element[] {
  const pending: DefaultTreeAdapterTypes.Node[] = [parseFragment(html, { scriptingEnabled: false })];
  const result: Element[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if ("childNodes" in node) pending.push(...node.childNodes);
    if (!("tagName" in node)) continue;
    result.push(node);
    if (node.tagName === "template") pending.push((node as DefaultTreeAdapterTypes.Template).content);
    const srcdoc = node.tagName === "iframe" && node.attrs.find(attr => attr.name === "srcdoc")?.value;
    if (srcdoc) pending.push(parseFragment(srcdoc, { scriptingEnabled: false }));
  }
  return result;
}

function isExecutableScript(type = ""): boolean {
  const mime = type.trim().toLowerCase().split(";")[0];
  return ["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "text/jscript", "text/livescript", "application/x-javascript"].includes(mime);
}

const SOURCE_ATTRIBUTES: Record<string, readonly (readonly [string, string])[]> = {
  script: [["src", "script"], ["href", "script"], ["xlink:href", "script"]],
  iframe: [["src", "iframe"]],
  img: [["src", "img"]], source: [["src", "source"]],
  video: [["src", "video"], ["poster", "img"]], audio: [["src", "audio"]],
  track: [["src", "track"]], embed: [["src", "embed"]], object: [["data", "object"]],
  input: [["src", "img"]], image: [["href", "img"], ["xlink:href", "img"]], link: [["href", "link"]],
};

function declaredResources(tag: string, attrs: Record<string, string>): [string, string][] {
  if (tag === "input" && attrs.type?.toLowerCase() !== "image") return [];
  const fetchLink = attrs.rel?.toLowerCase().split(/\s+/).some(rel => ["stylesheet", "preload", "modulepreload", "icon", "prefetch", "preconnect", "dns-prefetch"].includes(rel));
  if (tag === "link" && !fetchLink) return [];
  const attributes = Object.hasOwn(SOURCE_ATTRIBUTES, tag) ? SOURCE_ATTRIBUTES[tag] : [];
  const resources = attributes
    .filter(([attribute]) => attrs[attribute])
    .map(([attribute, kind]) => [kind, attrs[attribute]] as [string, string]);
  const srcset = ["img", "source"].includes(tag) ? attrs.srcset : tag === "link" ? attrs.imagesrcset : undefined;
  if (srcset) resources.push(...srcsetUrls(srcset).map(url => [tag, url] as [string, string]));
  return resources;
}

/** Review boundary for emitted HTML, including sandboxed CMS HTML and noscript.
 * This inventories declared resources, not requests generated by arbitrary JS.
 * It does not execute third-party code or certify legal compliance.
 */
export function publishedResourceIssues(html: string, path: string, origin = SITE_ORIGIN): string[] {
  const issues: string[] = [];
  const nodes = elements(html);
  const video = hasVideoPlayer(html) || nodes.some(node => ["video", "iframe", "script"].includes(node.tagName) && hasVideoPlayer(serializeOuter(node)));
  const restricted = isKidsPath(path) || path.split("/").filter(Boolean).at(-1) === "live" || video ||
    nodes.some(node => node.attrs.some(attr => attr.name === "data-child-directed"));
  for (const node of nodes) {
    const attrs = Object.fromEntries(node.attrs.map(attr => [attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name, attr.value]));
    const tag = node.tagName;
    if (tag === "base" && attrs.href) {
      try {
        if (![SITE_ORIGIN, origin].includes(new URL(attrs.href, origin).origin)) issues.push("External base URL changes the resource origin");
      } catch { issues.push("Invalid base URL"); }
    }
    for (const [kind, source] of declaredResources(tag, attrs)) {
      const issue = resourceIssue(kind, source, origin);
      if (issue) issues.push(issue);
    }
    if (restricted && ("data-analytics-consent" in attrs || "data-activecampaign-enabled" in attrs || attrs.id === "analytics-consent-default" || attrs.id === "mcjs" || attrs.id === "wisepopsjs")) {
      issues.push("Site analytics on a Kids or video page");
    }
    if (tag !== "script" || attrs.src || !isExecutableScript(attrs.type)) continue;
    const source = node.childNodes.filter(child => child.nodeName === "#text")
      .map(child => (child as DefaultTreeAdapterTypes.TextNode).value).join("");
    if (/document\s*\.\s*cookie\s*=/.test(source)) issues.push("Inline cookie write outside the consent module");
    if (/(?:google-analytics\.com|googletagmanager\.com|chimpstatic\.com|wisepops(?:\.net|\.com|\s*\()|getwisp\.co|connect\.facebook\.net|fbq\s*\(|gtag\s*\(|vgo\s*\(|diffuser-cdn\.|trackcmp\.net|segment\.com|plausible\.io|matomo\.(?:js|cloud)|hotjar\.com)/i.test(source) &&
        !(attrs.id === "mcjs" && source.trim() === MAILCHIMP_CONSENT_SNIPPET.trim()) &&
        !(attrs.id === "wisepopsjs" && source.trim() === WISEPOPS_CONSENT_SNIPPET.trim()) &&
        !(attrs.id === "analytics-consent-default" && source.trim() === ANALYTICS_DEFAULT_SNIPPET.trim())) {
      issues.push("Inline tracker outside the consent loader");
    }
  }
  return [...new Set(issues)];
}

export function assertPublishedResources(html: string, path: string, origin = SITE_ORIGIN): void {
  const issues = publishedResourceIssues(html, path, origin);
  if (issues.length) throw new Error(`Published resource check failed: ${issues.join("; ")}`);
}

/** The same resource boundary before publication, with the editable plank identified. */
export function publishedBlockResourceError(blocks: readonly LayoutBlock[], path = "/"): string | null {
  const origin = typeof process !== "undefined" && process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development"
    ? "https://dev-public.example.org" : SITE_ORIGIN;
  for (const block of visibleLayoutBlocks(blocks)) {
    if (block.type !== "html") continue;
    const html = (block.data as { html?: unknown }).html;
    if (typeof html !== "string") continue; // Ordinary block validation owns its shape.
    const issues = publishedResourceIssues(html, path, origin);
    const rawTitle = (block.data as { title?: unknown }).title;
    const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
    if (issues.length) return `Custom HTML plank ${blocks.findIndex(candidate => candidate.id === block.id) + 1}${title ? ` (${title})` : ""}: ${issues.join("; ")}. Replace or remove the refused embed before publishing.`;
  }
  return null;
}
