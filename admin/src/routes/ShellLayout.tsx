import { liveProductionEnabled } from "../lib/live-production-access";
import { BoardwalkUsageAnalytics } from "../components/BoardwalkUsageAnalytics";
import { useToolbarNavigation } from "../components/ui/useToolbarNavigation";
import { hasCapability } from "../../../packages/content-core/src/rbac";
import { customNavDestinations } from "../lib/custom-nav-destinations";
import { adoptedCustomItems } from "../lib/navigation-shares";
import { useNavigationShares } from "../lib/navigation-shares-store";
import { isSafeNavigationUrl } from "../lib/custom-navigation";
import { InfoTooltip } from "../components/ui/InfoTooltip";
import {
  type MouseEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  useLocation,
  useMatches,
  useNavigation,
} from "react-router";
import { WorkspaceFinder } from "../components/WorkspaceFinder";
import { useFloatingPosition } from "../components/ui/floating";
import { useDismissibleOverlay } from "../hooks/useDismissibleOverlay";
import { BrandLockup } from "../components/BrandLockup";
import { ReportProblemDialog } from "../components/ReportProblemDialog";
import { WhatsNewDialog } from "../components/WhatsNewDialog";
import { AdminUpdateNotice } from "../components/AdminUpdateNotice";
import { SidebarDestination } from "../components/SidebarDestination";
import { Icon, type IconName } from "../components/ui/Icon";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { AccountMenu } from "../components/ui/AccountMenu";
import { Button, buttonClassName, InlineMessage } from "../components/ui/Primitives";
import { SuccessNoticeProvider } from "../components/ui/SuccessNoticeRegion";
import { ActionControl } from "../components/ui/ActionControl";
import { ControlPresentationProvider } from "../context/ControlPresentationContext";
import { WorkspaceActionsProvider } from "../components/WorkspaceActions";
import { EditorWorkspaceViewProvider, useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { EDITOR_BENTO_PREFERENCES_EVENT } from "../lib/layout-preferences";
import { EditorWorkspacePane } from "../components/EditorWorkspacePanes";
import { editorBackDestination, readListOrigin } from "../lib/editor-back";
import {
  eligibleNavDestinations,
  type NavDestinationDef,
} from "../lib/nav-destinations";
import {
  readNavigationPreferences,
  resolveNavigation,
  visibleNavigation,
} from "../lib/navigation-preferences";
import {
  accountProfilePath,
  accountSettingsPath,
  parseContentPath,
  parseMediaWorkspacePath,
  ROUTE_PATHS,
  stripTrailingSlash,
} from "../lib/routes";
import {
  createRoutePrefetcher,
  routePrefetchHandlers,
  type RoutePrefetcher,
} from "../lib/route-prefetch";
import {
  LAYOUT_DENSITIES,
  readLayoutDensity,
  readStoredLayoutDisclosure,
  writeLayoutDensity,
  writeLayoutDisclosure,
  type LayoutDensity,
} from "../lib/layout-preferences";
import { cmsGetAuthorProfile } from "../lib/functions";
import {
  OWN_AVATAR_MAX_AGE_MS,
  avatarPhotoFrom,
  ownAvatarPhotoEpoch,
  readOwnAvatarPhoto,
  writeOwnAvatarPhoto,
  type AvatarPhoto,
  type AvatarPhotoSource,
} from "../lib/own-author-photo-cache";
import { OwnAuthorPhotoProvider } from "./OwnAuthorPhotoContext";
import type { RouteHandle } from "./buildRoutes";
import { forgetAdminDestination, useDestinationMemory } from "./destination-memory";
import { ExitGuardProvider, useExitGuard } from "./ExitGuard";
import { useRouteAnnouncer, useRouteFocus } from "./route-focus";
import { useShell } from "./ShellContext";
import { canSubmitProblemReport, canViewReports, isGuideOnly } from "../lib/access";
import { PublicContentStatusProvider } from "../context/PublicContentStatusContext";

// A visually hidden but screen-reader-audible live region. Inline so the announcer does not
// depend on a utility class that may not exist in the admin stylesheet.
const SR_ONLY: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

// How long a route load runs before the shell shows it is working. Under this the next
// workspace paints before anyone could read a notice, so showing one only adds a flash; over it
// the person needs to see that their click landed and something is on its way.
export const ROUTE_PROGRESS_DELAY_MS = 200;

// What an in-app route change is doing once it has outlasted that delay: the destination's
// code is still arriving (a prefetch normally makes this instant), then the router swaps the
// outlet. There is no transition between surfaces; the new one replaces the old in one frame.
const ROUTE_CHANGE_STAGES = [
  "Downloading the code for this workspace",
  "Handing the outlet to the new surface",
] as const;

// True once `active` has held for the delay, false the moment it clears. The pending timer is
// dropped when the load finishes early, so a fast navigation never shows the indicator at all.
function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

function focusMainContent(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  document.getElementById("main-content")?.focus();
}

const DENSITY_LABELS: Record<LayoutDensity, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
  loose: "Loose",
};

// One rail row. Destinations whose current-section state is wider than a single URL — a page
// editor is still "Pages" — carry an `activeFor` matcher and render as a plain Link with an
// explicit aria-current, because NavLink would emit `aria-current` only for its own exact match
// and leave sighted and screen-reader users with different answers about the current section.
function NavDestinationLink({
  destination,
  pathname,
  prefetch,
}: {
  destination: NavDestinationDef;
  pathname: string;
  prefetch: RoutePrefetcher;
}) {
  // Start this destination's JavaScript once the person shows they are likely to open it —
  // a pointer that settles on the row, focus that stops here, or a press already under way
  // (#1065). Code only: nothing here requests content, media, or profile data, and nothing
  // here decides what the rail may contain. The handlers are passive, so the link activates
  // exactly as it did before whether or not its module was already started.
  // Keep the `button` class alongside `nav-item`: the sidebar CSS targets `.nav-item.button` for
  // the full-width layout, padding, hover, and focus treatment the old Button component supplied.
  const className = (active: boolean) =>
    active ? "nav-item button active" : "nav-item button";
  const body = (
    <>
      <Icon name={destination.icon} />
      <span>{destination.label}</span>
    </>
  );
  if (destination.customItem && !isSafeNavigationUrl(destination.to)) return null;
  if (destination.external) {
    return (
      <a
        aria-label={`Open ${destination.label} in a new tab`}
        className="nav-item button"
        href={destination.to}
        rel="noopener noreferrer"
        target="_blank"
        title={`Open ${destination.label} in a new tab`}
      >
        {body}
        {destination.customItem && destination.icon !== "external-link" ? <Icon name="external-link" className="nav-external-indicator" /> : null}
      </a>
    );
  }
  const intent = routePrefetchHandlers(prefetch, destination.to);

  if (destination.activeFor) {
    const active = destination.activeFor(pathname);
    return (
      <Link
        to={destination.to}
        title={destination.label}
        aria-current={active ? "page" : undefined}
        className={className(active)}
        {...intent}
      >
        {body}
      </Link>
    );
  }

  return (
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
}

function isRouteHandle(handle: unknown): handle is RouteHandle {
  return (
    typeof handle === "object" &&
    handle !== null &&
    typeof (handle as { title?: unknown }).title === "string" &&
    typeof (handle as { description?: unknown }).description === "string"
  );
}

// The deepest matched route that carries a title/description handle. The shell layout route
// itself has no handle, so this is always the page-level route.
function activeHandle(matches: ReturnType<typeof useMatches>): RouteHandle {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const handle = matches[index]?.handle;
    if (isRouteHandle(handle)) return handle;
  }
  return { title: "Boardwalk", description: "" };
}

