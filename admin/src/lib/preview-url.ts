import { privatePreviewOrigin } from "./dev-origins";

export function previewPageUrl(origin: string, pagePath: string, queueId: string): string {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.port || base.search || base.hash) {
    throw new Error("Invalid preview origin");
  }
  const privatePreview = base.origin === privatePreviewOrigin;
  if (privatePreview) {
    if (!/^[A-Za-z0-9]{20}$/.test(queueId) || ![`/p/${queueId}/`, `/s/${queueId}/`].includes(base.pathname)) {
      throw new Error("Preview URL does not match this queue");
    }
  } else if (import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT === "development" ||
      !base.hostname.endsWith(".njpbs-preview.pages.dev") || base.pathname !== "/") {
    throw new Error("Invalid preview host");
  }
  const url = new URL(pagePath.replace(/^\/+/, ""), base);
  if (url.origin !== base.origin || (privatePreview && !url.pathname.startsWith(base.pathname))) {
    throw new Error("Invalid preview page path");
  }
  return url.toString();
}
