#!/usr/bin/env node
// Deploy-blocking contract for the accepted NJ PBS public homepage.
//
// Check both source shape and rendered artifacts so obsolete launch shells
// cannot replace the accepted homepage.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { checkProductionContent } from "./public-contract-mode.mjs";
import { countSafeExternalLinks, serviceDonationLinks } from "./public-contract-links.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteRoot, "..");
const distRoot = path.join(siteRoot, "dist");
const APPROVED_FAVICON_SHA256 =
  "e41d8fd16cf275c8bdd8607e110e8d2ed6e3e8417db26db4ee047df764c59c2b";
const DONATE_URL =
  "https://www.pbs.org/donation/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&campaign=passport";
const NJPBS_EMAIL_URL = "mailto:njpbs@montclair.edu?subject=NJ%20PBS%20question";
const MONTCLAIR_FOOTER_TEXT =
  "NJ PBS is housed at the College of Communication and Media at Montclair State University.";
const PASSPORT_LEARN_MORE_URL = "https://watch.njpbs.org/passport/learn-more/";
const PBS_LIVESTREAM_EMBED_URL =
  "https://player.pbs.org/ga-livestream-partnerplayer/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&feed_cid=4211290e-ce30-49e5-9be1-2c412c5b3278";
const PBS_SCHEDULE_URL = "https://www.pbs.org/tv_schedules/";
const PBS_VIDEO_URL = "https://watch.njpbs.org/";
const failures = [];

function rel(file) {
  return path.relative(repoRoot, file).replace(/\\/g, "/");
}

function fail(message) {
  failures.push(message);
}

function fileMustExist(file, label = rel(file)) {
  if (!fs.existsSync(file)) fail(`${label} is missing`);
}

function fileMustNotExist(file, label = rel(file)) {
  if (fs.existsSync(file)) fail(`${label} must not exist`);
}

function read(file) {
  fileMustExist(file);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8");
}

function requireText(haystack, needle, label) {
  if (!haystack.includes(needle)) fail(`${label} is missing: ${needle}`);
}

function requirePattern(haystack, pattern, description, label) {
  if (!pattern.test(haystack)) fail(`${label} is missing: ${description}`);
}

function requireCssRule(haystack, selector, declarations, label) {
  const normalizedSelector = (candidate) =>
    candidate.replace(/\[data-astro-cid-[^\]]+\]/g, "").trim();
  const found = [...haystack.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(
    ([, selectorList, body]) =>
      selectorList
        .split(",")
        .map(normalizedSelector)
        .includes(selector) && declarations.every((declaration) => body.includes(declaration)),
  );
  if (!found) fail(`${label} is missing: ${selector} with ${declarations.join(" and ")}`);
}

function requireDonateLinkCount(html, expected, label) {
  const actual = countSafeExternalLinks(html, DONATE_URL);
  if (actual !== expected) {
    fail(`${label} contains ${actual} safe Donate links, expected ${expected}`);
  }
}

function requireServiceDonateLinks(html, pageId, label) {
  const { actual, expected } = serviceDonationLinks(html, DONATE_URL, pageId);
  if (actual !== expected) fail(`${label} contains ${actual} safe Donate links, expected ${expected}`);
}

function hrefForHtml(url) {
  return url;
}

function forbidText(haystack, needle, label) {
  if (haystack.includes(needle)) fail(`${label} still contains: ${needle}`);
}

