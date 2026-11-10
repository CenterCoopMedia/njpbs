// Generated from site/src/lib/published-resource-check.ts.
// Regenerate with: node scripts/generate-published-resource-check.mjs
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// site/src/lib/published-resource-check.ts
var published_resource_check_exports = {};
__export(published_resource_check_exports, {
  assertPublishedResources: () => assertPublishedResources,
  publishedBlockResourceError: () => publishedBlockResourceError,
  publishedResourceIssues: () => publishedResourceIssues
});
module.exports = __toCommonJS(published_resource_check_exports);
var import_parse5 = require("parse5");

// packages/content-core/src/video-page.ts
var SITE_ORIGIN = "https://njpbs.org";
var PLAYER_HOSTS = /* @__PURE__ */ new Set([
  "player.pbs.org",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "vimeo.com",
  "player.vimeo.com",
  "tiktok.com",
  "www.tiktok.com",
  "instagram.com",
  "www.instagram.com",
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "web.facebook.com",
  "connect.facebook.net",
  "platform.twitter.com",
  "platform.x.com",
  // AP results frames use the same site-analytics exclusion as player pages.
  "interactives.apelections.org"
]);
function hasVideoPlayer(html) {
  const documents = [{ html, customHtml: false }];
  for (const match of html.matchAll(/<iframe\b[^>]*(?:\s|["'/])srcdoc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    documents.push({ html: match[1] ?? match[2], customHtml: true });
  }
  for (const document of documents) {
    const decoded = document.html.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
    if (/<section\b[^>]*\sdata-post-lead-player(?:\s|=|>)/i.test(decoded)) return true;
    if (/<section\b[^>]*\sdata-home-newscast-player(?:\s|=|>)/i.test(decoded)) return true;
    if (/<iframe\b[^>]*\sdata-deferred-youtube-src\s*=/i.test(decoded)) return true;
    if (/<video\b/i.test(decoded)) return true;
    for (const match of decoded.matchAll(/<(?:iframe|script)\b[^>]*(?:\s|["'/])src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      try {
        const url = new URL(match[1] ?? match[2] ?? match[3], SITE_ORIGIN);
        if (PLAYER_HOSTS.has(url.hostname) || document.customHtml && url.hostname && url.origin !== SITE_ORIGIN) return true;
      } catch {
      }
    }
  }
  return false;
}

// packages/content-core/src/public-pages.ts
var PUBLIC_PAGES = [
  {
    id: "home",
    title: "Home",
    path: "/",
    family: "home",
    area: "station",
    editorTemplate: "home"
  },
  {
    id: "watch",
    title: "Watch NJ PBS",
    path: "/watch/",
    family: "service",
    area: "watch",
    editorTemplate: "programLanding"
  },
  {
    id: "live",
    title: "PBS Livestream",
    path: "/live/",
    family: "service",
    area: "watch",
    editorTemplate: "programLanding"
  },
  {
    id: "schedule",
    title: "Schedule",
    path: "/schedule/",
    family: "schedule",
    area: "watch",
    editorTemplate: "programLanding"
  },
  {
    id: "kids",
    title: "Kids",
    path: "/kids/",
    family: "service",
    area: "watch",
    editorTemplate: "programLanding"
  },
  {
    id: "support",
    title: "Support NJ PBS",
    path: "/support/",
    family: "service",
    area: "support",
    editorTemplate: "programLanding"
  },
  {
    id: "give",
    title: "Give to NJ PBS",
    path: "/give/",
    aliases: ["/donate/"],
    family: "service",
    area: "support",
    editorTemplate: "programLanding"
  },
  {
    id: "passport",
    title: "NJ PBS Passport",
    path: "/passport/",
    family: "service",
    area: "support",
    editorTemplate: "programLanding"
  },
  {
    id: "about",
    title: "About NJ PBS",
    path: "/about/",
    family: "service",
    area: "station",
    editorTemplate: "programLanding"
  },
  {
    id: "staff",
    title: "Staff",
    path: "/staff/",
    family: "staff",
    area: "station",
    editorTemplate: "genericPage"
  },
  {
    id: "contact",
    title: "Contact NJ PBS",
    path: "/contact/",
    family: "article",
    area: "station",
    editorTemplate: "genericPage"
  },
  {
    id: "faq",
    title: "NJ PBS transition FAQ",
    path: "/faq/",
    family: "article",
    area: "support",
    editorTemplate: "genericPage"
  },
  {
    id: "accessibility",
    title: "Accessibility statement",
    path: "/accessibility/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  {
    id: "closed-captioning",
    title: "Closed captioning",
    path: "/closed-captioning/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  {
    id: "privacy",
    title: "Privacy policy",
    path: "/privacy/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  {
    id: "public-file",
    title: "FCC public inspection files",
    path: "/public-file/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  {
    id: "eeo",
    title: "FCC EEO report",
    path: "/eeo/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  {
    id: "public-meetings",
    title: "Meeting notices",
    path: "/meeting-notices/",
    aliases: ["/public-meetings/"],
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  { id: "data-hub", title: "New Jersey by the Numbers", path: "/data-hub/", family: "dataHub", area: "station", editorTemplate: "genericPage" }
];
var PUBLIC_PAGE_IDS = PUBLIC_PAGES.map((page) => page.id);

// packages/content-core/src/launch-fallback.ts
var passportLookupUrl = "https://www.pbs.org/passport/lookup/";
var donateUrl = "https://www.pbs.org/donation/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&campaign=passport";
var pbsKidsUrl = "https://pbskids.org/";
var pbsLivestreamEmbedUrl = "https://player.pbs.org/ga-livestream-partnerplayer/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&feed_cid=4211290e-ce30-49e5-9be1-2c412c5b3278";
var pbsVideoUrl = "https://watch.njpbs.org/";
var launchCompliancePageSlugs = PUBLIC_PAGES.filter(
  (page) => page.area === "compliance"
).map((page) => page.path.slice(1, -1));
var launchArticlePageSlugs = [
  ...launchCompliancePageSlugs,
  ...PUBLIC_PAGES.filter(
    (page) => page.family === "article" && page.area !== "compliance"
  ).map((page) => page.path.slice(1, -1))
];
var launchFallbackPages = {
  watch: {
    slug: "watch",
    destinationCards: true,
    title: "Watch NJ PBS",
    description: "Browse NJ PBS programs and PBS series on demand.",
    body: [
      "Use Watch for NJ PBS video you can play on demand: full episodes, specials, documentaries, PBS series, and member video benefits.",
      "Playback, episode availability, Passport access, and sign-in are handled through the PBS video portal so the same account works on the web, the PBS app, and supported devices."
    ],
    primaryAction: {
      label: "Open PBS video portal",
      href: pbsVideoUrl,
      external: true
    },
    secondaryAction: {
      label: "Watch live",
      href: "/live/"
    }
  },
  live: {
    slug: "live",
    destinationCards: true,
    title: "PBS Livestream",
    description: "Watch the NJ PBS broadcast stream through PBS live video.",
    body: [
      "The livestream uses PBS playback, location rules, and account services so it works consistently with the PBS app and watch.njpbs.org."
    ],
    primaryAction: {
      label: "Open PBS livestream",
      href: pbsLivestreamEmbedUrl,
      external: true
    },
    secondaryAction: {
      label: "See the schedule",
      href: "/schedule/"
    }
  },
  schedule: {
    slug: "schedule",
    destinationCards: true,
    title: "Schedule",
    description: "See what is airing on NJ PBS today and this week.",
    body: [
      "Browse the NJ PBS broadcast schedule below. Listings come from PBS and update through the day, so check back before tuning in, setting a recording, or looking for a program on demand.",
      "Programs air across NJ PBS and its companion channels. After something airs, look for it on demand through the PBS video portal."
    ],
    primaryAction: {
      label: "Watch live",
      href: "/live/"
    },
    secondaryAction: {
      label: "Watch on demand",
      href: pbsVideoUrl,
      external: true
    }
  },
  kids: {
    slug: "kids",
    destinationCards: true,
    title: "Kids",
    description: "PBS Kids videos, games, and learning resources for families.",
    body: [
      "PBS Kids offers videos, games, and activities for young viewers, families, caregivers, and teachers.",
      "Use PBS Kids for favorite characters, family-friendly programming, and learning resources built around curiosity and play."
    ],
    primaryAction: {
      label: "Open PBS Kids",
      href: pbsKidsUrl,
      external: true
    }
  },
  support: {
    slug: "support",
    destinationCards: true,
    title: "Support NJ PBS",
    description: "Donate, become a member, and support public television in New Jersey.",
    body: [
      "Gifts to NJ PBS support public television programming, statewide storytelling, education, arts, culture, and public affairs.",
      "Online donation processing is handled through PBS, and this site does not collect payment information.",
      "Prefer to mail a check? Make checks payable to NJ PBS and mail to: NJ PBS, 1 Normal Ave., Montclair, NJ 07043."
    ],
    primaryAction: {
      label: "Donate",
      href: donateUrl,
      external: true
    },
    secondaryAction: {
      label: "Contact NJ PBS",
      href: "/contact/"
    }
  },
  give: {
    slug: "give",
    destinationCards: true,
    title: "Give to NJ PBS",
    description: "Support public television in New Jersey through NJ PBS membership and donations.",
    body: [
      "Your gift supports trusted PBS programming, statewide reporting, educational media, arts and culture, and public-service broadcasting for New Jersey.",
      "This page is the local NJ PBS giving destination. When you donate online, the payment form opens through PBS so transaction handling and member records stay secure.",
      "Prefer to mail a check? Make checks payable to NJ PBS and mail to: NJ PBS, 1 Normal Ave., Montclair, NJ 07043."
    ],
    primaryAction: {
      label: "Donate through PBS",
      href: donateUrl,
      external: true
    },
    secondaryAction: {
      label: "Learn about Passport",
      href: "/passport/"
    }
  },
  donate: {
    slug: "donate",
    destinationCards: true,
    title: "Donate to NJ PBS",
    description: "Make a gift to support public media for New Jersey.",
    body: [
      "Gifts support NJ PBS programming, reporting, education, arts, culture, and public-service broadcasting.",
      "Online donation processing is handled through PBS, and this site does not collect payment information.",
      "Prefer to mail a check? Make checks payable to NJ PBS and mail to: NJ PBS, 1 Normal Ave., Montclair, NJ 07043."
    ],
    primaryAction: {
      label: "Donate",
      href: donateUrl,
      external: true
    },
    secondaryAction: {
      label: "Contact NJ PBS",
      href: "/contact/"
    }
  },
  passport: {
    slug: "passport",
    destinationCards: true,
    title: "NJ PBS Passport",
    description: "Learn how the PBS Passport member benefit works for NJ PBS supporters.",
    body: [
      "PBS Passport is a member benefit that gives eligible donors extended access to a library of PBS programs, films, and specials.",
      "Support NJ PBS to start or renew access, or use the PBS lookup tool if you already donate and need help finding your Passport account."
    ],
    primaryAction: {
      label: "Donate through PBS",
      href: donateUrl,
      external: true
    },
    secondaryAction: {
      label: "Find Passport access",
      href: passportLookupUrl,
      external: true
    }
  },
  about: {
    slug: "about",
    title: "About NJ PBS",
    description: "New Jersey's public television service: the member stations, how to watch and support, and Montclair State University's new role.",
    body: [
      "NJ PBS is New Jersey's public television service. It carries PBS programs, local stories, arts and culture, education, and statewide public affairs to viewers across the state and the surrounding region.",
      "Use this site to watch live and on demand, check the broadcast schedule, follow statewide reporting from NJ Spotlight News, explore PBS Kids, and support public media in New Jersey."
    ],
    primaryAction: {
      label: "Support NJ PBS",
      href: "/give/"
    },
    secondaryAction: {
      label: "NJ Spotlight News",
      href: "https://www.njspotlightnews.org/",
      external: true
    }
  }
};
var launchFallbackRoutePages = Object.values(
  launchFallbackPages
).filter((page) => page.slug !== "schedule");

// site/src/lib/analytics-page-policy.ts
function isKidsPath(path) {
  if (!path) return false;
  try {
    return decodeURIComponent(path).toLowerCase().split(/[/?#]/).includes("kids");
  } catch {
    return true;
  }
}

// site/src/lib/analytics-consent.ts
var ANALYTICS_CONSENT_GRANTED = "v4:analytics=granted,mailchimp=granted,activecampaign=granted,wisepops=granted,ads=denied";
var CONSENT_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

// site/src/lib/analytics-consent-head.ts
var MAILCHIMP_CONSENT_SNIPPET = `(function () {
  var loaded = false;
  window.njpbsLoadMailchimp = function () {
    if (loaded) return;
    loaded = true;
    !function(c,h,i,m,p){m=c.createElement(h),p=c.getElementsByTagName(h)[0],m.async=1,m.src=i,p.parentNode.insertBefore(m,p)}(document,"script","https://chimpstatic.com/mcjs-connected/js/users/7f46611cb324e9e193acda7cc/7f380769f496c8086ff6d4141.js");
  };
  try {
    var decisions = document.cookie.split(";").map(function (part) {
      return part.trim();
    }).filter(function (part) {
      return part.indexOf("njpbs-consent=") === 0;
    });
    if (
      navigator.globalPrivacyControl !== true &&
      decisions.length === 1 &&
      decodeURIComponent(decisions[0].slice(14)) === ${JSON.stringify(ANALYTICS_CONSENT_GRANTED)}
    ) {
      window.njpbsLoadMailchimp();
    }
  } catch (error) {
    /* Keep Mailchimp off when the consent cookie cannot be read. */
  }
})();`;
var WISEPOPS_SCRIPT_URL = "https://wisepops.net/h/WWRBSDzMPa/loader.js?v=3";
var WISEPOPS_CONSENT_SNIPPET = `(function () {
  var loaded = false;
  var nonce = document.currentScript && document.currentScript.nonce;

  window.njpbsLoadWisepops = function () {
    if (loaded) return;
    loaded = true;

    window.wisepops = window.wisepops || function () {
      (window.wisepops.q = window.wisepops.q || []).push(arguments);
    };
    window.wisepops.l = Date.now();
    window.wisepops._nonce = nonce;
    window.wisepops("options", { defaultConsent: "denied" });
    window.wisepops("consent", "granted");

    var script = document.createElement("script");
    var firstScript = document.getElementsByTagName("script")[0];
    script.setAttribute("data-cfasync", "false");
    script.setAttribute("data-njpbs-wisepops", "");
    if (nonce) script.nonce = nonce;
    script.defer = true;
    script.src = ${JSON.stringify(WISEPOPS_SCRIPT_URL)};
    firstScript.parentNode.insertBefore(script, firstScript);
  };

  window.njpbsStopWisepops = function () {
    if (!loaded) return;
    window.location.reload();
  };

  try {
    var decisions = document.cookie.split(";").map(function (part) {
      return part.trim();
    }).filter(function (part) {
      return part.indexOf("njpbs-consent=") === 0;
    });
    if (
      navigator.globalPrivacyControl !== true &&
      decisions.length === 1 &&
      decodeURIComponent(decisions[0].slice(14)) === ${JSON.stringify(ANALYTICS_CONSENT_GRANTED)}
    ) {
      window.njpbsLoadWisepops();
    }
  } catch (error) {
    /* Keep Wisepops off when the consent cookie cannot be read. */
  }
})();`;
var ANALYTICS_DEFAULT_SNIPPET = `      (function () {
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
        window.gtag("consent", "default", {
          analytics_storage: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          wait_for_update: 500
        });
      })();`;

// packages/content-core/src/media-origin.ts
var deploymentEnvironment = typeof __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ !== "undefined" ? __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ : typeof process !== "undefined" ? process.env.CMS_DEPLOYMENT_ENVIRONMENT : void 0;
var CMS_MEDIA_ORIGIN = deploymentEnvironment === "development" ? "https://dev-media.example.org" : "https://media.njpbs.org";

// packages/content-core/src/content-layout.ts
function visibleLayoutBlocks(blocks) {
  if (!blocks.some((block) => block.type === "row" || block.layout !== void 0)) {
    return blocks.filter((block) => block.visible);
  }
  const hiddenRows = new Set(blocks.filter((block) => block.type === "row" && !block.visible).map((block) => block.id));
  return blocks.filter((block) => block.visible && (!block.layout || !hiddenRows.has(block.layout.rowId))).map((block, order) => ({ ...block, order }));
}

// site/src/lib/published-resource-check.ts
var SITE_ORIGIN2 = "https://njpbs.org";
var SCRIPT_HOSTS = /* @__PURE__ */ new Set(["jaws-prod.cdn.pbs.org", "challenges.cloudflare.com", "public.flourish.studio"]);
var FRAME_HOSTS = /* @__PURE__ */ new Set([
  "player.pbs.org",
  "www.youtube-nocookie.com",
  "www.youtube.com",
  "player.vimeo.com",
  "www.tiktok.com",
  "www.instagram.com",
  "www.facebook.com",
  "challenges.cloudflare.com",
  // Existing map/chart embeds: release 22 and Data Hub safeEmbed().
  "flo.uri.sh",
  "datawrapper.dwcdn.net",
  "interactives.apelections.org"
]);
var IMAGE_HOSTS = /* @__PURE__ */ new Set(["image.pbs.org", "media.njpbs.org", new URL(CMS_MEDIA_ORIGIN).hostname, "public.flourish.studio"]);
function resourceIssue(tag, source, origin) {
  let url;
  try {
    url = new URL(source, origin);
  } catch {
    return `Invalid ${tag} resource URL`;
  }
  if (url.protocol === "data:" && (tag === "img" || tag === "source")) return;
  if (url.protocol !== "https:" || url.username || url.password || url.port) return `Unsupported ${tag} resource URL`;
  if (url.origin === SITE_ORIGIN2 || url.origin === origin) return;
  const allowed = tag === "script" ? SCRIPT_HOSTS : ["iframe", "embed", "object"].includes(tag) ? FRAME_HOSTS : tag === "link" ? /* @__PURE__ */ new Set() : IMAGE_HOSTS;
  if (!allowed.has(url.hostname)) return `Unreviewed ${tag} resource host: ${url.hostname}`;
}
function srcsetUrls(value) {
  const urls = [];
  let rest = value.trim();
  while (rest) {
    const token = /^[^\s]+/.exec(rest)[0];
    urls.push(token.replace(/,+$/, ""));
    rest = rest.slice(token.length).trimStart();
    if (!token.endsWith(",")) rest = rest.slice(rest.indexOf(",") < 0 ? rest.length : rest.indexOf(",") + 1).trimStart();
  }
  return urls;
}
function elements(html) {
  const pending = [(0, import_parse5.parseFragment)(html, { scriptingEnabled: false })];
  const result = [];
  while (pending.length) {
    const node = pending.pop();
    if ("childNodes" in node) pending.push(...node.childNodes);
    if (!("tagName" in node)) continue;
    result.push(node);
    if (node.tagName === "template") pending.push(node.content);
    const srcdoc = node.tagName === "iframe" && node.attrs.find((attr) => attr.name === "srcdoc")?.value;
    if (srcdoc) pending.push((0, import_parse5.parseFragment)(srcdoc, { scriptingEnabled: false }));
  }
  return result;
}
function isExecutableScript(type = "") {
  const mime = type.trim().toLowerCase().split(";")[0];
  return ["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "text/jscript", "text/livescript", "application/x-javascript"].includes(mime);
}
var SOURCE_ATTRIBUTES = {
  script: [["src", "script"], ["href", "script"], ["xlink:href", "script"]],
  iframe: [["src", "iframe"]],
  img: [["src", "img"]],
  source: [["src", "source"]],
  video: [["src", "video"], ["poster", "img"]],
  audio: [["src", "audio"]],
  track: [["src", "track"]],
  embed: [["src", "embed"]],
  object: [["data", "object"]],
  input: [["src", "img"]],
  image: [["href", "img"], ["xlink:href", "img"]],
  link: [["href", "link"]]
};
function declaredResources(tag, attrs) {
  if (tag === "input" && attrs.type?.toLowerCase() !== "image") return [];
  const fetchLink = attrs.rel?.toLowerCase().split(/\s+/).some((rel) => ["stylesheet", "preload", "modulepreload", "icon", "prefetch", "preconnect", "dns-prefetch"].includes(rel));
  if (tag === "link" && !fetchLink) return [];
  const attributes = Object.hasOwn(SOURCE_ATTRIBUTES, tag) ? SOURCE_ATTRIBUTES[tag] : [];
  const resources = attributes.filter(([attribute]) => attrs[attribute]).map(([attribute, kind]) => [kind, attrs[attribute]]);
  const srcset = ["img", "source"].includes(tag) ? attrs.srcset : tag === "link" ? attrs.imagesrcset : void 0;
  if (srcset) resources.push(...srcsetUrls(srcset).map((url) => [tag, url]));
  return resources;
}
function publishedResourceIssues(html, path, origin = SITE_ORIGIN2) {
  const issues = [];
  const nodes = elements(html);
  const video = hasVideoPlayer(html) || nodes.some((node) => ["video", "iframe", "script"].includes(node.tagName) && hasVideoPlayer((0, import_parse5.serializeOuter)(node)));
  const restricted = isKidsPath(path) || path.split("/").filter(Boolean).at(-1) === "live" || video || nodes.some((node) => node.attrs.some((attr) => attr.name === "data-child-directed"));
  for (const node of nodes) {
    const attrs = Object.fromEntries(node.attrs.map((attr) => [attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name, attr.value]));
    const tag = node.tagName;
    if (tag === "base" && attrs.href) {
      try {
        if (![SITE_ORIGIN2, origin].includes(new URL(attrs.href, origin).origin)) issues.push("External base URL changes the resource origin");
      } catch {
        issues.push("Invalid base URL");
      }
    }
    for (const [kind, source2] of declaredResources(tag, attrs)) {
      const issue = resourceIssue(kind, source2, origin);
      if (issue) issues.push(issue);
    }
    if (restricted && ("data-analytics-consent" in attrs || "data-activecampaign-enabled" in attrs || attrs.id === "analytics-consent-default" || attrs.id === "mcjs" || attrs.id === "wisepopsjs")) {
      issues.push("Site analytics on a Kids or video page");
    }
    if (tag !== "script" || attrs.src || !isExecutableScript(attrs.type)) continue;
    const source = node.childNodes.filter((child) => child.nodeName === "#text").map((child) => child.value).join("");
    if (/document\s*\.\s*cookie\s*=/.test(source)) issues.push("Inline cookie write outside the consent module");
    if (/(?:google-analytics\.com|googletagmanager\.com|chimpstatic\.com|wisepops(?:\.net|\.com|\s*\()|getwisp\.co|connect\.facebook\.net|fbq\s*\(|gtag\s*\(|vgo\s*\(|diffuser-cdn\.|trackcmp\.net|segment\.com|plausible\.io|matomo\.(?:js|cloud)|hotjar\.com)/i.test(source) && !(attrs.id === "mcjs" && source.trim() === MAILCHIMP_CONSENT_SNIPPET.trim()) && !(attrs.id === "wisepopsjs" && source.trim() === WISEPOPS_CONSENT_SNIPPET.trim()) && !(attrs.id === "analytics-consent-default" && source.trim() === ANALYTICS_DEFAULT_SNIPPET.trim())) {
      issues.push("Inline tracker outside the consent loader");
    }
  }
  return [...new Set(issues)];
}
function assertPublishedResources(html, path, origin = SITE_ORIGIN2) {
  const issues = publishedResourceIssues(html, path, origin);
  if (issues.length) throw new Error(`Published resource check failed: ${issues.join("; ")}`);
}
function publishedBlockResourceError(blocks, path = "/") {
  const origin = typeof process !== "undefined" && process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development" ? "https://dev-public.example.org" : SITE_ORIGIN2;
  for (const block of visibleLayoutBlocks(blocks)) {
    if (block.type !== "html") continue;
    const html = block.data.html;
    if (typeof html !== "string") continue;
    const issues = publishedResourceIssues(html, path, origin);
    const rawTitle = block.data.title;
    const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
    if (issues.length) return `Custom HTML plank ${blocks.findIndex((candidate) => candidate.id === block.id) + 1}${title ? ` (${title})` : ""}: ${issues.join("; ")}. Replace or remove the refused embed before publishing.`;
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  assertPublishedResources,
  publishedBlockResourceError,
  publishedResourceIssues
});
