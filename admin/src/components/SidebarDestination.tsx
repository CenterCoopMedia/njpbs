import { isSafeNavigationUrl } from "../lib/custom-navigation";
import { Link, NavLink } from "react-router";
import { Icon } from "./ui/Icon";
import type { NavDestinationDef } from "../lib/nav-destinations";
import {
  routePrefetchHandlers,
  type RoutePrefetcher,
} from "../lib/route-prefetch";
import { stripTrailingSlash } from "../lib/routes";

interface SidebarDestinationProps {
  destination: NavDestinationDef;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  pathname: string;
  prefetch: RoutePrefetcher;
}

function exactPathMatch(pathname: string, destination: string): boolean {
  return stripTrailingSlash(pathname) === stripTrailingSlash(destination);
}

/**
 * One capability-admitted rail destination. Content sections can carry contextual
 * shortcuts that open only from the disclosure button. Pointer and focus movement
 * keep the rail stable. Other destinations keep the existing one-link row.
 */
export function SidebarDestination({
  destination,
  expanded,
  onExpandedChange,
  pathname,
  prefetch,
}: SidebarDestinationProps) {
  const sectionActive = destination.sectionOnly
    ? (destination.subitems?.some(subitem => !subitem.external && exactPathMatch(pathname, subitem.to)) ?? false)
    : destination.activeFor
    ? destination.activeFor(pathname)
    : exactPathMatch(pathname, destination.to);
  const hasSubitems = Boolean(destination.subitems?.length);
  const hasActiveSubitem =
    destination.subitems?.some((subitem) =>
      exactPathMatch(pathname, subitem.to),
    ) ?? false;
  const open = hasSubitems && expanded;
  const sublistId = `nav-${destination.id}-actions`;
  const intent = routePrefetchHandlers(prefetch, destination.to);
  const className = (active: boolean) =>
    active ? "nav-item button active" : "nav-item button";
  const body = (
    <>
      <Icon name={destination.icon} />
      <span>{destination.label}</span>
    </>
  );

  if (destination.customItem && !isSafeNavigationUrl(destination.to)) return null;
  const mainLink = destination.sectionOnly ? (
    <button type="button" className="nav-item button" aria-expanded={open} aria-controls={sublistId} onClick={() => onExpandedChange(!open)}>{body}</button>
  ) : destination.activeFor ? (
    <Link
      to={destination.to}
      title={destination.label}
      aria-current={sectionActive && !hasActiveSubitem ? "page" : undefined}
      className={className(sectionActive)}
      {...intent}
    >
      {body}
    </Link>
  ) : (
    <NavLink
      to={destination.to}
      end={destination.id === "home"}
      title={destination.label}
      className={({ isActive }) => className(isActive)}
      {...intent}
    >
      {body}
    </NavLink>
  );

  if (!hasSubitems) return mainLink;

  return (
    <div
      className="nav-destination-group"
      data-active={sectionActive ? "true" : "false"}
      data-expanded={open ? "true" : "false"}
    >
      <div className="nav-destination-main">
        {mainLink}
        <button
          type="button"
          className="nav-destination-toggle"
          aria-controls={sublistId}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} ${destination.label} actions`}
          title={`${open ? "Hide" : "Show"} ${destination.label} actions`}
          onClick={() => onExpandedChange(!open)}
        >
          <Icon name={open ? "chevron-up" : "chevron-down"} />
        </button>
      </div>
      <ul className="nav-sublist" id={sublistId} hidden={!open}>
        {destination.subitems?.map((subitem) => {
          if (destination.customItem && !isSafeNavigationUrl(subitem.to)) return null;
          const active = exactPathMatch(pathname, subitem.to);
          return (
            <li key={subitem.id}>
              {subitem.external ? <a className="nav-subitem" href={subitem.to} target="_blank" rel="noopener noreferrer" aria-label={`Open ${subitem.label} in a new tab`}>{subitem.label}<Icon name="external-link" /></a> : <Link
                className="nav-subitem"
                to={subitem.to}
                aria-current={active ? "page" : undefined}
                {...routePrefetchHandlers(prefetch, subitem.to)}
              >
                {subitem.label}
              </Link>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

