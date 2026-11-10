import { NJ_DECIDES_LOGO } from "../../../packages/content-core/src/nj-decides";

export const DESIGN_SYSTEM_VERSION = "0.3.1";

export const DESIGN_TOKEN_CATEGORIES = [
  "Palette foundations",
  "Semantic colors",
  "Component colors and gradients",
  "Typography",
  "Layout and spacing",
  "Shape and focus",
  "Motion",
] as const;

export type DesignTokenCategory = (typeof DESIGN_TOKEN_CATEGORIES)[number];
export type DesignTokenPreview = "paint" | "value";

export const DESIGN_ASSET_GROUPS = [
  "Brand marks",
  "Topic and campaign art",
  "Homepage entry-point art",
  "Background and map art",
  "Site identity and sharing",
] as const;

export type DesignAssetGroup = (typeof DESIGN_ASSET_GROUPS)[number];

export interface DesignToken {
  category: DesignTokenCategory;
  name: `--${string}`;
  preview: DesignTokenPreview;
  value: string;
}

export interface DesignAsset {
  alt: string;
  avoid: string;
  background: "light" | "dark" | "neutral";
  format: "JPEG" | "PNG" | "SVG" | "WEBP";
  group: DesignAssetGroup;
  id: string;
  name: string;
  path: `/${string}`;
  status: "official" | "production";
  use: string;
  version: string;
  width: number;
  height: number;
}

export interface DesignFontAsset {
  format: "WOFF2";
  id: string;
  name: string;
  path: `https://media.njpbs.org/cms-media/fonts/${string}`;
  status: "production";
  use: string;
  version: string;
  weight: number;
}

const COMPONENT_COLOR_PREFIXES = [
  "color-schedule-",
  "color-map-",
  "color-hero-",
  "color-badge-",
  "tile-gradient-",
] as const;

const PALETTE_FOUNDATIONS = new Set([
  "pbs-blue",
  "pbs-blue-bright",
  "focus",
  "bg-0",
  "bg-1",
  "bg-2",
  "bg-now",
  "text",
  "text-dim",
  "text-quiet",
  "line",
  "line-strong",
  "ink",
  "action-red",
  "status-green",
  "progress-track",
  "color-white",
  "color-black",
  "color-paper",
  "color-print-ink",
  "color-nj-green",
  "color-theme-navy",
]);

export function categorizeDesignToken(name: string): DesignTokenCategory {
  if (name.startsWith("motion-")) return "Motion";
  if (name.startsWith("radius-") || name.startsWith("focus-")) {
    return "Shape and focus";
  }
  if (
    name === "wrap" ||
    name === "gutter" ||
    name.startsWith("space-") ||
    name.startsWith("target-")
  ) {
    return "Layout and spacing";
  }
  if (
    name.startsWith("font-") ||
    name.startsWith("heading-") ||
    name.startsWith("number-")
  ) {
    return "Typography";
  }
  if (COMPONENT_COLOR_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "Component colors and gradients";
  }
  if (PALETTE_FOUNDATIONS.has(name)) return "Palette foundations";
  return "Semantic colors";
}

export function parseDesignTokens(source: string): DesignToken[] {
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map<string, DesignToken>();

  for (const match of uncommented.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const plainName = match[1]?.toLowerCase();
    const value = match[2]?.trim();
    if (!plainName || !value || tokens.has(plainName)) continue;
    const category = categorizeDesignToken(plainName);
    tokens.set(plainName, {
      category,
      name: `--${plainName}`,
      preview:
        category === "Palette foundations" ||
        category === "Semantic colors" ||
        category === "Component colors and gradients"
          ? "paint"
          : "value",
      value,
    });
  }

  return [...tokens.values()];
}

export function groupDesignTokens(tokens: readonly DesignToken[]) {
  return DESIGN_TOKEN_CATEGORIES.map((category) => ({
    category,
    tokens: tokens.filter((token) => token.category === category),
  })).filter((group) => group.tokens.length > 0);
}

const MARK_AVOID =
  "Do not recolor, stretch, crop, rotate, or rebuild the mark from text.";
const TOPIC_ART_AVOID =
  "Do not use as evidence of a specific event, person, or location.";

