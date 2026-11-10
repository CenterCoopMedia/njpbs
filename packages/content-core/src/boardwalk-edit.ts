import type { PubliclyRoutedRecordKind } from "./public-record-kinds";

export type BoardwalkEditType = "home" | "page" | PubliclyRoutedRecordKind;
export interface BoardwalkEditTarget { type: BoardwalkEditType; id: string }

// A hint carries no identity or authority. Sibling dev hosts need the parent
// domain, so separate cookie names isolate dev from production.
export function boardwalkHintCookie(hostname: string, admitted: boolean): string | null {
  const development = hostname === "dev-admin.example.org";
  const shared = hostname.endsWith(".njpbs.org") || development;
  const subdomain = shared ? hostname.slice(0, -".njpbs.org".length) : null;
  const name = development ? "bw_staff_dev" : subdomain === "admin" ? "bw_staff" :
    (hostname === "localhost" || hostname === "127.0.0.1") ? "bw_staff_local" : null;
  if (!name) return null;
  return `${name}=${admitted ? "1" : ""}; Path=/; Max-Age=${admitted ? 86400 : 0}; SameSite=Lax${shared ? "; Domain=njpbs.org; Secure" : ""}`;
}
