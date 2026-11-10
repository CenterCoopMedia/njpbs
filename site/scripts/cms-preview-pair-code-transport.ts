import type { PreviewPairCodeTransportFactory } from "./cms-preview-pair-context";

/** Admitted launcher's server transport. Development's Access values can go
 * only to its fixed CMS private endpoint, alongside the existing edge secret. */
export function bindPreviewPairCodeTransport({ createTransport, deploymentEnvironment, publicationAccess, request = fetch }: {
  createTransport: PreviewPairCodeTransportFactory; deploymentEnvironment: string;
  publicationAccess: { clientId: string; clientSecret: string }; request?: typeof fetch;
}): PreviewPairCodeTransportFactory {
  if (deploymentEnvironment === "production") return createTransport;
  if (deploymentEnvironment !== "development" || !publicationAccess.clientId || !publicationAccess.clientSecret ||
      /[\r\n]/.test(publicationAccess.clientId + publicationAccess.clientSecret)) throw new Error("Development preview Access credentials are required");
  return options => createTransport({ ...options, request: async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://dev-api.example.org" || url.pathname !== "/_internal/record-code" || url.search || url.hash ||
        url.username || url.password || init?.redirect !== "error") throw new Error("Development preview source target differs");
    const headers = new Headers(init.headers);
    headers.set("CF-Access-Client-Id", publicationAccess.clientId); headers.set("CF-Access-Client-Secret", publicationAccess.clientSecret);
    return request(input, { ...init, headers });
  } });
}