function normalizeHtmlEntities(html) {
  return html.replace(/&amp;|&#x26;/g, "&");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readPngHeader(file) {
  const buf = fs.readFileSync(file);
  if (!buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`${rel(file)} is not a PNG`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
}

function requirePngDimensions(file, width, height, label = rel(file)) {
  if (!fs.existsSync(file)) return;
  let header;
  try {
    header = readPngHeader(file);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${label} could not be decoded as a PNG: ${detail}`);
    return;
  }
  if (header.width !== width || header.height !== height) {
    fail(`${label} must be ${width}x${height}; got ${header.width}x${header.height}`);
  }
}

function requireApprovedFaviconHash(file) {
  if (!fs.existsSync(file)) return;
  const actual = sha256(file);
  if (actual !== APPROVED_FAVICON_SHA256) {
    fail(
      `${rel(file)} hash ${actual} does not match the canonical transparent PBS-circle favicon ${APPROVED_FAVICON_SHA256}`,
    );
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readRgbaPng(file) {
  const buf = fs.readFileSync(file);
  if (!buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`${rel(file)} is not a PNG`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`${rel(file)} must be an 8-bit RGBA PNG, got bitDepth=${bitDepth} colorType=${colorType}`);
  }

  const bpp = 4;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * bpp);

  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? pixels[rowStart + x - bpp] : 0;
      const up = y > 0 ? pixels[prevStart + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[prevStart + x - bpp] : 0;
      let value = raw[rawOffset + x];
      if (filter === 1) value = (value + left) & 255;
      else if (filter === 2) value = (value + up) & 255;
      else if (filter === 3) value = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) value = (value + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) throw new Error(`${rel(file)} has unsupported PNG filter ${filter}`);
      pixels[rowStart + x] = value;
    }
    rawOffset += stride;
  }

  return {
    width,
    height,
    pixel(x, y) {
      const i = (y * width + x) * bpp;
      return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
    },
  };
}

function requireTransparentCircleFavicon(file, label = rel(file)) {
  let png;
  try {
    png = readRgbaPng(file);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${label} could not be decoded as the canonical transparent PNG favicon: ${detail}`);
    return;
  }
  const corner = png.pixel(0, 0);
  const center = png.pixel(Math.floor(png.width / 2), Math.floor(png.height / 2));
  if (corner[3] !== 0) {
    fail(`${label} must have transparent corners; top-left alpha is ${corner[3]}`);
  }
  if (!(center[0] >= 245 && center[1] >= 245 && center[2] >= 245 && center[3] === 255)) {
    fail(`${label} must preserve the opaque white PBS mark at center; got rgba(${center.join(",")})`);
  }
}

const retiredSourceFiles = [
  "src/layouts/PrototypeLayout.astro",
  "src/components/HomePage.astro",
  "src/styles/streaming.css",
  "src/layouts/LaunchLayout.astro",
  "src/components/LaunchHome.astro",
  "src/components/LaunchPage.astro",
  "src/components/LaunchArticle.astro",
  // Reject the retired prototype route and its prototype-only integration slot.
  "src/pages/prototype/[...slug].astro",
  "src/components/IntegrationSlot.astro",
];

// Whole trees that were prototype-only: the catch-all route and the per-section
// view components, which hardcoded /prototype/ cross-links and rendered nowhere
// else.
const retiredSourceDirs = ["src/pages/prototype", "src/components/views"];

for (const relPath of retiredSourceFiles) {
  fileMustNotExist(path.join(siteRoot, relPath));
}

for (const relDir of retiredSourceDirs) {
  fileMustNotExist(path.join(siteRoot, relDir));
}

const indexSource = read(path.join(siteRoot, "src/pages/index.astro"));
requireText(
  indexSource,
  'import PublicSiteLayout from "../layouts/PublicSiteLayout.astro"',
  "src/pages/index.astro",
);
requireText(
  indexSource,
  'import CinematicHomePage from "../components/CinematicHomePage.astro"',
  "src/pages/index.astro",
);
requireText(indexSource, "<PublicSiteLayout", "src/pages/index.astro");
requireText(indexSource, "<CinematicHomePage", "src/pages/index.astro");
forbidText(indexSource, "LaunchLayout", "src/pages/index.astro");
forbidText(indexSource, "LaunchHome", "src/pages/index.astro");

const scheduleRoute = "src/pages/schedule/[...schedule].astro";
const scheduleSource = read(path.join(siteRoot, scheduleRoute));
requireText(
  scheduleSource,
  'import PublicSiteLayout from "../../layouts/PublicSiteLayout.astro"',
  scheduleRoute,
);
requireText(
  scheduleSource,
  'import NativeSchedule from "../../components/NativeSchedule.astro"',
  scheduleRoute,
);
requireText(scheduleSource, "publicRootRoutesEnabled(process.env)", scheduleRoute);
requireText(scheduleSource, "params: { schedule: undefined }", scheduleRoute);
requireText(scheduleSource, "<PublicSiteLayout", scheduleRoute);
requireText(scheduleSource, "<NativeSchedule", scheduleRoute);
forbidText(scheduleSource, "PublicSubpage", scheduleRoute);
forbidText(scheduleSource, "schedule-widget", scheduleRoute);

const publicFavicon = path.join(siteRoot, "public/favicon.png");
const brandingFavicon = path.join(repoRoot, "branding/njpbs-favicon.png");
fileMustExist(publicFavicon);
fileMustExist(brandingFavicon);
requireApprovedFaviconHash(publicFavicon);
requireApprovedFaviconHash(brandingFavicon);
if (fs.existsSync(publicFavicon)) requireTransparentCircleFavicon(publicFavicon);
if (fs.existsSync(brandingFavicon)) requireTransparentCircleFavicon(brandingFavicon);
if (fs.existsSync(publicFavicon) && fs.existsSync(brandingFavicon)) {
  const publicHash = sha256(publicFavicon);
  const brandingHash = sha256(brandingFavicon);
  if (publicHash !== brandingHash) {
    fail(
      `site/public/favicon.png hash ${publicHash} does not match branding/njpbs-favicon.png ${brandingHash}`,
    );
  }
}
fileMustNotExist(path.join(siteRoot, "public/favicon.svg"));

const publicOgImage = path.join(siteRoot, "public/og-default.png");
fileMustExist(publicOgImage);
requirePngDimensions(publicOgImage, 1200, 630);

const distIndex = path.join(distRoot, "index.html");
const indexHtml = normalizeHtmlEntities(read(distIndex)).replace(/&apos;|&#39;/g, "'");

// These are shell invariants even when the home page itself is the draft route.
requireText(indexHtml, 'href="/favicon.png"', "dist/index.html");
requireText(indexHtml, 'type="image/png"', "dist/index.html");
requireText(indexHtml, 'class="site-head"', "dist/index.html");
requireText(indexHtml, "data-home-hero", "dist/index.html");
requireText(indexHtml, "/brand/njpbs-horizontal-white.svg", "dist/index.html");
forbidText(
  indexHtml,
  'aria-label="NJ Spotlight acquisition announcement"',
  "dist/index.html",
);
if (checkProductionContent("home")) {
  requirePattern(
    indexHtml,
    /<h1\b[^>]*\bid="hero-h"[^>]*>\s*[^\s<][^<]*<\/h1>/,
    "nonempty hero heading",
    "dist/index.html",
  );
  requireText(indexHtml, `href="${hrefForHtml(PBS_VIDEO_URL)}"`, "dist/index.html");
  requireText(indexHtml, 'href="/live/"', "dist/index.html");
  requireText(indexHtml, `href="${hrefForHtml(PASSPORT_LEARN_MORE_URL)}"`, "dist/index.html");
  // Editors can select a donation destination as a hero slide. Keep the fixed
  // shell and fallback checks separate from those configurable destinations.
  const heroHtml = indexHtml.match(/<section\b[^>]*\bdata-home-hero\b[^>]*>[\s\S]*?<\/section>/)?.[0] ?? "";
  requireDonateLinkCount(indexHtml.replace(heroHtml, ""), 2, "dist/index.html shell Donate links");
  if (heroHtml.includes('class="home-hero__fallback"')) {
    requireDonateLinkCount(heroHtml, 1, "dist/index.html fallback Donate link");
  }
  requireText(indexHtml, 'href="/faq/"', "dist/index.html");
  requireText(indexHtml, 'href="/contact/"', "dist/index.html");
  requireText(indexHtml, MONTCLAIR_FOOTER_TEXT, "dist/index.html");
}

for (const forbidden of [
  'href="/favicon.svg"',
  'type="image/svg+xml"',
  'class="launch-head"',
  'class="launch-hero"',
  "Core NJ PBS links for watching",
  "Montclair is preparing the next NJ PBS website",
]) {
  forbidText(indexHtml, forbidden, "dist/index.html");
}

const distFavicon = path.join(distRoot, "favicon.png");
fileMustExist(distFavicon);
requireApprovedFaviconHash(distFavicon);
if (fs.existsSync(distFavicon)) requireTransparentCircleFavicon(distFavicon);
if (fs.existsSync(distFavicon) && fs.existsSync(brandingFavicon)) {
  const distHash = sha256(distFavicon);
  const brandingHash = sha256(brandingFavicon);
  if (distHash !== brandingHash) {
    fail(
      `dist/favicon.png hash ${distHash} does not match branding/njpbs-favicon.png ${brandingHash}`,
    );
  }
}
fileMustNotExist(path.join(distRoot, "favicon.svg"));

const distOgImage = path.join(distRoot, "og-default.png");
fileMustExist(distOgImage);
requirePngDimensions(distOgImage, 1200, 630);

if (checkProductionContent("watch")) {
  const watchHtml = read(path.join(distRoot, "watch", "index.html"));
  requireText(watchHtml, "Find NJ PBS programs, PBS series, full episodes, specials, and Passport video on demand.", "dist/watch/index.html");
  requireText(watchHtml, `href="${hrefForHtml(PBS_VIDEO_URL)}"`, "dist/watch/index.html");
  requireText(watchHtml, "Learn about the member streaming benefit and account help.", "dist/watch/index.html");
  requireText(watchHtml, `href="${hrefForHtml(PASSPORT_LEARN_MORE_URL)}"`, "dist/watch/index.html");
  requireText(watchHtml, 'href="/live/"', "dist/watch/index.html");
  forbidText(watchHtml, 'href="/video/"', "dist/watch/index.html");
  forbidText(watchHtml, "account handoff", "dist/watch/index.html");
}

if (checkProductionContent("live")) {
  const liveHtml = normalizeHtmlEntities(read(path.join(distRoot, "live", "index.html")));
  const builtCssRoot = path.join(distRoot, "_astro");
  const builtCss = fs.existsSync(builtCssRoot)
    ? fs
        .readdirSync(builtCssRoot)
        .filter((file) => file.endsWith(".css"))
        .map((file) => read(path.join(builtCssRoot, file)))
        .join("\n")
    : "";
  requireText(liveHtml, PBS_LIVESTREAM_EMBED_URL, "dist/live/index.html");
  requireText(liveHtml, 'href="/schedule/"', "dist/live/index.html");
  requireText(liveHtml, 'href="/watch/"', "dist/live/index.html");
  requireText(liveHtml, 'class="public-page__player"', "dist/live/index.html");
  requireText(liveHtml, 'class="public-page__player-frame"', "dist/live/index.html");
  requirePattern(
    liveHtml,
    /<section class="public-page__player-section"[^>]*aria-labelledby="pbs-player-heading"/,
    "the heading-labeled player section",
    "dist/live/index.html",
  );
  requireText(liveHtml, 'id="pbs-player-heading"', "dist/live/index.html");
  requirePattern(
    liveHtml,
    /<iframe[^>]*title="PBS livestream"[^>]*aria-describedby="pbs-player-description pbs-player-keyboard-help"/,
    "the titled and described PBS livestream iframe",
    "dist/live/index.html",
  );
  requireText(liveHtml, 'id="pbs-player-keyboard-help"', "dist/live/index.html");
  requirePattern(
    liveHtml,
    /<div class="public-page__player-frame"[^>]*role="group"[^>]*aria-label="PBS livestream player frame"[^>]*aria-describedby="pbs-player-keyboard-help"[^>]*tabindex="0"/,
    "the named, described, focusable player frame",
    "dist/live/index.html",
  );
  requireText(
    liveHtml,
    'href="#pbs-player-alternative-app"',
    "dist/live/index.html",
  );
  requireText(liveHtml, 'id="pbs-player-alternatives"', "dist/live/index.html");
  requireText(liveHtml, 'id="pbs-player-alternative-app"', "dist/live/index.html");
  requireText(liveHtml, 'id="pbs-player-description"', "dist/live/index.html");
  requireCssRule(
    builtCss,
    ".public-page__player-frame:focus-visible",
    ["outline:var(--focus-outline)", "outline-offset:var(--focus-offset)"],
    "dist/_astro/*.css",
  );
  requireCssRule(
    builtCss,
    ".public-page__player-frame iframe:focus-visible",
    ["outline:var(--focus-outline)", "outline-offset:var(--focus-offset)"],
    "dist/_astro/*.css",
  );
  requireText(liveHtml, 'class="public-page__card-media"', "dist/live/index.html");
  requireText(liveHtml, 'data-now-next-variant="compact"', "dist/live/index.html");
  requireText(liveHtml, 'allow="geolocation; encrypted-media"', "dist/live/index.html");
  requireText(liveHtml, "NJ PBS broadcast stream", "dist/live/index.html");
  forbidText(liveHtml, 'href="/video/"', "dist/live/index.html");
  // The external PBS station schedule router loops back to the local native
  // schedule, so local pages must never link out to it.
  forbidText(liveHtml, hrefForHtml(PBS_SCHEDULE_URL), "dist/live/index.html");
}
fileMustNotExist(path.join(distRoot, "video", "index.html"), "dist/video/index.html");

if (checkProductionContent("schedule")) {
  const scheduleHtml = normalizeHtmlEntities(read(path.join(distRoot, "schedule", "index.html")));
  requireText(scheduleHtml, "data-native-schedule", "dist/schedule/index.html");
  requireText(scheduleHtml, 'data-now-next-variant="full"', "dist/schedule/index.html");
  requireText(scheduleHtml, 'role="progressbar"', "dist/schedule/index.html");
  requireText(scheduleHtml, "data-schedule-day-switcher", "dist/schedule/index.html");
  requireText(scheduleHtml, "data-schedule-timeline", "dist/schedule/index.html");
  requireText(scheduleHtml, "Full broadcast day", "dist/schedule/index.html");
  requireText(scheduleHtml, "Listings supplied by PBS", "dist/schedule/index.html");
  requireText(scheduleHtml, "data-schedule-empty-state", "dist/schedule/index.html");
  requireText(scheduleHtml, "data-kids-empty-state", "dist/schedule/index.html");
  forbidText(scheduleHtml, 'id="tvschedule"', "dist/schedule/index.html");
  forbidText(scheduleHtml, 'id="jaws_whatson"', "dist/schedule/index.html");
  forbidText(scheduleHtml, 'id="jaws_whatsonkids"', "dist/schedule/index.html");
  forbidText(scheduleHtml, "jaws-prod.cdn.pbs.org/js/gc.js", "dist/schedule/index.html");
  forbidText(scheduleHtml, "PBS_CHROME_CONFIG", "dist/schedule/index.html");
  forbidText(scheduleHtml, 'class="public-page__schedule-fallback"', "dist/schedule/index.html");
  forbidText(scheduleHtml, hrefForHtml(PBS_SCHEDULE_URL), "dist/schedule/index.html");
}

if (checkProductionContent("give")) {
  const giveHtml = normalizeHtmlEntities(read(path.join(distRoot, "give", "index.html")));
  if (!serviceDonationLinks(giveHtml, DONATE_URL, "give").composed) {
    requireText(giveHtml, "Give to NJ PBS", "dist/give/index.html");
  }
  requireServiceDonateLinks(
    giveHtml,
    "give",
    "dist/give/index.html Donate links",
  );
}

if (checkProductionContent("support")) {
  const supportHtml = normalizeHtmlEntities(read(path.join(distRoot, "support", "index.html")));
  requireServiceDonateLinks(
    supportHtml,
    "support",
    "dist/support/index.html Donate links",
  );
}

const donateHtml = normalizeHtmlEntities(read(path.join(distRoot, "donate", "index.html")));
requireText(donateHtml, 'rel="canonical" href="https://njpbs.org/give/"', "dist/donate/index.html");
requireText(donateHtml, 'property="og:url" content="https://njpbs.org/give/"', "dist/donate/index.html");
if (checkProductionContent("give")) {
  requireServiceDonateLinks(
    donateHtml,
    "give",
    "dist/donate/index.html Donate links",
  );
}

if (checkProductionContent("passport")) {
  const passportHtml = normalizeHtmlEntities(read(path.join(distRoot, "passport", "index.html")));
  requireServiceDonateLinks(
    passportHtml,
    "passport",
    "dist/passport/index.html Donate links",
  );
}

const sitemapIndex = read(path.join(distRoot, "sitemap-index.xml"));
forbidText(sitemapIndex, "/donate/", "dist/sitemap-index.xml");
const sitemap = read(path.join(distRoot, "sitemap-0.xml"));
requireText(sitemap, "https://njpbs.org/give/", "dist/sitemap-0.xml");
forbidText(sitemap, "https://njpbs.org/donate/", "dist/sitemap-0.xml");

if (checkProductionContent("faq")) {
  const faqHtml = normalizeHtmlEntities(read(path.join(distRoot, "faq", "index.html")));
  requireText(faqHtml, "What is changing at NJ PBS?", "dist/faq/index.html");
  requireText(faqHtml, "Beginning July 1, 2026, Montclair State University is the new operator of NJ PBS.", "dist/faq/index.html");
  requireText(faqHtml, 'name="robots" content="noindex, nofollow"', "dist/faq/index.html");
  requireText(faqHtml, DONATE_URL, "dist/faq/index.html");
  requireText(faqHtml, `href="${NJPBS_EMAIL_URL}"`, "dist/faq/index.html");
  requireText(faqHtml, 'href="tel:+18008826622"', "dist/faq/index.html");
  forbidText(faqHtml, "Member email draft", "dist/faq/index.html");
  forbidText(faqHtml, "Internal Slack post", "dist/faq/index.html");
}

if (checkProductionContent("contact")) {
  const contactHtml = read(path.join(distRoot, "contact", "index.html"));
  requireText(contactHtml, 'name="robots" content="noindex, nofollow"', "dist/contact/index.html");
  requireText(contactHtml, `href="${NJPBS_EMAIL_URL}"`, "dist/contact/index.html");
  requireText(contactHtml, 'href="tel:+18008826622"', "dist/contact/index.html");
  requireText(contactHtml, 'href="/faq/"', "dist/contact/index.html");
  requireText(contactHtml, 'href="/accessibility/"', "dist/contact/index.html");
  forbidText(contactHtml, 'href="faq.md"', "dist/contact/index.html");
  forbidText(contactHtml, 'href="accessibility.md"', "dist/contact/index.html");
  forbidText(contactHtml, 'href="closed-captioning.md"', "dist/contact/index.html");
  forbidText(contactHtml, 'href="public-file.md"', "dist/contact/index.html");
  forbidText(contactHtml, 'href="mailto:njpbs@montclair.edu" rel="noopener" target="_blank"', "dist/contact/index.html");
  forbidText(contactHtml, 'href="mailto:njpbs@montclair.edu?subject=NJ%20PBS%20question" rel="noopener" target="_blank"', "dist/contact/index.html");
  forbidText(contactHtml, "Prototype page", "dist/contact/index.html");
}

// The launch artifact must not emit any retired prototype page, including
// noindex routes that would still be publicly reachable.
fileMustNotExist(path.join(distRoot, "prototype"), "dist/prototype");

if (failures.length > 0) {
  console.error("public contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Public contract passed: the cinematic homepage, PNG favicon, and native schedule are locked");
}