const CONTEXT_HEADER_PATHS = new Set<string>([
  ROUTE_PATHS.root,
  ROUTE_PATHS.activity,
  ROUTE_PATHS.mediaLibrary,
  ROUTE_PATHS.schedule,
  ROUTE_PATHS.publishQueue,
  ROUTE_PATHS.adminSettings,
  ROUTE_PATHS.adminCosts,
  ROUTE_PATHS.accountSettings,
  ROUTE_PATHS.authorProfiles,
  ROUTE_PATHS.staffAccess,
]);

function usesContextHeader(pathname: string): boolean {
  const path = stripTrailingSlash(pathname);
  return (
    CONTEXT_HEADER_PATHS.has(path) ||
    path.startsWith(`${ROUTE_PATHS.mediaLibrary}/`) ||
    path === ROUTE_PATHS.reports ||
    path.startsWith(`${ROUTE_PATHS.reports}/`)
  );
}

// The signed-in shell: the persistent frame around every route. It renders the sidebar, the
// header heading the focus manager targets, and the outlet the active route fills. Because it is
// the layout for the whole tree, it stays mounted across navigation, so its focus manager can
// track the previously focused control per history entry (#587) and the announcer's live region
// is never torn down and recreated mid-navigation.
export function ShellLayout() {
  const route = parseContentPath(useLocation().pathname);
  const kind = route.kind === "edit-page" ? "page"
    : (route.kind === "edit-record" || route.kind === "create-record") && route.type === "post" ? "post" : null;
  return <EditorWorkspaceViewProvider kind={kind}><BoardwalkUsageAnalytics /><ShellLayoutContents /></EditorWorkspaceViewProvider>;
}

