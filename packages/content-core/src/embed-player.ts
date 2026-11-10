// Pure provider admission shared by rendering and server-side lead validation.
import { extractPartnerPlayerSrc } from "./partner-player.ts";
import { pbsPlayerPermissions } from "./player-permissions.ts";
export { apResultsLayoutSrc } from "./ap-results-layout.ts";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"]);
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/**
 * The player URL for a YouTube video, live video, or channel live stream link (or
 * YouTube's pasted iframe code), or null for anything else. The src is rebuilt from a validated id, never copied.
 */
export function youtubePlayerSrc(url: string): string | null {
  const parsed = pastedPlayerUrl(url);
  if (!parsed || !YOUTUBE_HOSTS.has(parsed.hostname)) return null;
  const [first = "", second = "", third = ""] = parsed.pathname.split("/").filter(Boolean);
  const channel = first === "channel" && third === "live" ? second
    : first === "embed" && second === "live_stream" ? parsed.searchParams.get("channel") ?? ""
    : "";
  if (YOUTUBE_CHANNEL_ID.test(channel)) {
    return `https://www.youtube.com/embed/live_stream?channel=${channel}`;
  }
  const id = parsed.hostname === "youtu.be" ? first
    : first === "watch" ? parsed.searchParams.get("v") ?? ""
    : ["live", "embed", "shorts"].includes(first) ? second
    : "";
  if (!YOUTUBE_VIDEO_ID.test(id)) return null;
  const start = youtubeStartSeconds(parsed.searchParams.get("start") ?? parsed.searchParams.get("t"));
  return `https://www.youtube-nocookie.com/embed/${id}${start > 0 ? `?start=${start}` : ""}`;
}

function pastedPlayerUrl(url: string): URL | null {
  // Read only the link from iframe code; no pasted HTML or attributes are trusted.
  const pasted = (/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(url)?.[1] ?? url).trim().replaceAll("&amp;", "&");
  const link = /^(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(pasted) ? `https://${pasted}`
    : pasted.startsWith("//") ? `https:${pasted}`
    : pasted;
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  return parsed;
}

interface EmbedPlayer {
  src: string;
  title: string;
  allow: string;
  vertical?: boolean;
}

function facebookVideoUrl(url: URL): string | null {
  if (!["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"].includes(url.hostname)) return null;
  const reel = /^\/reel\/(\d{1,25})\/?$/.exec(url.pathname);
  if (reel) return `https://www.facebook.com/reel/${reel[1]}/`;
  const path = /^\/([A-Za-z0-9._-]+)\/videos\/(?:[A-Za-z0-9_-]+\/)?(\d{1,25})\/?$/.exec(url.pathname);
  if (path) return `https://www.facebook.com/${path[1]}/videos/${path[2]}/`;
  const id = url.searchParams.get("v") ?? "";
  if (/^\/(?:watch\/?|video\.php)$/.test(url.pathname) && /^\d{1,25}$/.test(id)) {
    return `https://www.facebook.com/watch/?v=${id}`;
  }
  return null;
}

/** Provider hosts and video IDs are checked before constructing a player URL. */
export function embedPlayer(value: string, allowAutoplay = true): EmbedPlayer | null {
  const url = pastedPlayerUrl(value);
  if (!url) return null;
  const youtube = youtubePlayerSrc(value);
  if (youtube) return { src: youtube, title: "YouTube video player", allow: "autoplay; encrypted-media; picture-in-picture; web-share" };
  switch (url.hostname) {
    case "vimeo.com":
    case "www.vimeo.com":
    case "player.vimeo.com": {
      const path = url.hostname === "player.vimeo.com"
        ? /^\/video\/(\d{1,12})\/?$/
        : /^\/(?:channels\/[A-Za-z0-9_-]+\/|groups\/[A-Za-z0-9_-]+\/videos\/)?(\d{1,12})(?:\/([0-9a-f]{6,64}))?\/?$/i;
      const match = path.exec(url.pathname);
      if (!match) return null;
      const hash = match[2] ?? url.searchParams.get("h");
      if (hash !== null && !/^[0-9a-f]{6,64}$/i.test(hash)) return null;
      // Unlisted videos need their privacy hash before other player parameters.
      const query = hash ? `h=${hash}&dnt=1` : "dnt=1";
      return { src: `https://player.vimeo.com/video/${match[1]}?${query}`, title: "Vimeo video player", allow: "autoplay; fullscreen; picture-in-picture; encrypted-media" };
    }
    case "tiktok.com":
    case "www.tiktok.com": {
      const id = /^\/(?:@[A-Za-z0-9._-]+\/video|embed\/v2|player\/v1)\/(\d{10,25})\/?$/.exec(url.pathname)?.[1];
      return id ? { src: `https://www.tiktok.com/embed/v2/${id}`, title: "TikTok video player", allow: "autoplay; fullscreen; picture-in-picture", vertical: true } : null;
    }
    case "instagram.com":
    case "www.instagram.com": {
      const path = /^\/(p|reel)\/([A-Za-z0-9_-]{5,64})(?:\/embed)?\/?$/.exec(url.pathname);
      return path ? { src: `https://www.instagram.com/${path[1]}/${path[2]}/embed`, title: "Instagram video player", allow: "autoplay; fullscreen", vertical: path[1] === "reel" } : null;
    }
    case "facebook.com":
    case "www.facebook.com":
    case "m.facebook.com":
    case "web.facebook.com": {
      const inner = url.pathname === "/plugins/video.php"
        ? pastedPlayerUrl(url.searchParams.get("href") ?? "") : url;
      const video = inner ? facebookVideoUrl(inner) : null;
      return video ? { src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(video)}`, title: "Facebook video player", allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", vertical: video.startsWith("https://www.facebook.com/reel/") } : null;
    }
    case "player.pbs.org": {
      let src = extractPartnerPlayerSrc(value);
      if (src && !allowAutoplay) {
        const url = new URL(src);
        url.searchParams.delete("autoplay");
        src = url.href;
      }
      return src ? { src, title: "PBS video player", allow: pbsPlayerPermissions("on-demand") } : null;
    }
    default:
      return null;
  }
}

export function xVideoLink(value: string): string | null {
  const url = pastedPlayerUrl(value);
  if (!url || !["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(url.hostname)) return null;
  const path = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/video\/\d+)?\/?$/.exec(url.pathname);
  return path ? `https://x.com/${path[1]}/status/${path[2]}` : null;
}

// A start time from YouTube's `t` or `start` parameter: 258, 258s, or 4m18s.
function youtubeStartSeconds(value: string | null): number {
  const match = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/.exec(value ?? "");
  if (!match) return 0;
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return total <= 86_400 ? total : 0;
}
