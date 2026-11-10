const PLACEHOLDER_ORIGIN = "https://uploads.example.org";

/** An enabled upload page requires a configured, canonical HTTPS origin. */
export function resolveShareUploadOrigin(value: string | undefined, required = false): string {
  if (!value) {
    if (required) throw new Error("PUBLIC_SHARE_UPLOAD_ORIGIN is required when the share page is enabled");
    return PLACEHOLDER_ORIGIN;
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("PUBLIC_SHARE_UPLOAD_ORIGIN must be an exact HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.origin !== value ||
    (required && value === PLACEHOLDER_ORIGIN)) {
    throw new Error("PUBLIC_SHARE_UPLOAD_ORIGIN must be a configured exact HTTPS origin");
  }
  return value;
}

type BuildMeta = ImportMeta & {
  env: { SSR: boolean; PUBLIC_SHARE_UPLOAD_ORIGIN?: string };
};
// Direct Vite properties fold to client constants, leaving validation in the
// build/server path rather than adding it to each reader's JavaScript.
export const SHARE_UPLOAD_ORIGIN = (import.meta as Partial<BuildMeta>).env != null &&
  (import.meta as BuildMeta).env.SSR === false
  ? ((import.meta as BuildMeta).env.PUBLIC_SHARE_UPLOAD_ORIGIN ?? PLACEHOLDER_ORIGIN)
  : resolveShareUploadOrigin((import.meta as Partial<BuildMeta>).env?.PUBLIC_SHARE_UPLOAD_ORIGIN ??
    (typeof process === "undefined" ? undefined : process.env.PUBLIC_SHARE_UPLOAD_ORIGIN));
