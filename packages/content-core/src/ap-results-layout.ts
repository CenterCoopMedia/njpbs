/** AP layouts need the page origin as referrer, so render them outside Custom HTML. */
export function apResultsLayoutSrc(value: string): string | null {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "interactives.apelections.org"
    || url.username || url.password || url.port || url.search || url.hash) return null;
  return /^\/election-results\/customers\/layouts\/organization-layouts\/published\/\d{1,12}\/\d{1,12}\.html$/.test(url.pathname)
    ? url.href : null;
}
