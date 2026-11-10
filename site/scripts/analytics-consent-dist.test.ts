import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { isPublicOnlyBuild } from "../src/lib/build-target";
import {
  ANALYTICS_CONSENT_DENIED,
  ANALYTICS_CONSENT_GRANTED,
} from "../src/lib/analytics-consent";
import { WISEPOPS_SCRIPT_URL } from "../src/lib/analytics-consent-head";
import { renderHtmlBlock } from "../../packages/content-core/src/content-render";

const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const homePage = fileURLToPath(new URL("../dist/index.html", import.meta.url));
const kidsPage = fileURLToPath(new URL("../dist/kids/index.html", import.meta.url));
const livePage = fileURLToPath(new URL("../dist/live/index.html", import.meta.url));
const searchPage = fileURLToPath(new URL("../dist/search/index.html", import.meta.url));
const mailchimpScriptUrl =
  "https://chimpstatic.com/mcjs-connected/js/users/7f46611cb324e9e193acda7cc/7f380769f496c8086ff6d4141.js";
const publicOnly = isPublicOnlyBuild(process.env);
const privatePreview = process.env.CMS_CONTENT_MODE === "draft";
const development = process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development";

const videoProviderHosts = new Set([
  "player.pbs.org", "youtube.com", "www.youtube.com", "m.youtube.com",
  "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be",
  "vimeo.com", "player.vimeo.com", "tiktok.com", "www.tiktok.com",
  "instagram.com", "www.instagram.com", "facebook.com", "www.facebook.com",
  "m.facebook.com", "web.facebook.com", "connect.facebook.net",
  "platform.twitter.com", "platform.x.com",
]);

// Keep this audit independent of the production classifier. Parse attributes and
// nested srcdoc documents as HTML so escaping and URL forms cannot hide a player.
function builtPageHasVideo(html: string): boolean {
  const nodes: DefaultTreeAdapterTypes.Node[] = [parseFragment(html)];
  while (nodes.length) {
    const node = nodes.pop()!;
    if ("childNodes" in node) nodes.push(...node.childNodes);
    if (!("tagName" in node)) continue;
    if (node.tagName === "video") return true;
    if (node.tagName === "section" && node.attrs.some(attr => attr.name === "data-home-newscast-player")) return true;
    if (node.tagName !== "iframe" && node.tagName !== "script") continue;
    const srcdoc = node.attrs.find(attr => attr.name === "srcdoc")?.value;
    if (srcdoc) nodes.push(parseFragment(srcdoc));
    const src = node.attrs.find(attr => attr.name === "src" ||
      (node.tagName === "iframe" && attr.name === "data-deferred-youtube-src"))?.value;
    if (!src) continue;
    try {
      if (videoProviderHosts.has(new URL(src, "https://njpbs.org/").hostname)) return true;
    } catch {
      // A malformed URL cannot load a provider player.
    }
  }
  return false;
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function htmlFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.isFile() && entry.name.endsWith(".html") ? [path] : [];
  });
}

function mailchimpRequests(html: string, globalPrivacyControl: boolean): string[] {
  const source = html.match(/<script id="mcjs">([\s\S]*?)<\/script>/)?.[1];
  expect(source).toBeTruthy();

  const requests: string[] = [];
  const parentNode = {
    insertBefore(script: { src?: string }) {
      if (script.src) requests.push(script.src);
    },
  };
  const documentRef = {
    cookie: `njpbs-consent=${encodeURIComponent(ANALYTICS_CONSENT_GRANTED)}`,
    createElement: () => ({}),
    getElementsByTagName: () => [{ parentNode }],
  };

  runInNewContext(source!, {
    decodeURIComponent,
    document: documentRef,
    navigator: { globalPrivacyControl },
    window: {},
  });
  return requests;
}

