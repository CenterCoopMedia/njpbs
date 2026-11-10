const SITE_ORIGIN = "https://njpbs.org";
const PLAYER_HOSTS = new Set([
  "player.pbs.org", "youtube.com", "www.youtube.com", "m.youtube.com",
  "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be",
  "vimeo.com", "player.vimeo.com", "tiktok.com", "www.tiktok.com",
  "instagram.com", "www.instagram.com", "facebook.com", "www.facebook.com",
  "m.facebook.com", "web.facebook.com", "connect.facebook.net",
  "platform.twitter.com", "platform.x.com",
  // AP results frames use the same site-analytics exclusion as player pages.
  "interactives.apelections.org",
]);

/** Video pages must omit analytics, including players nested inside content rows. */
export function hasVideoPlayer(html: string): boolean {
  // Custom HTML lives in srcdoc. Broaden only that document's source rule so
  // non-video template integrations remain eligible for analytics.
  const documents = [{ html, customHtml: false }];
  for (const match of html.matchAll(/<iframe\b[^>]*(?:\s|["'/])srcdoc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    documents.push({ html: match[1] ?? match[2], customHtml: true });
  }
  for (const document of documents) {
    const decoded = document.html.replaceAll("&lt;", "<").replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"').replaceAll("&#39;", "'");
    // Deferred players are video-bearing before activation too. Otherwise
    // a visitor could load analytics, then reveal the player on that same page.
    if (/<section\b[^>]*\sdata-post-lead-player(?:\s|=|>)/i.test(decoded)) return true;
    if (/<section\b[^>]*\sdata-home-newscast-player(?:\s|=|>)/i.test(decoded)) return true;
    if (/<iframe\b[^>]*\sdata-deferred-youtube-src\s*=/i.test(decoded)) return true;
    if (/<video\b/i.test(decoded)) return true;
    for (const match of decoded.matchAll(/<(?:iframe|script)\b[^>]*(?:\s|["'/])src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      try {
        const url = new URL(match[1] ?? match[2] ?? match[3], SITE_ORIGIN);
        if (PLAYER_HOSTS.has(url.hostname) ||
          (document.customHtml && url.hostname && url.origin !== SITE_ORIGIN)) return true;
      } catch {
        // Invalid source URLs cannot load external players.
      }
    }
  }
  return false;
}