function ShellLayoutContents() {
  const editorView = useEditorWorkspaceView()!;
  useToolbarNavigation(editorView.editingTarget);
  useEffect(() => {
    void import("../cms-workspace.css");
  }, []);
  const { principal, user, userDoc, signOut, getIdToken, navigationShares: injectedShares } = useShell();
  const { shares } = useNavigationShares(injectedShares, Boolean(getIdToken), readNavigationPreferences(userDoc)?.shared);
  const location = useLocation();
  const noticeVisit = useRef({ pathname: location.pathname, generation: 0 });
  // Settings sections share mounted save owners; rotate their notice scope only on departure.
  if (noticeVisit.current.pathname !== location.pathname) {
    noticeVisit.current = { pathname: location.pathname, generation: noticeVisit.current.generation + 1 };
  }
  const noticeScope = location.pathname === ROUTE_PATHS.adminSettings ? `settings-visit-${noticeVisit.current.generation}` : location.key;
  const matches = useMatches();
  const navigation = useNavigation();
  const handle = activeHandle(matches);
  const contentRoute = parseContentPath(location.pathname);
  const contentPath = contentRoute.kind !== "not-found";
  const templatePath = location.pathname === ROUTE_PATHS.postTemplates || location.pathname.startsWith(`${ROUTE_PATHS.postTemplates}/`);
  const browsingContent = contentRoute.kind === "page-list" || contentRoute.kind === "record-list" || contentRoute.kind === "library";
  const browsingMedia = location.pathname === ROUTE_PATHS.mediaLibrary || location.pathname.startsWith(`${ROUTE_PATHS.mediaLibrary}/`) || location.pathname === ROUTE_PATHS.voiceovers;
  const browsingQueue = location.pathname === ROUTE_PATHS.publishQueue;
  const liveProduction = liveProductionEnabled() && stripTrailingSlash(location.pathname) === ROUTE_PATHS.liveProduction;
  const browsingCosts = stripTrailingSlash(location.pathname) === ROUTE_PATHS.adminCosts;
  const browsingWorkspace = browsingContent || browsingMedia || browsingQueue || browsingCosts;
  const sharedChrome = Boolean(editorView.kind) || browsingWorkspace || liveProduction;
  const editorHeader = contentPath && !browsingContent;
  const headerMenu = sharedChrome || editorHeader;
  const mediaPath = parseMediaWorkspacePath(location.pathname);
  const mediaTitle = mediaPath.kind === "images" ? "Images" : mediaPath.kind === "videos" ? "Videos" : mediaPath.kind === "favorites" ? "Favorites" : mediaPath.kind === "collections" ? "Collections" : mediaPath.kind === "voiceovers" ? "Audio" : mediaPath.kind === "submissions" ? "Public submissions" : "Media library";
  const routeLoading = navigation.state === "loading";
  const showRouteProgress = useDelayedFlag(routeLoading, ROUTE_PROGRESS_DELAY_MS);
  // The menu belongs to the page it opened on, so a destination never inherits an open drawer.
  const [menuOpenPath, setMenuOpenPath] = useState<string | null>(null);
  const menuOpen = menuOpenPath === location.pathname;
  const setMenuOpen = useCallback((next: SetStateAction<boolean>) => {
    setMenuOpenPath((current) => {
      const open = typeof next === "function" ? next(current === location.pathname) : next;
      return open ? location.pathname : null;
    });
  }, [location.pathname]);
  const [sidebarChoice, setSidebarChoice] = useState(() => readStoredLayoutDisclosure("navigation"));
  // Until staff choose, editors keep the canvas room and other destinations show their labels.
  // The shell stays mounted across routes; an unsaved default must follow the active workspace.
  const sidebarCollapsed = sidebarChoice ?? Boolean(editorView.kind);
  const [density, setDensity] = useState(() => readLayoutDensity());
  // Presentation changes leave the editor mounted. The document also owns portal density.
  useEffect(() => {
    document.documentElement.dataset.density = density;
    return () => { delete document.documentElement.dataset.density; };
  }, [density]);
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [expandedNavId, setExpandedNavId] = useState<string | null>(null);
  const viewOptionsRef = useRef<HTMLDivElement>(null);
  // One prefetcher for the whole rail, built once per shell. A pointer and a keyboard can only
  // be in one place, so a single pending intent is the whole queue: crossing the rail starts the
  // destination it settled on, never the ten it passed.
  const prefetch = useMemo(() => createRoutePrefetcher(), []);
  const [chromeElement, setChromeElement] = useState<HTMLDivElement | null>(null);
  const registerChrome = useCallback((element: HTMLDivElement | null) => {
    setChromeElement(element);
    editorView.setChromeElement(element);
  }, [editorView.setChromeElement]);
  useLayoutEffect(() => {
    if (!sharedChrome || !chromeElement?.parentElement) return;
    const workspace = chromeElement.parentElement;
    const previous = workspace.style.getPropertyValue("--workspace-header-height");
    const measure = () => workspace.style.setProperty("--workspace-header-height", `${chromeElement.getBoundingClientRect().height}px`);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(chromeElement);
    return () => {
      observer?.disconnect();
      if (previous) workspace.style.setProperty("--workspace-header-height", previous);
      else workspace.style.removeProperty("--workspace-header-height");
    };
  }, [chromeElement, sharedChrome]);
  const contextHeader = usesContextHeader(location.pathname);
  const isNarrowScreen = useCallback(
    () => window.matchMedia?.(sharedChrome ? "(max-width: 619px)" : "(max-width: 720px)").matches ?? false,
    [sharedChrome],
  );
  const [narrowScreen, setNarrowScreen] = useState(isNarrowScreen);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const morePanelRef = useRef<HTMLDivElement>(null);
  const morePosition = useFloatingPosition(moreActionsOpen && headerMenu,
    () => moreActionsTrigger.current?.getBoundingClientRect() ?? null,
    morePanelRef, "bottom-end", () => moreActionsTrigger.current, true);
  const moreActionsRef = useRef<HTMLDivElement>(null);
  const moreActionsTrigger = useRef<HTMLButtonElement>(null);
  const editorFinderTrigger = useRef<HTMLButtonElement>(null);
  const browseFinderTrigger = useRef<HTMLButtonElement>(null);
  const browseFinderFallback = useMemo(() => ({
    get current() {
      const trigger = browseFinderTrigger.current;
      return trigger?.checkVisibility() ? trigger : moreActionsTrigger.current;
    },
  }), []);
  const mobileControls = contentPath && narrowScreen;
  // A phone workspace has no room for the rail, so a menu control in the document bar opens the
  // whole rail as a drawer: focus enters it, the workspace behind it is inert, and Escape, the
  // close control or the scrim return focus to the menu control. Choosing a destination closes it.
  const [phoneNavigationMenu, setPhoneNavigationMenu] = useState(
    () => window.matchMedia?.("(max-width: 619px)").matches ?? false,
  );
  const moreMode = browsingCosts && narrowScreen ? "costs-phone" : browsingWorkspace ? "help" : "document";
  const moreControl = {
    "costs-phone": { icon: "ellipsis", label: "More", name: "More cost actions" },
    help: { icon: "help-circle", label: "Help", name: "Help and reporting" },
    document: { icon: "ellipsis", label: "More", name: "More document actions" },
  } as const;
  const morePresentation = moreControl[moreMode];
  const railCollapsed = sidebarCollapsed && !phoneNavigationMenu;
  const sidebarRef = useRef<HTMLElement>(null);
  const editorMenuTrigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    const nav = sidebar?.querySelector<HTMLElement>(".primary-nav");
    const footer = sidebar?.querySelector<HTMLElement>(".sidebar-footer");
    if (!railCollapsed || phoneNavigationMenu || !sidebar || !nav || !footer) return;
    let frame: number | undefined;
    // Keep the initial viewport at a complete destination boundary. The remaining
    // destinations retain native scrolling, including automatic keyboard reveal.
    const fit = () => {
      const top = nav.getBoundingClientRect().top;
      const gap = parseFloat(getComputedStyle(sidebar).rowGap) || 0;
      const available = footer.getBoundingClientRect().top - top - gap;
      if (available <= 0 || nav.clientHeight === 0) return;
      if (nav.scrollHeight <= available) { nav.style.maxHeight = `${available}px`; return; }
      const ends = [...nav.querySelectorAll<HTMLElement>(".nav-item")]
        .filter(item => item.getClientRects().length && item.getBoundingClientRect().height > 0)
        .map(item => item.getBoundingClientRect().bottom - top + nav.scrollTop)
        .filter(bottom => bottom > 0 && bottom <= available);
      if (ends.length) nav.style.maxHeight = `${Math.max(...ends)}px`;
    };
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = undefined; fit(); });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    for (const element of [sidebar, footer, ...nav.children]) observer?.observe(element);
    fit();
    schedule();
    return () => {
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      nav.style.removeProperty("max-height");
    };
  }, [railCollapsed, phoneNavigationMenu]);
  // The trigger sits in the inert workspace, so focus can return to it only after the drawer's
  // effect has lifted inert; a destination choice leaves focus to the route focus manager.
  const returnFocusToMenu = useRef(false);
  const releaseDrawer = useRef<(() => void) | null>(null);
  const closeEditorMenu = useCallback(() => {
    returnFocusToMenu.current = true;
    setMenuOpen(false);
  }, [setMenuOpen]);
  // The phone-only menu and close controls vanish when the screen widens; focus moves to the rail.
  const restoreRailFocus = useRef(false);
  // The rail's own account and view menus own Escape while they are open.
  const railPopoverOpen = useRef(false);
  railPopoverOpen.current = accountMenuOpen || viewOptionsOpen;
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const shell = sidebar?.parentElement;
    if (!phoneNavigationMenu || !menuOpen || !sidebar || !shell) return;
    // Everything beside the drawer goes inert, the skip link and the notices outside the shell
    // included, so Tab and a screen reader's browse mode stay in the rail.
    const background = [...shell.children, ...document.querySelectorAll(".success-notice-region")]
      .filter((element): element is HTMLElement =>
        element instanceof HTMLElement && element !== sidebar && !element.classList.contains("editor-nav-scrim"));
    background.forEach(element => element.setAttribute("inert", ""));
    const release = () => background.forEach(element => element.removeAttribute("inert"));
    releaseDrawer.current = release;
    sidebar.querySelector<HTMLElement>("#primary-navigation a[href]")?.focus();
    // Read the layers before any handler runs: a menu that closes on this Escape has already
    // re-rendered by the time the event bubbles to the document.
    let escapeOwnedElsewhere = false;
    const noteEscapeOwner = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      escapeOwnedElsewhere = railPopoverOpen.current ||
        Boolean(document.querySelector('[aria-modal="true"], dialog[open]:not([role="presentation"])'));
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || escapeOwnedElsewhere) return;
      closeEditorMenu();
    };
    // A rail link, the account menu's included, closes the drawer at once, so an exit guard opens over a live workspace. Focus
    // waits on the menu control: a canceled or same-page navigation returns there, and a
    // completed one moves on to the new page.
    const closeOnDestination = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest("a[href]")) return;
      release();
      editorMenuTrigger.current?.focus();
      setMenuOpen(false);
    };
    // Keyboard focus wraps inside the drawer; content outside the shell, such as a save notice,
    // stays out of reach behind the scrim.
    const keepTabInDrawer = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = [...sidebar.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", noteEscapeOwner, true);
    document.addEventListener("keydown", closeOnEscape);
    sidebar.addEventListener("click", closeOnDestination);
    sidebar.addEventListener("keydown", keepTabInDrawer);
    return () => {
      release();
      releaseDrawer.current = null;
      sidebar.removeEventListener("keydown", keepTabInDrawer);
      document.removeEventListener("keydown", noteEscapeOwner, true);
      document.removeEventListener("keydown", closeOnEscape);
      sidebar.removeEventListener("click", closeOnDestination);
      if (returnFocusToMenu.current) editorMenuTrigger.current?.focus();
      returnFocusToMenu.current = false;
    };
  }, [phoneNavigationMenu, menuOpen, closeEditorMenu, setMenuOpen]);
  useEffect(() => {
    if (!phoneNavigationMenu) setMenuOpen(false);
  }, [phoneNavigationMenu, setMenuOpen]);
  useLayoutEffect(() => {
    if (!restoreRailFocus.current || phoneNavigationMenu) return;
    restoreRailFocus.current = false;
    sidebarRef.current?.querySelector<HTMLElement>(".sidebar-collapse-toggle")?.focus();
  }, [phoneNavigationMenu]);
  // Any navigation, including the workspace finder, lifts inert before the route focus manager's
  // passive effect moves focus to the new page.
  useLayoutEffect(() => {
    releaseDrawer.current?.();
  }, [location.pathname]);
  const workspaceHeadingRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const heading = workspaceHeadingRef.current;
    const header = heading?.closest<HTMLElement>(".workspace-header");
    if (!heading || !header || editorView.kind || !narrowScreen || !contentPath || browsingContent) return;
    const measure = () => {
      const style = getComputedStyle(header);
      const offset = heading.getBoundingClientRect().height +
        (Number.parseFloat(style.rowGap) || 0) + (Number.parseFloat(style.paddingTop) || 0);
      header.style.setProperty("--workspace-heading-offset", `${offset}px`);
    };
    measure();
    const revealHeading = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && heading.contains(event.target) &&
          event.target.getBoundingClientRect().top < 0) {
        header.parentElement?.scrollIntoView({ block: "start" });
      }
    };
    header.addEventListener("focusin", revealHeading);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(heading);
    observer?.observe(header);
    return () => {
      observer?.disconnect();
      header.removeEventListener("focusin", revealHeading);
      header.style.removeProperty("--workspace-heading-offset");
    };
  }, [narrowScreen, contentPath, browsingContent, editorView.kind]);
  useEffect(() => {
    const media = window.matchMedia?.(sharedChrome ? "(max-width: 619px)" : "(max-width: 720px)");
    const phoneMedia = window.matchMedia?.("(max-width: 619px)");
    if (!media || !phoneMedia) return;
    const update = () => {
      // Navigation has one phone breakpoint; each workspace retains its existing header layout.
      setPhoneNavigationMenu(phoneMedia.matches);
      setNarrowScreen(media.matches);
      setMoreActionsOpen(Boolean(moreActionsRef.current?.querySelector("dialog[open]")));
    };
    update();
    media.addEventListener("change", update);
    phoneMedia.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
      phoneMedia.removeEventListener("change", update);
    };
  }, [sharedChrome]);
  useEffect(() => setMoreActionsOpen(false), [location.pathname]);
  useDismissibleOverlay({
    open: moreActionsOpen,
    root: moreActionsRef,
    trigger: moreActionsTrigger,
    onClose: () => setMoreActionsOpen(false),
  });
  useEffect(() => {
    if (!headerMenu || !moreActionsOpen) return;
    const panel = moreActionsRef.current?.querySelector<HTMLElement>("#workspace-more-panel");
    if (!panel) return;
    // Portaled commands bubble through their physical menu for native Tab departure.
    const closeAfterTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      requestAnimationFrame(() => {
        if (!panel.contains(document.activeElement) && !document.querySelector('dialog[open]:not([role="presentation"])')) setMoreActionsOpen(false);
      });
    };
    panel.addEventListener("keydown", closeAfterTab);
    return () => panel.removeEventListener("keydown", closeAfterTab);
  }, [headerMenu, moreActionsOpen]);
  const guideOnly = isGuideOnly(principal);
  const guidePath =
    location.pathname === ROUTE_PATHS.guide ||
    location.pathname.startsWith(`${ROUTE_PATHS.guide}/`);
  const guideOnlyPathAllowed =
    location.pathname === ROUTE_PATHS.schedule ||
    guidePath ||
    location.pathname.replace(/\/+$/, "") === ROUTE_PATHS.politicsResource ||
    (location.pathname === ROUTE_PATHS.mediaLibrary || location.pathname.startsWith(`${ROUTE_PATHS.mediaLibrary}/`)) ||
    (location.pathname === ROUTE_PATHS.reports || location.pathname.startsWith(`${ROUTE_PATHS.reports}/`)) ||
    location.pathname === ROUTE_PATHS.accountSettings;

  /*
    The rail this account gets (#1045). Capability decides what the catalog can contain; the
    account's own stored arrangement decides the order and which of the eligible destinations it
    has taken out of its rail. Both are re-derived on every render from the live profile document,
    so a role change and a save in another tab reach the rail the same way. Hiding is presentation
    only: nothing below changes authorization, and every route stays mounted and addressable.
  */
  const railDestinations = useMemo(() => {
    const storedNavigation = readNavigationPreferences(userDoc);
    const preferences = storedNavigation ?? { version: 4, order: [], hidden: [], custom: [] };
    // The personal parser rejects more than ten entries. Resolve each adopted item alone.
    const adopted = adoptedCustomItems(shares, storedNavigation, user.uid).flatMap((item) =>
      customNavDestinations({ version: 4, order: [], hidden: preferences.hidden, custom: [item] }, principal),
    );
    return visibleNavigation(
      resolveNavigation(storedNavigation, [
        ...eligibleNavDestinations(principal),
        ...customNavDestinations(storedNavigation, principal),
        ...adopted,
      ]),
    );
  }, [principal, shares, user.uid, userDoc]);

  useEffect(() => {
    setMenuOpen(false);
    setViewOptionsOpen(false);
    setAccountMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!viewOptionsOpen) return;

    function closeViewOptionsWhenOutside(event: PointerEvent) {
      const viewOptions = viewOptionsRef.current;
      if (!viewOptions || !event.composedPath().includes(viewOptions)) {
        setViewOptionsOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeViewOptionsWhenOutside);
    return () => {
      document.removeEventListener("pointerdown", closeViewOptionsWhenOutside);
    };
  }, [viewOptionsOpen]);

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarChoice(next);
    writeLayoutDisclosure("navigation", next);
    if (next) setExpandedNavId(null);
  }

  function selectDensity(next: LayoutDensity, closePanel = true) {
    setDensity(next);
    writeLayoutDensity(next);
    if (closePanel) {
      setViewOptionsOpen(false);
      viewOptionsRef.current
        ?.querySelector<HTMLButtonElement>(".view-options-toggle")
        ?.focus();
    }
  }

  // Reopen the destination this tab was on when the address did not survive the load, and keep
  // that record current afterward (#1031). Declared before the focus manager so a restore is
  // decided in the same commit the shell first paints.
  useDestinationMemory(principal, user.uid);

  const { message, announce } = useRouteAnnouncer();
  useRouteFocus({ label: handle.title, announce });

  const displayName =
    userDoc?.displayName ||
    user.displayName ||
    user.email ||
    userDoc?.email ||
    "Staff member";
  const displayEmail = user.email || userDoc?.email || "No email";

  /*
    The navigation account menu and account settings draw the signed-in person's
    photograph here. The tab remembers only the crop for that uid. A saved profile
    replaces it. A failure stays on initials: a missing photograph is not a shell error.
  */
  const photoIdentity = hasCapability(principal, "content.create") ? user.uid : null;
  const [shownFor, setShownFor] = useState(photoIdentity);
  const [ownPhoto, setOwnPhoto] = useState<AvatarPhoto | null>(() =>
    photoIdentity ? (readOwnAvatarPhoto(photoIdentity) ?? null) : null,
  );
  if (photoIdentity !== shownFor) {
    setShownFor(photoIdentity);
    setOwnPhoto(photoIdentity ? (readOwnAvatarPhoto(photoIdentity) ?? null) : null);
  }
  useEffect(() => {
    let cancelled = false;
    if (!getIdToken || !photoIdentity) return;
    if (readOwnAvatarPhoto(photoIdentity, OWN_AVATAR_MAX_AGE_MS) !== undefined) return;
    const started = ownAvatarPhotoEpoch();
    void (async () => {
      try {
        const token = await getIdToken();
        const response = await cmsGetAuthorProfile(token);
        if (cancelled || ownAvatarPhotoEpoch() !== started) return;
        const photo = avatarPhotoFrom(response.profile.photo ?? null);
        writeOwnAvatarPhoto(photoIdentity, photo);
        setOwnPhoto(photo);
      } catch {
        // Initials remain.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getIdToken, photoIdentity]);
  const publishOwnPhoto = useCallback(
    (photo: AvatarPhotoSource | null) => {
      const stored = avatarPhotoFrom(photo);
      writeOwnAvatarPhoto(user.uid, stored);
      setOwnPhoto(stored);
    },
    [user.uid],
  );
  const [workspaceActionsTarget, setWorkspaceActionsTarget] =
    useState<HTMLElement | null>(null);
  const [workspaceSecondaryTarget, setWorkspaceSecondaryTarget] =
    useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!editorHeader || !workspaceSecondaryTarget) return;
    // Action slots are portals: native bubbling reaches their physical menu owner.
    const closeAfterAction = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const action = event.target.closest("button, a[href]");
      if (!action || action.matches(":disabled, [aria-disabled='true'], [data-lifecycle-help]") || action.closest("dialog") || action.hasAttribute("aria-haspopup")) return;
      setMoreActionsOpen(false);
    };
    workspaceSecondaryTarget.addEventListener("click", closeAfterAction);
    return () => workspaceSecondaryTarget.removeEventListener("click", closeAfterAction);
  }, [editorHeader, workspaceSecondaryTarget]);
  const [workspaceStatusTarget, setWorkspaceStatusTarget] =
    useState<HTMLElement | null>(null);
  const [workspaceTitleTarget, setWorkspaceTitleTarget] =
    useState<HTMLElement | null>(null);
  const [workspaceFeedbackTarget, setWorkspaceFeedbackTarget] =
    useState<HTMLElement | null>(null);
  const [browseToolbarTarget, setBrowseToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [browseToolbarTrailingTarget, setBrowseToolbarTrailingTarget] = useState<HTMLDivElement | null>(null);

  if (guideOnly && !guideOnlyPathAllowed) {
    return (
      <Navigate
        replace
        state={{
          notice:
            "Use the Boardwalk guide, Resources, Broadcast schedule, the media library, Reports, or account settings.",
        }}
        to={ROUTE_PATHS.guide}
      />
    );
  }

  // A principal redirected off a capability-gated route by RequireCapability lands here with a
  // short notice on the history entry. It shows once for that entry; a later link navigation
  // carries no notice, so it clears itself without an explicit dismiss.
  const notice =
    typeof (location.state as { notice?: unknown } | null)?.notice === "string"
      ? (location.state as { notice: string }).notice
      : null;

  const browsingDestination = browsingCosts
    ? { to: ROUTE_PATHS.adminSettings, label: "Settings", shortLabel: "Settings" }
    : { to: ROUTE_PATHS.dashboard, label: "Home", shortLabel: "Home" };

  const breadcrumb = editorView.kind ? editorBackDestination({
    surface: editorView.kind === "post" ? { kind: "record", record: "post" } : { kind: "page" },
    listLabel: "Posts",
    origin: readListOrigin(location.state),
  }) : browsingWorkspace ? browsingDestination : null;

  const navigationFooter = (
    <ControlPresentationProvider value="icons">
      <div className="sidebar-footer" id="sidebar-utilities">
        <div
          className="sidebar-footer-utilities"
          aria-label="View and account controls"
          role="group"
        >
          <div
            className="view-options"
            ref={viewOptionsRef}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setViewOptionsOpen(false);
              event.currentTarget
                .querySelector<HTMLButtonElement>(".view-options-toggle")
                ?.focus();
            }}
          >
            <ActionControl
              size="comfortable"
              action="view-options"
              className="view-options-toggle"
              variant="ghost"
              aria-controls="workspace-view-options"
              aria-expanded={viewOptionsOpen}
              onClick={() => setViewOptionsOpen((open) => !open)}
            />
            {viewOptionsOpen ? <div
              className="view-options-panel"
              id="workspace-view-options"
            >
              <div className="editor-field-label-row">
                <span className="view-options-label" id="density-label">Density</span>
                <InfoTooltip label="layout density" content="Compact reduces space between rows and sections. Comfortable balances reading and editing. Loose adds breathing room. This affects your workspace only; it does not change the public site." />
              </div>
              <div
                className="density-options"
                role="radiogroup"
                aria-labelledby="density-label"
                onKeyDown={(event) => {
                  if (
                    ![
                      "ArrowDown",
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "End",
                      "Home",
                    ].includes(event.key)
                  ) {
                    return;
                  }
                  const options = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      '[role="radio"]',
                    ),
                  );
                  const current =
                    event.target instanceof Element
                      ? event.target.closest<HTMLButtonElement>('[role="radio"]')
                      : null;
                  const currentIndex = current ? options.indexOf(current) : -1;
                  if (currentIndex < 0) return;

                  event.preventDefault();
                  const nextIndex =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? options.length - 1
                        : event.key === "ArrowRight" || event.key === "ArrowDown"
                          ? (currentIndex + 1) % options.length
                          : (currentIndex - 1 + options.length) % options.length;
                  const nextOption = options[nextIndex];
                  const nextDensity = LAYOUT_DENSITIES[nextIndex];
                  if (!nextOption || !nextDensity) return;

                  nextOption.focus();
                  selectDensity(nextDensity, false);
                }}
              >
                {LAYOUT_DENSITIES.map((option) => (
                  <Button
                    key={option}
                    className="density-option"
                    variant="ghost"
                    role="radio"
                    aria-checked={density === option}
                    tabIndex={density === option ? 0 : -1}
                    onClick={() => selectDensity(option)}
                  >
                    {DENSITY_LABELS[option]}
                  </Button>
                ))}
              </div>
            </div> : null}
          </div>
          <ShellAccountMenu
            displayName={displayName}
            email={displayEmail}
            onOpenChange={setAccountMenuOpen}
            open={accountMenuOpen}
            photo={ownPhoto}
            showProfile={!guideOnly}
            signOut={signOut}
          />
        </div>
      </div>
    </ControlPresentationProvider>
  );

  const densityControl = <ActionControl action="change-density" variant={editorView.kind && narrowScreen ? "menu" : "ghost"} size="compact" tooltipLabel={`Density: ${DENSITY_LABELS[density]}`}
                accessibleName={`Density: ${DENSITY_LABELS[density]}. Change to ${DENSITY_LABELS[LAYOUT_DENSITIES[(LAYOUT_DENSITIES.indexOf(density) + 1) % LAYOUT_DENSITIES.length]]}`}
                onClick={() => selectDensity(LAYOUT_DENSITIES[(LAYOUT_DENSITIES.indexOf(density) + 1) % LAYOUT_DENSITIES.length], false)} />;
  return (
    <ExitGuardProvider>
    <PublicContentStatusProvider key={user.uid} getIdToken={getIdToken}>
    <SuccessNoticeProvider routeKey={`${user.uid}:${noticeScope}`}>
    <OwnAuthorPhotoProvider
      value={{ photo: ownPhoto, setPhoto: publishOwnPhoto }}
    >
    <WorkspaceActionsProvider
      target={workspaceActionsTarget}
      secondaryTarget={editorHeader || mobileControls || moreMode === "costs-phone" ? workspaceSecondaryTarget : null}
      statusTarget={workspaceStatusTarget}
      titleTarget={workspaceTitleTarget}
      feedbackTarget={workspaceFeedbackTarget}
      browseToolbarTarget={browsingWorkspace ? browseToolbarTarget : null}
      browseToolbarTrailingTarget={browsingWorkspace ? browseToolbarTrailingTarget : null}
    >
      <div
        className={guidePath ? "app-shell app-shell-guide" : "app-shell"}
        data-editor-kind={editorView.kind ?? undefined}
        data-shared-chrome={sharedChrome || undefined}
        data-live-production={liveProduction || undefined}
        data-browsing-workspace={browsingWorkspace || undefined}
        data-density={density}
        data-sidebar-collapsed={railCollapsed ? "true" : "false"}
        onBlurCapture={(event) => {
          const target = event.nativeEvent.target;
          // A visible control lost focus by choice. A resize-hidden control retains its
          // handoff flag until the media listener exposes the desktop rail.
          if (target instanceof HTMLElement && target.getClientRects().length > 0) restoreRailFocus.current = false;
        }}
        onFocusCapture={(event) => {
          // CSS can hide a focused phone control before matchMedia reports the wider viewport.
          // Retain the last focused control so that resize still has a meaningful return target.
          const target = event.nativeEvent.target;
          restoreRailFocus.current = target instanceof HTMLElement &&
            (target === editorMenuTrigger.current || target.matches(".sidebar .menu-toggle"));
        }}
      >
        <a
          className="skip-link"
          href="#main-content"
          onClick={focusMainContent}
        >
          Skip to main content
        </a>
        <aside
          className="sidebar"
          ref={sidebarRef}
          data-collapsed={railCollapsed ? "true" : "false"}
          data-menu-open={menuOpen ? "true" : "false"}
        >
          {/*
            The rail's own header: the lockup, the control that collapses the rail, and the
            small-screen menu toggle. View and account controls have their own footer below the
            scrollable destination list, so they stay available without reading as destinations.
          */}
          <div className="sidebar-header">
            <BrandLockup />
            {/*
              The rail control stays an icon whatever the account's control preference says.
              "Collapse primary navigation" as written text does not fit a 13rem rail — it
              pushes the lockup out of the header — and in the collapsed rail it spills
              outside the overflow-hidden rail, leaving no visible way back. Icon presentation
              keeps the tooltip and the same accessible name, which is how the rail's own links
              already behave once collapsed: the label lives in the accessibility tree.
            */}
            <ControlPresentationProvider value="icons">
              <ActionControl
                action={
                  sidebarCollapsed ? "sidebar-expand" : "sidebar-collapse"
                }
                size="standard"
                className="sidebar-collapse-toggle"
                variant="ghost"
                aria-controls="primary-navigation"
                aria-expanded={!sidebarCollapsed}
                onClick={toggleSidebar}
              />
              <ActionControl
                action={menuOpen ? "close-menu" : "open-menu"}
                className="menu-toggle"
                variant="ghost"
                aria-controls="primary-navigation sidebar-utilities"
                aria-expanded={menuOpen}
                onClick={() => (phoneNavigationMenu && menuOpen ? closeEditorMenu() : setMenuOpen((open) => !open))}
              />
            </ControlPresentationProvider>
          </div>
          <nav
            className="primary-nav"
            id="primary-navigation"
            aria-label="Primary"
          >
            <WorkspaceFinder fallbackFocusRef={moreActionsTrigger} shortcutEnabled={() => !sharedChrome || !isNarrowScreen()} destinations={railDestinations.map((row) => row.destination)} />
            <ul className="primary-nav-list">
              {railDestinations.map((row, index) => (
                <li key={row.destination.id}>
                  {row.destination.group && row.destination.group !== railDestinations[index - 1]?.destination.group ? (
                    <span className="nav-section-label">{row.destination.group}</span>
                  ) : null}
                  {row.destination.subitems ? (
                    <SidebarDestination
                      destination={row.destination}
                      expanded={expandedNavId === row.destination.id}
                      onExpandedChange={(expanded) => {
                        // The phone drawer shows the rail open; the stored wide-screen preference stays.
                        if (expanded && row.destination.sectionOnly && railCollapsed) {
                          setSidebarChoice(false);
                          writeLayoutDisclosure("navigation", false);
                        }
                        setExpandedNavId((current) =>
                          expanded
                            ? row.destination.id
                            : current === row.destination.id
                              ? null
                              : current,
                        );
                      }}
                      pathname={location.pathname}
                      prefetch={prefetch}
                    />
                  ) : (
                    <NavDestinationLink
                      destination={row.destination}
                      pathname={location.pathname}
                      prefetch={prefetch}
                    />
                  )}
                </li>
              ))}
            </ul>
          </nav>
          {navigationFooter}
        </aside>
        {phoneNavigationMenu && menuOpen ? <div className="editor-nav-scrim" aria-hidden="true" onClick={closeEditorMenu} /> : null}

        <div className="workspace-shell" ref={editorView.setWorkspaceElement}>
        <ControlSizingProvider size={sharedChrome ? "standard" : "legacy"}>
          <div className="workspace-chrome" ref={registerChrome}>
          <header
            className={
              sharedChrome ? "workspace-header workspace-editor-document-bar" : contentPath && !browsingContent
                ? "workspace-header workspace-header-studio"
                : contextHeader
                  ? "workspace-header workspace-header-context"
                  : "workspace-header"
            }
          >
            <div className="workspace-document-bar">
            {phoneNavigationMenu ? <ActionControl action="open-menu" label="Menu" accessibleName="Open navigation" tooltipLabel="Open navigation"
              ref={editorMenuTrigger} className="editor-menu-trigger" size="standard" variant="ghost"
              aria-controls="primary-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)} /> : null}
            <div className="workspace-heading" ref={workspaceHeadingRef}>
              {breadcrumb ? <Link className="editor-document-breadcrumb" to={breadcrumb.to} aria-label={breadcrumb.label}>
                {breadcrumb.shortLabel}<Icon name="chevron-right" />
              </Link> : null}
              <div className="workspace-title" ref={setWorkspaceTitleTarget}>
                {contentPath || templatePath ? null : (
                  <h1 id="page-title" className="programmatic-focus-target">
                    {browsingMedia ? mediaTitle : handle.title}
                  </h1>
                )}
              </div>
              {editorView.kind ? <span className="editor-document-kind">{editorView.kind === "post" ? "Post" : "Page"}</span> : null}
              <div
                className="workspace-status"
                ref={setWorkspaceStatusTarget}
              />
            </div>
            <div className="workspace-tools">
              {browsingWorkspace ? <div className="editor-workspace-find browse-workspace-find"><WorkspaceFinder triggerRef={browseFinderTrigger} fallbackFocusRef={browseFinderFallback} shortcutEnabled={isNarrowScreen} destinations={railDestinations.map(row => row.destination)} /></div> : null}
              <div
                className="workspace-actions"
                id="workspace-actions"
                role="group"
                aria-label="Editor actions"
                ref={setWorkspaceActionsTarget}
              />
              <div
                className="workspace-more-actions"
                ref={moreActionsRef}
                onKeyDown={(event) => {
                  // The native report dialog owns Escape until it closes.
                  if (event.key === "Escape" && moreActionsRef.current?.querySelector("dialog[open]")) {
                    event.stopPropagation();
                  }
                }}
              >
                {sharedChrome ? <ActionControl action="open-menu" graphic={<Icon name={morePresentation.icon} />} label={morePresentation.label} accessibleName={morePresentation.name} tooltipLabel={morePresentation.name}
                  ref={moreActionsTrigger} className="workspace-more-trigger" size="standard" variant="ghost"
                  aria-expanded={moreActionsOpen} aria-controls="workspace-more-panel" onClick={() => {
                    setMoreActionsOpen(value => !value);
                    if (!moreActionsOpen) requestAnimationFrame(() => moreActionsRef.current?.querySelector<HTMLElement>('.workspace-more-panel:not([hidden]) button:not(:disabled):not([aria-disabled="true"]), .workspace-more-panel:not([hidden]) a[href]')?.focus());
                  }} /> : <Button
                  ref={moreActionsTrigger} className="workspace-more-trigger" variant="ghost"
                  aria-expanded={moreActionsOpen} aria-controls="workspace-more-panel" onClick={() => setMoreActionsOpen(value => !value)}>More</Button>}
                <div
                  className="workspace-more-panel"
                  id="workspace-more-panel"
                  ref={morePanelRef}
                  style={morePosition ? { position: "fixed", left: morePosition.left, top: morePosition.top, right: "auto", maxHeight: morePosition.maxHeight } : undefined}
                  hidden={headerMenu && !moreActionsOpen}
                >
                  <div className="workspace-secondary-actions" ref={setWorkspaceSecondaryTarget} />
                  {headerMenu ? <div className="ui-menu-separator workspace-secondary-separator" role="separator" /> : null}
                  {browsingCosts && narrowScreen ? <Button variant="menu" aria-haspopup="dialog" onClick={() => {
                    setMoreActionsOpen(false);
                    moreActionsTrigger.current?.focus();
                    browseFinderTrigger.current?.click();
                  }}><Icon name="search" /><span>Find a workspace</span></Button> : null}
                  {editorView.kind && narrowScreen ? <div className="editor-phone-overflow-actions">
                    <ControlPresentationProvider value="text">{densityControl}
                    {editorView.kind === "page" && editorView.historyAvailable ? <ActionControl action="revision-history" variant="menu" size="compact" onClick={() => { editorView.openPane("details"); editorView.setHistoryOpen(true); }} /> : null}
                    </ControlPresentationProvider>
                    <Button variant="menu" aria-haspopup="dialog" onClick={() => { setMoreActionsOpen(false); moreActionsTrigger.current?.focus(); editorFinderTrigger.current?.click(); }}><Icon name="search" /><span>Find a workspace</span></Button>
                  </div> : null}
                  {editorView.kind ? <Button variant="menu" onClick={event => {
                    document.querySelector(".editor-bento")?.dispatchEvent(new CustomEvent(EDITOR_BENTO_PREFERENCES_EVENT, { detail: moreActionsTrigger.current ?? event.currentTarget }));
                    setMoreActionsOpen(false);
                  }}><Icon name="sliders" /><span>Workspace preferences</span></Button> : null}
                  {editorView.kind ? <div className="ui-menu-separator" role="separator" /> : null}
                  <a
                    aria-label="Open Boardwalk guide in a new tab"
                    className={buttonClassName(headerMenu ? "menu" : "ghost", "legacy", "cms-guide-link")}
                    href={ROUTE_PATHS.guide}
                    rel="noopener noreferrer"
                    target="_blank"
                    title="Open Boardwalk guide"
                  >
                    <Icon name="file" />
                    <span className={headerMenu ? undefined : "workspace-more-label"}>Boardwalk guide</span>
                  </a>
                  <WhatsNewDialog userId={user.uid} menuItem={headerMenu} initiallyOpen={new URLSearchParams(location.search).get("whats-new") === "1"} />
                  {canSubmitProblemReport(principal) ? (
                    <ReportProblemDialog
                      menuItem={headerMenu}
                      canOpenReport={canViewReports(principal)}
                      currentPath={location.pathname}
                      getIdToken={getIdToken}
                    />
                  ) : null}
                </div>
              </div>
            </div>
            </div>
          </header>
          {browsingWorkspace ? <div className="workspace-editing-bar workspace-browse-toolbar">
            <div className="workspace-browse-main" ref={setBrowseToolbarTarget} />
            <div className="workspace-browse-trailing" ref={setBrowseToolbarTrailingTarget} />
          </div> : null}
          <div className="workspace-editing-bar" hidden={!editorView.kind}>
            <div className="workspace-editing-start" role="toolbar" aria-label={editorView.kind === "post" ? "Post editing commands" : "Page editing commands"} ref={editorView.setEditingTarget} />
            <div className="workspace-formatting" ref={editorView.setFormattingTarget} />
            <div className="workspace-editing-end">
              {editorView.historyAvailable && (editorView.kind === "post" || !narrowScreen) ? <ActionControl action="revision-history" variant="ghost" size="compact" onClick={() => { editorView.openPane("details"); editorView.setHistoryOpen(true); }} /> : null}
              {editorView.kind === "post" ? <ActionControl action="focus-writing" variant="ghost" size="compact" aria-pressed={editorView.focusWriting} onClick={() => editorView.setFocusWriting(!editorView.focusWriting)} /> : null}
              <div className="editor-workspace-find"><WorkspaceFinder fallbackFocusRef={moreActionsTrigger} triggerRef={editorFinderTrigger} shortcutEnabled={() => Boolean(editorView.kind && isNarrowScreen())} destinations={railDestinations.map(row => row.destination)} /></div>
              {!narrowScreen ? densityControl : null}
              <ActionControl action={editorView.detailsOpen ? "inspector-close" : "inspector-open"} label="Details" size="compact"
                graphic={<Icon name="panel-right" />} ref={editorView.detailsTrigger}
                aria-expanded={editorView.detailsOpen} aria-controls="editor-details-pane" onClick={() => editorView.togglePane("details")} />
            </div>
          </div>
          <div className="workspace-feedback" ref={setWorkspaceFeedbackTarget} />
          <AdminUpdateNotice />
          </div>
          <div className="workspace-body" data-phone={editorView.phone} data-outline-open={editorView.outlineOpen && !editorView.phone ? "true" : "false"} data-details-open={editorView.detailsOpen && !editorView.phone ? "true" : "false"}>
          <EditorWorkspacePane pane="outline" />
          <main
            className={
              contentPath && !browsingContent ? "content-area content-area-studio" : "content-area"
            }
            id="main-content"
            tabIndex={-1}
            aria-labelledby="page-title"
            aria-busy={routeLoading}
          >
            {showRouteProgress ? (
              <div className="route-loading">
                <LoadingIndicator
                  label="Opening this workspace"
                  stages={ROUTE_CHANGE_STAGES}
                />
              </div>
            ) : null}
            {notice ? (
              <InlineMessage tone="warning" title="Access notice">
                {notice}
              </InlineMessage>
            ) : null}
            <Outlet />
          </main>
          <EditorWorkspacePane pane="details" />
          </div>
        </ControlSizingProvider>
        </div>

        <div aria-live="polite" aria-atomic="true" style={SR_ONLY}>
          {message}
        </div>
      </div>
    </WorkspaceActionsProvider>
    </OwnAuthorPhotoProvider>
    </SuccessNoticeProvider>
    </PublicContentStatusProvider>
    </ExitGuardProvider>
  );
}