function wisepopsRequests(
  html: string,
  consent: string,
  globalPrivacyControl = false,
): string[] {
  const source = html.match(/<script[^>]*id="wisepopsjs"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  expect(source).toBeTruthy();

  const requests: string[] = [];
  const parentNode = {
    insertBefore(script: { src?: string }) {
      if (script.src) requests.push(script.src);
    },
  };
  const documentRef = {
    cookie: consent ? `njpbs-consent=${encodeURIComponent(consent)}` : "",
    currentScript: { nonce: "test-nonce" },
    createElement: () => ({
      setAttribute() {},
    }),
    getElementsByTagName: () => [{ parentNode }],
  };

  runInNewContext(source!, {
    decodeURIComponent,
    document: documentRef,
    navigator: { globalPrivacyControl },
    window: { location: { reload() {} } },
  });
  return requests;
}

describe("built analytics keeps the consent boundary", () => {
  it.each([
    "player.pbs.org", "www.youtube-nocookie.com", "www.youtube.com",
    "player.vimeo.com", "www.tiktok.com", "www.instagram.com", "www.facebook.com",
  ])("classifies %s as a video page for the analytics exclusion", host => {
    for (const tag of ["iframe", "script"]) {
      const html = `<${tag} src="https://${host}/sample-player"></${tag}>`;
      expect(builtPageHasVideo(html)).toBe(true);
      expect(builtPageHasVideo(renderHtmlBlock({ html }))).toBe(true);
      expect(builtPageHasVideo(`<${tag} src="https://${host}.evil.test/sample-player"></${tag}>`)).toBe(false);
    }
    expect(builtPageHasVideo(`<a href="https://${host}/sample-player">Watch</a>`)).toBe(false);
  });

  it.each([
    '<iframe src="//player.vimeo.com/video/76979871"></iframe>',
    '<iframe src=//player.vimeo.com/video/76979871></iframe>',
    '<iframe src=https://player.vimeo.com/video/76979871></iframe>',
    '<iframe title="Video"src="https://player.vimeo.com/video/76979871"></iframe>',
    '<iframe/src="https://www.youtube.com/embed/od8NMua_mEw"></iframe>',
    '<iframe src="https://youtube.com/embed/od8NMua_mEw"></iframe>',
    '<iframe src="https://m.facebook.com/plugins/video.php"></iframe>',
    '<iframe src="https://web.facebook.com/plugins/video.php"></iframe>',
    '<iframe src="https://www.tiktok.com/player/v1/6718335390845095173"></iframe>',
    '<iframe src="https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F2038437459890192%2F"></iframe>',
    '<script src="https://www.tiktok.com/embed.js"></script>',
    '<script src="//www.instagram.com/embed.js"></script>',
    '<script src=//platform.twitter.com/widgets.js></script>',
    '<script src="https://connect.facebook.net/en_US/sdk.js"></script>',
  ])("detects provider URL forms directly and in escaped srcdoc: %s", html => {
    expect(builtPageHasVideo(html)).toBe(true);
    expect(builtPageHasVideo(renderHtmlBlock({ html }))).toBe(true);
  });

  it("classifies native video in page content and sandboxed HTML as video", () => {
    expect(builtPageHasVideo('<video src="/sample.mp4"></video>')).toBe(true);
    expect(builtPageHasVideo(renderHtmlBlock({ html: '<video src="/sample.mp4"></video>' }))).toBe(true);
  });
  it("classifies the deferred newscast as video before a player request", () => {
    expect(builtPageHasVideo('<section data-home-newscast-player><a href="https://watch.njpbs.org/video/example/">Play</a></section>')).toBe(true);
    expect(builtPageHasVideo('<iframe data-deferred-youtube-src="https://www.youtube-nocookie.com/embed/tqG0Eyoi0EQ"></iframe>')).toBe(true);
    expect(builtPageHasVideo('<iframe data-deferred-youtube-src="https://www.youtube-nocookie.com.evil.test/embed/tqG0Eyoi0EQ"></iframe>')).toBe(false);
    expect(builtPageHasVideo('<a href="https://watch.njpbs.org/video/example/">Watch</a>')).toBe(false);
  });

  it("does not put analytics on Kids or video-playing pages", () => {
    if (publicOnly) return;

    const builtHtmlFiles = htmlFiles(distDirectory);
    expect(builtHtmlFiles.length).toBeGreaterThan(0);
    expect(existsSync(kidsPage)).toBe(true);
    expect(existsSync(livePage)).toBe(true);

    const videoPages = builtHtmlFiles.filter((path) => {
      const html = read(path);
      return builtPageHasVideo(html);
    });
    expect(videoPages).toContain(livePage);

    for (const path of new Set([kidsPage, ...videoPages])) {
      const html = read(path);
      expect(html).not.toContain("data-analytics-consent");
      expect(html).not.toContain("googletagmanager.com");
      expect(html).not.toContain(mailchimpScriptUrl);
      expect(html).not.toContain('id="wisepopsjs"');
      expect(html).not.toContain('window.gtag("consent"');
    }
  });

  it("defaults every Consent Mode v2 signal to denied before configuration", () => {
    if (publicOnly || privatePreview || development) return;

    const html = read(homePage);
    expect(html).toContain("data-analytics-consent");
    const consentIndex = html.indexOf('window.gtag("consent", "default"');
    const configIndex = html.indexOf('window.gtag("config"');
    expect(consentIndex).toBeGreaterThan(-1);
    expect(html.slice(consentIndex)).toContain('analytics_storage: "denied"');
    expect(html.slice(consentIndex)).toContain('ad_storage: "denied"');
    expect(html.slice(consentIndex)).toContain('ad_user_data: "denied"');
    expect(html.slice(consentIndex)).toContain('ad_personalization: "denied"');
    expect(html.slice(consentIndex)).toContain("wait_for_update: 500");
    expect(configIndex === -1 || consentIndex < configIndex).toBe(true);
    expect(html).not.toMatch(
      /<script[^>]+src=["']https:\/\/www\.googletagmanager\.com\/gtag\/js/i,
    );
  });

  it("keeps the Mailchimp connection in the consent boundary", () => {
    if (publicOnly || privatePreview || development) return;

    const html = read(homePage);
    expect(html.match(/<script id="mcjs">/g)).toHaveLength(1);
    expect(html.split(mailchimpScriptUrl)).toHaveLength(2);
    expect(html).toContain("window.njpbsLoadMailchimp = function ()");
    expect(html).toContain(
      '!function(c,h,i,m,p){m=c.createElement(h),p=c.getElementsByTagName(h)[0],m.async=1,m.src=i,p.parentNode.insertBefore(m,p)}',
    );
    expect(mailchimpRequests(html, false)).toEqual([mailchimpScriptUrl]);
    expect(mailchimpRequests(html, true)).toEqual([]);
    expect(read(searchPage)).not.toContain(mailchimpScriptUrl);
  });

  it("keeps Wisepops at the end of the body and inside the consent boundary", () => {
    if (publicOnly || privatePreview || development) return;

    const html = read(homePage);
    const markerIndex = html.indexOf('id="wisepopsjs"');
    const scriptEnd = html.indexOf("</script>", markerIndex) + "</script>".length;
    const bodyEnd = html.lastIndexOf("</body>");
    expect(html.match(/id="wisepopsjs"/g)).toHaveLength(1);
    expect(html).toMatch(/<script[^>]*id="wisepopsjs"[^>]*data-cfasync="false"/);
    expect(html.split(WISEPOPS_SCRIPT_URL)).toHaveLength(2);
    expect(markerIndex).toBeGreaterThan(-1);
    expect(scriptEnd).toBeGreaterThan(markerIndex);
    expect(html.slice(scriptEnd, bodyEnd).trim()).toBe("");
    expect(html).not.toMatch(/<script[^>]+src=["']https:\/\/wisepops\.net/i);
    expect(wisepopsRequests(html, ANALYTICS_CONSENT_GRANTED)).toEqual([
      WISEPOPS_SCRIPT_URL,
    ]);
    expect(wisepopsRequests(html, ANALYTICS_CONSENT_GRANTED, true)).toEqual([]);
    expect(wisepopsRequests(html, ANALYTICS_CONSENT_DENIED)).toEqual([]);
    expect(wisepopsRequests(
      html,
      "v3:analytics=granted,mailchimp=granted,activecampaign=granted,ads=denied",
    )).toEqual([]);
    expect(read(searchPage)).not.toContain('id="wisepopsjs"');
  });

  it("does not put analytics anywhere in a private draft preview or development build", () => {
    if (!privatePreview && !development) return;

    const builtHtmlFiles = htmlFiles(distDirectory);
    expect(builtHtmlFiles.length).toBeGreaterThan(0);
    for (const path of builtHtmlFiles) {
      const html = read(path);
      expect(html, path).not.toContain("data-analytics-consent");
      expect(html, path).not.toContain("googletagmanager.com");
      expect(html, path).not.toContain(mailchimpScriptUrl);
      expect(html, path).not.toContain('id="wisepopsjs"');
      expect(html, path).not.toContain('window.gtag("consent"');
    }
  });
});
