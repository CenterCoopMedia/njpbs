import { isExactHttpsUrl } from "./exact-https-url.ts";

export const CONTENT_LINK_URL_MAX = 2048;
export interface ContentLinkMetadata {
  contentLinkMode?: "normal" | "custom";
  contentLinkUrl?: string;
  contentLinkNewTab?: boolean;
}

/** Shared by the editor, published projections, listings and redirect responses. */
export function contentLinkError(value: Record<string, unknown>): string | null {
  if (value.contentLinkMode !== undefined && !(typeof value.contentLinkMode === "string" && ["normal", "custom"].includes(value.contentLinkMode))) return "Choose the normal NJ PBS address or a custom URL.";
  if (value.contentLinkNewTab !== undefined && typeof value.contentLinkNewTab !== "boolean") return "Open in a new tab must be on or off.";
  if (value.contentLinkUrl !== undefined && (typeof value.contentLinkUrl !== "string" || value.contentLinkUrl.length > CONTENT_LINK_URL_MAX)) return "The custom URL must be at most 2,048 characters.";
  if (value.contentLinkMode === "custom" && (!isExactHttpsUrl(value.contentLinkUrl, CONTENT_LINK_URL_MAX) || value.contentLinkUrl.includes("\\"))) return "Enter a full https:// address without a username or password.";
  if (value.contentLinkMode === "custom" && new URL(value.contentLinkUrl as string).href.length > CONTENT_LINK_URL_MAX) return "The custom URL must be at most 2,048 characters.";
  return null;
}

export function contentLinkMetadata(value: Record<string, unknown>): ContentLinkMetadata {
  const error = contentLinkError(value);
  if (error) throw new Error(error);
  return {
    ...(value.contentLinkMode === undefined ? {} : { contentLinkMode: value.contentLinkMode as "normal" | "custom" }),
    ...(value.contentLinkUrl === undefined ? {} : { contentLinkUrl: value.contentLinkUrl as string }),
    ...(value.contentLinkNewTab === undefined ? {} : { contentLinkNewTab: value.contentLinkNewTab as boolean }),
  };
}

export function contentLink(value: ContentLinkMetadata, normalHref: string) {
  const error = contentLinkError(value as Record<string, unknown>);
  if (error) throw new Error(error);
  const external = value.contentLinkMode === "custom";
  const newTab = external && value.contentLinkNewTab !== false;
  return { href: external ? new URL(value.contentLinkUrl!).href : normalHref, external, newTab,
    ...(newTab ? { target: "_blank" as const, rel: "noopener noreferrer" as const } : {}) };
}

/** A temporary redirect permits staff to restore the retained NJ PBS body later. */
export function contentLinkRedirect(value: ContentLinkMetadata, headers: HeadersInit = {}): Response | null {
  const link = contentLink(value, "");
  if (!link.external) return null;
  const result = new Headers(headers);
  result.set("Location", link.href);
  result.set("X-Robots-Tag", "noindex, nofollow");
  result.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: result });
}

/** The address directory has its own budget; it cannot consume body headroom. */
export const CONTENT_LINK_DIRECTORY_MAX_BYTES = 1024 * 1024;
export function contentLinkDirectoryFits(entries: unknown): boolean {
  return Array.isArray(entries) && entries.length <= 1000 && new TextEncoder().encode(JSON.stringify(entries)).length <= CONTENT_LINK_DIRECTORY_MAX_BYTES;
}
export function contentLinkReadFits(value: Record<string, unknown>, contentMaxBytes: number, directoryContainer?: "published" | "renderContext"): boolean {
  const nested = directoryContainer && value[directoryContainer];
  const source = nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : value;
  const { contentLinks, ...content } = source;
  const envelope = source === value ? content : { ...value, [directoryContainer!]: content };
  return (contentLinks === undefined || contentLinkDirectoryFits(contentLinks)) &&
    new TextEncoder().encode(JSON.stringify(envelope)).length <= contentMaxBytes;
}
