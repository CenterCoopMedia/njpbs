/** Extract PBS/COVE iframe code or a player link, then rebuild only approved fields. */
export function extractPartnerPlayerSrc(playerCode: string | null | undefined): string | null {
  if (!playerCode) return null;
  const source = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(playerCode)?.[1] ?? playerCode;
  let url: URL;
  try {
    const value = source.trim().replaceAll("&amp;", "&");
    url = new URL(value.startsWith("//") ? `https:${value}` : value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "player.pbs.org"
    || url.username || url.password || url.port) return null;
  const match = /^\/(?:partnerplayer|portalplayer|viralplayer)\/([A-Za-z0-9_+-]{1,128}={0,2})\/?$/.exec(url.pathname);
  if (!match) return null;
  const parameters = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    const time = ["start", "end"].includes(name) && /^\d{1,6}$/.test(value);
    const flag = ["topbar", "endscreen", "autoplay", "muted"].includes(name) && /^(?:true|false)$/.test(value);
    if ((time || flag) && !parameters.has(name)) parameters.set(name, value);
  }
  const query = parameters.toString();
  return `https://player.pbs.org/partnerplayer/${match[1]}/${query ? `?${query}` : ""}`;
}
