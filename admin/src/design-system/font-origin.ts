/**
 * PBS Sans ships with Boardwalk at /brand/fonts/. Documents that resolve URLs
 * against another base (the Home preview frame, the preview progress tab) need
 * Boardwalk's own origin in each font URL.
 */
export function withAdminFontOrigin(css: string): string {
  return css.replaceAll('url("/brand/fonts/', `url("${window.location.origin}/brand/fonts/`);
}
