import { postCardImage } from "../../../packages/content-core/src/post-card-image.ts";
import { NJ_DECIDES_LOGO } from "../../../packages/content-core/src/nj-decides.ts";
import { visibleLayoutBlocks, type LayoutBlock } from "../../../packages/content-core/src/content-layout.ts";
import { LIVE_BLOG_BRANDING } from "../../../packages/content-core/src/live-blog.ts";

/** Bundled, crawlable artwork; titles and descriptions stay in page metadata. */
export const NJ_DECIDES_SOCIAL_IMAGES = {
  hub: { url: "/brand/nj-decides/social-hub.png", label: "Election coverage",
    alt: `${NJ_DECIDES_LOGO.alt}: Election coverage from NJ PBS` },
  results: { url: "/brand/nj-decides/social-results.png", label: "Election results",
    alt: `${NJ_DECIDES_LOGO.alt}: Election results from NJ PBS` },
  post: { url: "/brand/nj-decides/social-post.png", label: "Election reporting",
    alt: `${NJ_DECIDES_LOGO.alt}: Election reporting from NJ PBS` },
} as const;

export interface SocialImageContent {
  title: string;
  social?: { title?: string; imageAssetId?: string };
  assets: Readonly<Record<string, { url: string }>>;
  heroImage?: { url: string } | null;
  heroImageAlt?: string;
  heroImageDecorative?: boolean;
  leadMedia?: unknown;
}

interface ElectionSocialContent extends SocialImageContent {
  kind: "page" | "post";
  path?: string;
  blocks?: readonly LayoutBlock[];
  categories?: readonly string[];
  tags?: readonly string[];
  liveBlog?: { branding?: string };
}

export function njDecidesSocialVariant(content: ElectionSocialContent): keyof typeof NJ_DECIDES_SOCIAL_IMAGES | undefined {
  const hubRoot = /^\/nj-decides(?:-2026)?\/?$/;
  const hubPath = /^\/nj-decides(?:-2026)?(?:\/|$)/;
  if (content.kind === "page" && hubRoot.test(content.path ?? "")) return "hub";
  if (visibleLayoutBlocks(content.blocks ?? []).some(block => block.type === "election_results")) return "results";
  if (content.kind === "page") return hubPath.test(content.path ?? "") ? "hub" : undefined;
  // Generic election labels also occur on archives; only opt into this election's identity.
  const marked = [...content.categories ?? [], ...content.tags ?? []].some(value =>
    value.trim().toLowerCase().replace(/[\s_]+/g, "-") === LIVE_BLOG_BRANDING);
  return content.liveBlog?.branding === LIVE_BLOG_BRANDING || marked ? "post" : undefined;
}

export function resolveNjDecidesSocialImage(content: ElectionSocialContent | undefined) {
  return content ? selectSocialImage(content, njDecidesSocialVariant(content)) : undefined;
}

/** An explicit image selection retains the existing missing-asset behavior. */
export function selectSocialImage(content: SocialImageContent,
  election?: keyof typeof NJ_DECIDES_SOCIAL_IMAGES): { url: string; alt: string } | undefined {
  const selected = content.social?.imageAssetId;
  if (selected) {
    const url = content.assets[selected]?.url;
    return url ? { url, alt: content.social?.title?.trim() || content.title } : undefined;
  }
  if (election) return NJ_DECIDES_SOCIAL_IMAGES[election];
  const selectedImage = postCardImage(content);
  return selectedImage ? { url: selectedImage.image.url, alt: selectedImage.alt || content.title } : undefined;
}