const SPOTLIGHT_TOPICS = [
  ["about", "About NJ Spotlight News"],
  ["budget", "Budget"],
  ["business", "Business"],
  ["contact", "Contact"],
  ["education", "Education"],
  ["energy-environment", "Energy and environment"],
  ["give", "Give"],
  ["healthcare", "Healthcare"],
  ["housing", "Housing"],
  ["immigration", "Immigration"],
  ["law-public-safety", "Law and public safety"],
  ["more-issues", "More issues"],
  ["nj-decides", "NJ Decides"],
  ["opinion", "Opinion"],
  ["passport", "Passport"],
  ["politics", "Politics"],
  ["social-issues", "Social issues"],
  ["sponsored-content", "Sponsored content"],
  ["support", "Support"],
  ["under-the-dome", "Under the Dome"],
  ["watch", "Watch"],
] as const;

const SPOTLIGHT_ROTATION_TOPICS = new Set<string>([
  "budget",
  "business",
  "education",
  "energy-environment",
  "healthcare",
  "immigration",
  "law-public-safety",
  "more-issues",
  "nj-decides",
  "opinion",
  "politics",
  "social-issues",
  "under-the-dome",
  "watch",
]);

const START_HERE_ASSETS = [
  ["kids", "Kids"],
  ["live", "Live TV"],
  ["ondemand", "On demand"],
  ["schedule", "Schedule"],
] as const;

const HERO_ASSETS = [
  ["nj-evening", "New Jersey evening field"],
  ["nj-shore", "New Jersey shore field"],
  ["nj-studio", "Public media studio field"],
] as const;

