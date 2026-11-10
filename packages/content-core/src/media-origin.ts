// The deployment environment is a build input, never a CMS field or a URL
// override. Dev retains production URLs from seeded records. Its only additional
// origin matches CMS_MEDIA_ORIGIN in cms-dev-deploy.yml.
declare const __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__: string | undefined;
const deploymentEnvironment = typeof __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ !== "undefined"
  ? __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__
  : typeof process !== "undefined" ? process.env.CMS_DEPLOYMENT_ENVIRONMENT : undefined;
export const CMS_MEDIA_ORIGIN = deploymentEnvironment === "development"
  ? "https://dev-media.example.org"
  : "https://media.njpbs.org";

function cleanHttpsUrl(url: URL): boolean {
  return url.protocol === "https:" && url.port === ""
    && url.username === "" && url.password === ""
    && url.search === "" && url.hash === "";
}

/** Public CMS media, including PDF notices and published video copies. */
export function isCmsMediaUrl(url: URL): boolean {
  return cleanHttpsUrl(url)
    && (url.origin === "https://media.njpbs.org" || url.origin === CMS_MEDIA_ORIGIN)
    && url.pathname.startsWith("/cms-media/") && url.pathname.length > 11;
}

/** Images may also use the existing public-site brand assets. */
export function isCmsImageUrl(url: URL): boolean {
  return isCmsMediaUrl(url) || cleanHttpsUrl(url)
    && url.origin === "https://njpbs.org"
    && url.pathname.startsWith("/brand/") && url.pathname.length > 7;
}