// The account menu, rendered as its own component so it sits inside the shell's exit guard and
// can ask before it ends the session. Sign-out is the one exit no router can hold: it is not a
// navigation, so the blocker that protects the editor never sees it. Routing it through the same
// guard is what makes the contract one contract rather than one for navigation and none here
// (#1032). The session ends only after the guard says so, and the tab's remembered destination
// goes with it so the next person to sign in starts at the default one (#1031).
function ShellAccountMenu({
  displayName,
  email,
  onOpenChange,
  open,
  photo,
  showProfile,
  signOut,
}: {
  displayName: string;
  email: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  photo: AvatarPhoto | null;
  showProfile: boolean;
  signOut: () => Promise<void> | void;
}) {
  const requestExit = useExitGuard();
  return (
    <AccountMenu
      displayName={displayName}
      email={email}
      photo={photo}
      items={[
        ...(showProfile
          ? [{
              key: "profile",
              label: "Profile",
              icon: "users" as const,
              to: accountProfilePath(),
            }]
          : []),
        {
          key: "settings",
          label: "Settings",
          icon: "settings",
          to: accountSettingsPath(),
        },
        {
          key: "sign-out",
          label: "Sign out",
          icon: "sign-out",
          onSelect: () => {
            requestExit(() => {
              forgetAdminDestination();
              void signOut();
            });
          },
        },
      ]}
      onOpenChange={onOpenChange}
      open={open}
    />
  );
}
