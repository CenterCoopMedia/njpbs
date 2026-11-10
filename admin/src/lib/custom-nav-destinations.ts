import type { Principal } from "../../../packages/content-core/src/rbac";
import { can } from "../../../packages/content-core/src/rbac";
import { isCustomPageId, publicPage } from "../../../packages/content-core/src/public-pages";
import { canBrowseContentPages, canUseContentStudio } from "./access";
import { canOpenAdminPath } from "./route-memory";
import { editRecordPath } from "./routes";
import { isSafeNavigationUrl, normalizeNavigationUrl, parseCustomNavigation, type CustomNavItem, type CustomNavLink } from "./custom-navigation";
import type { NavDestinationDef, NavSubitemDef } from "./nav-destinations";
import type { NavigationPreferences } from "./navigation-preferences";

export function customLinkPath(link: CustomNavLink): string | null {
  const destination = link.destination;
  if (destination.kind === "url") {
    const url = normalizeNavigationUrl(destination.url, typeof window === "undefined" ? "https://cms.example.test" : window.location.origin);
    return isSafeNavigationUrl(url) ? url : null;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(destination.id)) return null;
  return destination.kind === "post" ? editRecordPath("post", destination.id) : `/content/pages/${encodeURIComponent(destination.id)}/edit`;
}

function permittedLink(link: CustomNavLink, principal: Principal): NavSubitemDef | null {
  const to = customLinkPath(link);
  if (!to) return null;
  const external = to.startsWith("https://");
  if (!external) {
    const path = new URL(to, "https://cms.example.test").pathname;
    if (link.destination.kind === "page") {
      if (!canBrowseContentPages(principal)) return null;
      // Custom page sections are server-owned; the addressed editor checks the resource.
      const page = isCustomPageId(link.destination.id) ? undefined : publicPage(link.destination.id);
      if (page && !can(principal, "content.edit.any", { section: page.area }) && !can(principal, "content.edit.own", { section: page.area })) return null;
    } else if (link.destination.kind === "post") {
      if (!canUseContentStudio(principal)) return null;
    } else if (!canOpenAdminPath(principal, path)) return null;
  }
  return { id: link.id, label: link.label, to, external };
}

/** No data reads: content absence is handled by the existing addressed editor's not-found state. */
export function customNavDestinations(stored: NavigationPreferences | null, principal: Principal): NavDestinationDef[] {
  const custom = parseCustomNavigation(stored?.custom ?? []) ?? [];
  return custom.flatMap((item): NavDestinationDef[] => {
    const base = { id: item.id, label: item.label, icon: item.icon ?? (item.kind === "section" ? "folder" : "link"), visible: () => true, customItem: item };
    if (item.kind === "link") {
      const link = permittedLink(item, principal);
      return link ? [{ ...base, ...link }] : [];
    }
    const subitems = item.links.filter(link => !stored?.hidden.includes(link.id)).map(link => permittedLink(link, principal)).filter((link): link is NavSubitemDef => link !== null);
    return subitems.length ? [{ ...base, to: subitems[0].to, sectionOnly: true, subitems }] : [];
  });
}

/** Settings keeps unauthorized custom entries editable while the rail still filters them. */
export function customSettingsDestinations(items: readonly CustomNavItem[]): NavDestinationDef[] {
  return items.map(item => ({ id: item.id, label: item.label, icon: item.icon ?? (item.kind === "section" ? "folder" : "link"), to: item.kind === "link" ? customLinkPath(item) ?? "/" : "/", visible: () => true, customItem: item }));
}
