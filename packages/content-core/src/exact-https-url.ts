/** An exact HTTPS URL with no credentials or raw whitespace. */
export function isExactHttpsUrl(value: unknown, maxLength = Number.POSITIVE_INFINITY): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength ||
    value.trim() !== value || /[\u0000-\u0020\u007F]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