export const DESIGN_ASSETS: readonly DesignAsset[] = [
  {
    id: "nj-decides-2026",
    name: "NJ Decides 2026",
    alt: NJ_DECIDES_LOGO.alt,
    path: NJ_DECIDES_LOGO.src,
    width: NJ_DECIDES_LOGO.width,
    height: NJ_DECIDES_LOGO.height,
    background: "light",
    format: NJ_DECIDES_LOGO.format,
    group: "Topic and campaign art",
    status: "production",
    version: "2026-10-26",
    use: "Election coverage. Keep the supplied transparent logo on white or the approved light election field.",
    avoid: "Do not recolor, crop or stretch. Do not replace the NJ PBS station mark.",
  },
  {
    id: "nj-decides-2026-reversed", name: "NJ Decides 2026 reversed", alt: NJ_DECIDES_LOGO.alt,
    path: NJ_DECIDES_LOGO.reversedSrc, width: NJ_DECIDES_LOGO.width, height: NJ_DECIDES_LOGO.height,
    background: "dark", format: NJ_DECIDES_LOGO.format, group: "Topic and campaign art",
    status: "production", version: "2026-10-26", use: "Election identity for dark backgrounds. Staff can choose a Media library override.",
    avoid: "Do not recolor, crop or stretch. Do not replace the NJ PBS station mark.",
  },
  {
    id: "njpbs-horizontal-white",
    name: "NJ PBS horizontal white lockup",
    group: "Brand marks",
    path: "/brand/njpbs-horizontal-white.svg",
    format: "SVG",
    status: "official",
    version: "baseline",
    use: "Horizontal lockup for dark or PBS blue backgrounds.",
    avoid: MARK_AVOID,
    alt: "NJ PBS",
    background: "dark",
    width: 785,
    height: 215,
  },
  {
    id: "njpbs-vertical-white",
    name: "NJ PBS vertical white lockup",
    group: "Brand marks",
    path: "/brand/njpbs-vertical-white.svg",
    format: "SVG",
    status: "official",
    version: "baseline",
    use: "Compact or portrait-oriented lockup on dark or PBS blue backgrounds.",
    avoid: MARK_AVOID,
    alt: "NJ PBS",
    background: "dark",
    width: 496,
    height: 371,
  },
  {
    id: "pbs-blue-art",
    name: "PBS blue brand artwork",
    group: "Brand marks",
    path: "/brand/pbs-blue.svg",
    format: "SVG",
    status: "production",
    version: "baseline",
    use: "Checked-in PBS blue artwork used by the current web implementation.",
    avoid: MARK_AVOID,
    alt: "PBS brand artwork",
    background: "light",
    width: 792,
    height: 612,
  },
  {
    id: "njpbs-horizontal-white-navy-png",
    name: "NJ PBS horizontal white lockup on navy — PNG",
    group: "Brand marks",
    path: "/brand/njpbs-horizontal-white-navy.png",
    format: "PNG",
    status: "production",
    version: "baseline",
    use: "Raster fallback for systems that cannot use SVG, including staff email and structured data.",
    avoid: "Use the SVG lockup when the destination supports it. " + MARK_AVOID,
    alt: "NJ PBS",
    background: "dark",
    width: 816,
    height: 277,
  },
  {
    id: "njpbs-passport-horizontal-navy",
    name: "NJ PBS Passport horizontal navy lockup",
    group: "Brand marks",
    path: "/brand/njpbs-passport-horizontal-navy.png",
    format: "PNG",
    status: "official",
    version: "baseline",
    use: "Passport-specific lockup for approved membership and streaming contexts.",
    avoid: "Do not use for general NJ PBS promotion. " + MARK_AVOID,
    alt: "NJ PBS Passport",
    background: "light",
    width: 3648,
    height: 500,
  },
  {
    id: "pbs-white-art",
    name: "PBS white brand artwork",
    group: "Brand marks",
    path: "/brand/pbs-white.svg",
    format: "SVG",
    status: "production",
    version: "baseline",
    use: "Checked-in white PBS artwork for dark-background web contexts.",
    avoid: MARK_AVOID,
    alt: "PBS brand artwork",
    background: "dark",
    width: 792,
    height: 612,
  },
  {
    id: "pbs-passport-compass",
    name: "PBS Passport compass",
    group: "Brand marks",
    path: "/brand/pbs-passport-compass.png",
    format: "PNG",
    status: "official",
    version: "baseline",
    use: "Passport compass artwork for approved membership and streaming contexts.",
    avoid: "Do not use as a general PBS or NJ PBS mark. " + MARK_AVOID,
    alt: "PBS Passport compass",
    background: "neutral",
    width: 500,
    height: 500,
  },
  ...SPOTLIGHT_TOPICS.map(([slug, label]) => ({
    id: `spotlight-${slug}`,
    name: `${label} topic artwork`,
    group: "Topic and campaign art" as const,
    path: `/brand/spotlight/${slug}.jpg` as const,
    format: "JPEG" as const,
    status: "production" as const,
    version: "baseline",
    use: `Fallback editorial art for the ${label} topic or destination.`,
    avoid: TOPIC_ART_AVOID,
    alt: `Topic artwork for ${label}`,
    background: "neutral" as const,
    width: 640,
    height: 360,
  })),
  ...SPOTLIGHT_TOPICS.filter(([slug]) =>
    SPOTLIGHT_ROTATION_TOPICS.has(slug),
  ).map(([slug, label]) => ({
    id: `spotlight-${slug}-02`,
    name: `${label} topic artwork — alternate 2`,
    group: "Topic and campaign art" as const,
    path: `/brand/spotlight/${slug}-02.jpg` as const,
    format: "JPEG" as const,
    status: "production" as const,
    version: "rotation-2",
    use: `Alternate fallback editorial art for the ${label} topic or destination.`,
    avoid: TOPIC_ART_AVOID,
    alt: `Topic artwork for ${label}`,
    background: "neutral" as const,
    width: 640,
    height: 360,
  })),
  ...START_HERE_ASSETS.map(([slug, label]) => ({
    id: `start-here-${slug}`,
    name: `${label} entry-point artwork`,
    group: "Homepage entry-point art" as const,
    path: `/brand/starthere/${slug}.webp` as const,
    format: "WEBP" as const,
    status: "production" as const,
    version: "baseline",
    use: `Homepage Start Here card artwork for ${label}.`,
    avoid: "Do not detach from its labeled homepage destination without editorial review.",
    alt: `${label} entry-point artwork`,
    background: "neutral" as const,
    width: 800,
    height: 450,
  })),
  ...HERO_ASSETS.map(([slug, label]) => ({
    id: `hero-${slug}`,
    name: label,
    group: "Background and map art" as const,
    path: `/hero/${slug}.svg` as const,
    format: "SVG" as const,
    status: "production" as const,
    version: "baseline",
    use: "Abstract public-site hero background; keep foreground copy separate and readable.",
    avoid: "Do not present as documentary photography or evidence of a real location.",
    alt: label,
    background: "neutral" as const,
    width: 1600,
    height: 1000,
  })),
  {
    id: "nj-static-map",
    name: "New Jersey point-field map",
    group: "Background and map art",
    path: "/nj-static.svg",
    format: "SVG",
    status: "production",
    version: "baseline",
    use: "Static New Jersey point-field artwork for public-site framing.",
    avoid: "Do not use as a geographic boundary, coverage map, or data visualization.",
    alt: "Map of New Jersey rendered as a field of points",
    background: "light",
    width: 420,
    height: 740,
  },
  {
    id: "nj-static-signal-map",
    name: "New Jersey signal point-field map",
    group: "Background and map art",
    path: "/nj-static-signal.svg",
    format: "SVG",
    status: "production",
    version: "baseline",
    use: "Signal-styled New Jersey point-field artwork for public-site framing.",
    avoid: "Do not use as a geographic boundary, coverage map, or measured signal visualization.",
    alt: "Map of New Jersey rendered as a field of signal points",
    background: "light",
    width: 420,
    height: 740,
  },
  {
    id: "site-favicon",
    name: "NJ PBS site favicon",
    group: "Site identity and sharing",
    path: "/favicon.png",
    format: "PNG",
    status: "production",
    version: "baseline",
    use: "Current browser and bookmark identity for njpbs.org.",
    avoid: "Do not substitute it for a full lockup or enlarge it as editorial artwork.",
    alt: "NJ PBS site icon",
    background: "light",
    width: 447,
    height: 447,
  },
  {
    id: "default-social-card",
    name: "Default NJ PBS social card",
    group: "Site identity and sharing",
    path: "/og-default.png",
    format: "PNG",
    status: "production",
    version: "baseline",
    use: "Default Open Graph image when a public page has no approved social image.",
    avoid: "Do not use when a page has specific, approved social artwork.",
    alt: "Default NJ PBS social sharing card",
    background: "neutral",
    width: 1200,
    height: 630,
  },
] as const;

