export const publicSiteOrigin = import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT === "development"
  ? "https://dev-public.example.org"
  : "https://njpbs.org";

export const privatePreviewOrigin = import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT === "development"
  ? "https://dev-preview.example.org"
  : "https://preview.njpbs.org";

export function publicSiteUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ""), `${publicSiteOrigin}/`).toString();
}