export function groupDesignAssets(assets: readonly DesignAsset[]) {
  return DESIGN_ASSET_GROUPS.map((group) => ({
    group,
    assets: assets.filter((asset) => asset.group === group),
  })).filter((entry) => entry.assets.length > 0);
}

const FONT_FILES = [
  ["regular", "PBS Sans Regular", "https://media.njpbs.org/cms-media/fonts/6d1461f427c030aed42aaa039eb8ce7409a261a7a62e46ff0854d7c79db00123/PBSSans.woff2", 400],
  ["light", "PBS Sans Light", "https://media.njpbs.org/cms-media/fonts/f5b121c412775fea2088ea19d170364abf29e7db73a541259b517be880784a9b/PBSSans-Light.woff2", 300],
  ["medium", "PBS Sans Medium", "https://media.njpbs.org/cms-media/fonts/1a6fab5544c4b6b5d57d60e4c2e9a1d82488a4a510a54b6ec652e77261627cc1/PBSSans-Medium.woff2", 500],
  ["bold", "PBS Sans Bold", "https://media.njpbs.org/cms-media/fonts/d2a1a10beac03a9cf986714d6388978379efaa9d9b4a662ec374b262104851b5/PBSSans-Bold.woff2", 700],
  ["black", "PBS Sans Black", "https://media.njpbs.org/cms-media/fonts/5b13467ba9da8daed32c4989a1f46bb11ece667e4607b9552c74315368b98cc9/PBSSans-Black.woff2", 900],
] as const;

export const DESIGN_FONT_ASSETS: readonly DesignFontAsset[] = FONT_FILES.map(
  ([id, name, path, weight]) => ({
  id: `pbs-sans-${id}`,
  name,
  path,
  format: "WOFF2" as const,
  status: "production" as const,
  version: "baseline",
  use: "Media-hosted font file; no source-distribution license is granted. Use the existing PBS Sans family declarations rather than creating a second font stack.",
  weight,
  }),
);
