import {
  act,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { buildRoutes } from "../src/routes/buildRoutes";
import { adminRoutePreloaders } from "../src/routes/routeModules";
import {
  taskFlowActivationBudget,
  taskFlowStage,
} from "../src/lib/task-flow";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import {
  ContentQuickActionsBoundary,
  type ContentQuickActionsApi,
} from "../src/context/ContentQuickActionsContext";
import { ShellProvider } from "../src/routes/ShellContext";
import { pageCompositionSeed } from "../../packages/content-core/src/page-composition-seeds";
import type { ShellData } from "../src/routes/ShellContext";

// The existing 10-second lazy-route hydration wait needs room for the remaining
// interaction checks. Task-flow timing assertions keep their own limits.
vi.setConfig({ testTimeout: 15_000 });

// The route tree is exercised end to end under a memory router, with the same auth and Firestore
// mocks the shell would see in production. The shell's principal is supplied through ShellProvider
// (as App does past admission), so a test picks the role and the tree renders for it.

// The whole useAuth contract the route tree reads, not just getIdToken. App narrows the signed-in
// auth state before mounting the router under ShellProvider, but the hook itself still exposes the
// full state, and route elements may read it directly (a route surface reads state.user.uid to
// identify the signed-in account). Returning only getIdToken left state undefined, so any such read
// threw during render and React Router's default error boundary swallowed the whole tree. Supplying
// a signed-in state keeps the mock faithful to the hook. The uid mirrors shellFor's user so the
// shell and the auth state describe the same person.
const authMocks = vi.hoisted(() => {
  const getIdToken = vi.fn();
  return {
    getIdToken,
    value: {
      state: {
        status: "signed-in",
        user: {
          uid: "user",
          email: "account-29@example.org",
          displayName: "Test User",
        },
        principal: { id: "user", grants: [] },
        userDoc: null,
      },
      signIn: vi.fn(),
      signOut: vi.fn(),
      getIdToken,
    },
  };
});

const functionMocks = vi.hoisted(() => ({
  cmsGetAuthorProfile: vi.fn(),
  cmsListAuthorProfiles: vi.fn(),
  cmsGetContent: vi.fn(),
  cmsGetBroadcastSchedule: vi.fn(),
  cmsGetNewsroomBanner: vi.fn(),
  cmsGetSettings: vi.fn(),
  cmsListAudit: vi.fn(),
  cmsListContent: vi.fn(),
  cmsListMedia: vi.fn(),
  cmsListMediaCategories: vi.fn(),
  cmsSaveContent: vi.fn(),
  cmsUpdateMediaMetadata: vi.fn(),
  cmsSaveSettings: vi.fn(),
}));

const reviewMocks = vi.hoisted(() => ({
  cmsListReviewQueue: vi.fn(),
}));

// Firestore reads made by newsroom record lists and the content editor's page hydration.
// Empty snapshots keep the work surface honest and hydrate the editor empty in tests.
const firestoreMocks = vi.hoisted(() => ({
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
  getDocs: vi.fn(async () => ({ docs: [] })),
  onSnapshot: vi.fn(
    (_reference: unknown, next: (snapshot: unknown) => void) => {
      next({ exists: () => false, docs: [] });
      return () => {};
    },
  ),
  runTransaction: vi.fn(
    async (
      _database: unknown,
      update: (transaction: unknown) => Promise<unknown>,
    ) =>
      update({
        get: async () => ({ exists: () => false, data: () => ({}) }),
        set: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      }),
  ),
  serverTimestamp: vi.fn(() => ({ toMillis: () => Date.now() })),
  updateDoc: vi.fn(),
}));

vi.mock("firebase/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase/firestore")>()),
  doc: firestoreMocks.doc,
  getDoc: firestoreMocks.getDoc,
  getDocs: firestoreMocks.getDocs,
  onSnapshot: firestoreMocks.onSnapshot,
  runTransaction: firestoreMocks.runTransaction,
  serverTimestamp: firestoreMocks.serverTimestamp,
  updateDoc: firestoreMocks.updateDoc,
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => authMocks.value,
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsGetAuthorProfile: functionMocks.cmsGetAuthorProfile,
  cmsListAuthorProfiles: functionMocks.cmsListAuthorProfiles,
  cmsGetContent: functionMocks.cmsGetContent,
  cmsGetBroadcastSchedule: functionMocks.cmsGetBroadcastSchedule,
  cmsGetNewsroomBanner: functionMocks.cmsGetNewsroomBanner,
  cmsGetSettings: functionMocks.cmsGetSettings,
  cmsListAudit: functionMocks.cmsListAudit,
  cmsListContent: functionMocks.cmsListContent,
  cmsListMedia: functionMocks.cmsListMedia,
  cmsListMediaCategories: functionMocks.cmsListMediaCategories,
  cmsSaveContent: functionMocks.cmsSaveContent,
  cmsUpdateMediaMetadata: functionMocks.cmsUpdateMediaMetadata,
  cmsSaveSettings: functionMocks.cmsSaveSettings,
}));

vi.mock("../src/lib/review-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/review-queue")>()),
  cmsListReviewQueue: reviewMocks.cmsListReviewQueue,
}));

function shellFor(
  principal: ShellData["principal"],
  overrides: Partial<ShellData> = {},
): ShellData {
  const topLevelRole = principal.grants.some(
    (grant) => grant.role === "super_admin",
  )
    ? "super_admin"
    : principal.grants.some((grant) => grant.role === "admin")
      ? "admin"
      : null;
  return {
    principal,
    user: {
      uid: "user",
      email: "account-29@example.org",
      displayName: "Test User",
    } as unknown as ShellData["user"],
    // In production the principal and this legacy-role field come from the same user document.
    // Keep the fixture equally coherent because courtesy-lock access still reads the top-level
    // role even though content navigation itself now follows the principal's capabilities.
    userDoc: topLevelRole === null ? null : { role: topLevelRole },
    signOut: vi.fn(),
    ...overrides,
  };
}

// One stored asset, so the media surface has something to open an inspector on.
const mediaAsset = {
  id: "asset-one",
  name: "Studio control room",
  originalName: "studio.png",
  category: "news",
  categories: ["news"],
  tags: ["studio"],
  description: "Main production room",
  altText: "Monitors and switchers",
  license: "NJ PBS owned",
  credit: "NJ PBS",
  mimeType: "image/png",
  kind: "image" as const,
  sizeBytes: 2_048,
  width: 1_600,
  height: 900,
  url: "https://media.njpbs.org/studio.png",
  lifecycle: "active" as const,
  version: 2,
  etag: '"media.YXNzZXQtb25l.2"',
  createdAt: "2026-08-13T12:00:00.000Z",
  createdBy: "user",
  updatedAt: "2026-08-13T12:00:00.000Z",
  updatedBy: "user",
};

const adminPrincipal = {
  id: "admin",
  grants: [{ role: "admin" }],
} as unknown as ShellData["principal"];

const contributorPrincipal = {
  id: "contributor",
  grants: [{ role: "contributor", sections: ["news"] }],
} as unknown as ShellData["principal"];

const siteWideEditorPrincipal = {
  id: "editor",
  grants: [{ role: "editor" }],
} as unknown as ShellData["principal"];

const siteWideContributorPrincipal = {
  id: "contributor",
  grants: [{ role: "contributor" }],
} as unknown as ShellData["principal"];

function renderRouted(shell: ShellData, initialEntries: string[] = ["/"]) {
  const router = createMemoryRouter(buildRoutes(), { initialEntries });
  return render(
    <ShellProvider value={shell}>
      <RouterProvider router={router} />
    </ShellProvider>,
  );
}

async function openScheduleButtons() {
  const edit = await waitFor(() => {
    const control = screen.getByLabelText("Edit Schedule actions", { selector: "button" });
    expect(control).toBeVisible();
    expect(control).toBeEnabled();
    return control;
  }, { timeout: 10_000 });
  fireEvent.click(edit);
}

async function editScheduleWatchLiveLabel(nextLabel: string) {
  await openScheduleButtons();
  const details = screen.getByRole("region", { name: "Details" });
  fireEvent.click(within(details).getByRole("button", { name: "Watch live" }));
  const label = within(details).getByRole("textbox", { name: "Button label" });
  fireEvent.change(label, { target: { value: nextLabel } });
  expect(label).toHaveValue(nextLabel);
  fireEvent.click(within(details).getByRole("button", { name: "Close details" }));
}

async function expectScheduleWatchLiveLabel(label: string) {
  await openScheduleButtons();
  const details = screen.getByRole("region", { name: "Details" });
  expect(within(details).getByRole("button", { name: label })).toBeVisible();
  fireEvent.click(within(details).getByRole("button", { name: "Close details" }));
}

// Match the addressed editor startup preparation once for this routing suite.
// Its assertions cover navigation and save ownership after the editor mounts.
beforeAll(() => adminRoutePreloaders.content());

beforeEach(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
  vi.clearAllMocks();
  reviewMocks.cmsListReviewQueue.mockResolvedValue({
    success: true,
    requests: [],
  });
  localStorage.clear();
  sessionStorage.clear();
  authMocks.getIdToken.mockResolvedValue("id-token");
  functionMocks.cmsGetContent.mockResolvedValue({
    success: true,
    found: false,
    document: null,
  });
  functionMocks.cmsGetBroadcastSchedule.mockResolvedValue({
    success: true,
    source: {
      coverageStart: "2026-10-01",
      coverageEnd: "2026-11-05",
      label: "Synthetic broadcast packet A",
      received: "2026-09-01",
      timezone: "America/New_York",
    },
    airings: [],
  });
  functionMocks.cmsGetNewsroomBanner.mockResolvedValue({
    success: true,
    heading: "Admin interface and user experience",
    milestoneNumber: 16,
    source: "default",
    version: null,
  });
  functionMocks.cmsGetSettings.mockResolvedValue({
    success: true,
    found: false,
    id: "newsroom-home",
  });
  functionMocks.cmsListContent.mockResolvedValue({
    success: true,
    records: [],
    total: 0,
    allCount: 0,
    mineCount: 0,
    assignedCount: 0,
    page: 1,
    pageCount: 1,
    statusCounts: {
      draft: 0,
      in_review: 0,
      scheduled: 0,
      published: 0,
      archived: 0,
    },
  });
  functionMocks.cmsListAudit.mockResolvedValue({
    success: true,
    entries: [],
    nextCursor: null,
  });
  functionMocks.cmsListMedia.mockResolvedValue({
    success: true,
    records: [],
    total: 0,
    allCount: 0,
    page: 1,
    pageCount: 1,
    categoryCounts: {},
    kindCounts: { image: 0, document: 0 },
  });
  functionMocks.cmsListMediaCategories.mockResolvedValue({
    success: true,
    categories: [
      {
        id: "news",
        label: "News",
        description: "News media",
        order: 10,
        active: true,
        reserved: false,
        version: 1,
        etag: '"media-category.bmV3cw.1"',
        canUpload: true,
        canManage: true,
        createdAt: null,
        createdBy: null,
        updatedAt: null,
        updatedBy: null,
      },
    ],
  });
});

describe("admin routing shell", () => {
  it("opens newsroom home at the root", async () => {
    renderRouted(shellFor(adminPrincipal), ["/"]);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole(
      "link",
      { name: "Find an image" },
      { timeout: 10_000 },
    )).toHaveAttribute(
      "href",
      "/media",
    );
    expect(screen.getByRole("link", { name: "Recent activity" })).toHaveAttribute(
      "href",
      "/activity",
    );
  });

  it("opens the authenticated media library from primary navigation", async () => {
    renderRouted(shellFor(adminPrincipal), ["/media"]);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Media library" }),
    ).toBeInTheDocument();
    expect(
      // This route imports its media module on first use. Allow cold CI module
      // loading here; task-flow tests check the interaction timing separately.
      await screen.findByRole(
        "heading",
        { level: 2, name: "Images" },
        { timeout: 10_000 },
      ),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Media library" }))
      .toHaveAttribute("href", "/media");
    expect(within(nav).getByRole("link", { name: "Media library" }))
      .toHaveAttribute("aria-current", "page");
    await waitFor(() => {
      expect(functionMocks.cmsListMedia).toHaveBeenCalledWith("id-token", {
        q: "",
        categories: [],
        kinds: [],
        sort: "updatedAt",
        direction: "desc",
        page: 1,
        paging: "cursor",
      }, undefined, { counts: true, favorites: true });
    });
  });

  it("loads bounded newsroom rows with server-settled aggregate counts", async () => {
    const record = {
      id: "post-1",
      kind: "post",
      title: "Newsroom post",
      status: "draft",
      updatedAt: "2026-08-11T12:00:00.000Z",
    };
    functionMocks.cmsListContent.mockResolvedValue({
      success: true,
      records: [record],
      total: 1,
      allCount: 1,
      mineCount: 6,
      assignedCount: 4,
      page: 1,
      pageCount: 3,
      statusCounts: {
        draft: 9,
        in_review: 0,
        scheduled: 0,
        published: 0,
        archived: 0,
      },
    });

    renderRouted(shellFor(adminPrincipal), ["/"]);

    await waitFor(
      () => {
        expect(
          screen.getByRole("link", { name: "Newsroom post" }),
        ).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
    expect(functionMocks.cmsListContent).toHaveBeenCalledTimes(1);
    expect(functionMocks.cmsListContent).toHaveBeenCalledWith(
      "id-token",
      "v=1",
    );
    expect(screen.getByTestId("draft-count")).toHaveTextContent("9");
    expect(screen.getByRole("link", { name: "My recent edits (6)" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Assigned to me (4)" })).toBeVisible();
    expect(functionMocks.cmsGetNewsroomBanner).toHaveBeenCalledWith("id-token");
  });

  it("moves focus past repeated navigation when the skip link is activated", () => {
    renderRouted(shellFor(adminPrincipal), ["/dashboard"]);

    const skipLink = screen.getByRole("link", { name: "Skip to main content" });
    const main = screen.getByRole("main");
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(main).toHaveAttribute("id", "main-content");
    expect(main).toHaveAttribute("tabindex", "-1");

    fireEvent.click(skipLink);
    expect(main).toHaveFocus();
  });

  it("offers a scoped contributor their authoring destinations and no operational ones", async () => {
    // A section-scoped grant now reaches content (#845): the server allows or refuses each
    // document against its own desk, so the authoring destinations are real work for this
    // person rather than a wall. What stays hidden is what the grant genuinely does not
    // confer -- operational surfaces. Shared video access is available to all staff.
    // The page directory filters
    // its records at the server boundary and hides inaccessible built-in shortcuts.
    renderRouted(shellFor(contributorPrincipal), ["/dashboard"]);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Posts" })).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "All content" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Pages" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Media library" }),
    ).toBeInTheDocument();
    expect(
      within(nav).queryByRole("link", { name: "Home page" }),
    ).not.toBeInTheDocument();
    expect(
      within(nav).queryByRole("link", { name: "Editorial queue" }),
    ).not.toBeInTheDocument();
    expect(
      within(nav).queryByRole("link", { name: "Staff access" }),
    ).not.toBeInTheDocument();
    expect(
      within(nav).queryByRole("link", { name: "Activity" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "New post" }),
    ).not.toBeInTheDocument();
  });

  it("opens account settings for an admitted contributor outside primary navigation", async () => {
    renderRouted(
      shellFor(contributorPrincipal, {
        userDoc: {
          role: null,
          preferences: {
            display: { controlPresentation: "text" },
          },
        },
      }),
      ["/account/settings"],
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "Account settings" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("group", { name: "Control presentation" }),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(nav).queryByRole("link", { name: "Account settings" }),
    ).not.toBeInTheDocument();

    // Account actions live behind the avatar's menu now, so they are reached by
    // operating that control rather than by a link that is always on screen.
    fireEvent.click(
      screen.getByRole("button", { name: "Account menu for Test User" }),
    );
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveAttribute(
      "href",
      "/account/settings",
    );
  });

  it("reaches the author's own profile from the account menu", async () => {
    functionMocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: {
        authorId: "au_1",
        displayName: "Test User",
        jobTitle: null,
        bio: null,
        photo: null,
        links: {},
        visibility: "private",
        slug: null,
        previousSlugs: [],
        publishedAt: null,
        withdrawnAt: null,
        withdrawnReason: null,
        version: 1,
        updatedAt: "2026-08-20T12:00:00.000Z",
        staffStatus: "active",
        publicPath: null,
      },
    });
    renderRouted(shellFor(contributorPrincipal), ["/"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Account menu for Test User" }),
    );
    const profile = screen.getByRole("menuitem", { name: "Profile" });
    expect(profile).toHaveAttribute("href", "/account/profile");

    fireEvent.click(profile);

    expect(
      await screen.findByRole("heading", { name: "Your public profile" }),
    ).toBeInTheDocument();
  });

  it("keeps staff profiles out of a contributor's navigation", () => {
    renderRouted(shellFor(contributorPrincipal), ["/"]);
    expect(
      within(screen.getByRole("navigation", { name: "Primary" })).queryByRole(
        "link",
        { name: "Staff profiles" },
      ),
    ).not.toBeInTheDocument();
  });

  it("offers staff profiles where staff accounts can be managed", async () => {
    functionMocks.cmsListAuthorProfiles.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profiles: [],
      nextCursor: null,
    });
    renderRouted(shellFor(adminPrincipal), ["/staff-profiles"]);

    expect(
      await screen.findByRole("heading", { name: "Staff profiles", level: 2 }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
        "link",
        { name: "Staff profiles" },
      ),
    ).toHaveAttribute("href", "/staff-profiles");
  });

  it("offers the operational surfaces to an admin", () => {
    renderRouted(shellFor(adminPrincipal), ["/dashboard"]);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(nav).getByRole("link", { name: "Editorial queue" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Staff access" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Activity" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Media library" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Admin settings" }),
    ).toHaveAttribute("href", "/admin/settings");
  });

  it("opens the separate Admin settings route for settings managers", async () => {
    renderRouted(shellFor(adminPrincipal), ["/admin/settings"]);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Admin settings" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "Public homepage banner" })).toBeVisible();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Newsroom defaults" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Newsroom home banner" }),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Admin settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("hides and route-gates Admin settings without settings.manage", async () => {
    renderRouted(shellFor(siteWideEditorPrincipal), ["/admin/settings"]);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Admin settings aren't available for your account."),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Primary" })).queryByRole(
        "link",
        { name: "Admin settings" },
      ),
    ).not.toBeInTheDocument();
  });

  it("offers content and media tools to a site-wide editor", () => {
    renderRouted(shellFor(siteWideEditorPrincipal), ["/dashboard"]);
    const nav = screen.getByRole("navigation", { name: "Primary" });

    expect(
      within(nav).getByRole("link", { name: "Pages" }),
    ).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Posts" })).toHaveAttribute(
      "href",
      "/content/post",
    );
    expect(
      within(nav).getByRole("link", { name: "All content" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Media library" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Editorial queue" }),
    ).toBeInTheDocument();
    expect(
      within(nav).queryByRole("link", { name: "Staff access" }),
    ).not.toBeInTheDocument();
    expect(
      within(nav).queryByRole("link", { name: "Activity" }),
    ).not.toBeInTheDocument();
  });

  it("keeps contributor record entry points without exposing unreadable page links", async () => {
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/dashboard"],
    });
    render(
      <ShellProvider value={shellFor(siteWideContributorPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(nav).getByRole("link", { name: "Pages" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Posts" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "All content" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Media library" }),
    ).toBeInTheDocument();
    await waitFor(
      () =>
        expect(
          screen.getByRole("link", { name: "New post" }),
        ).toBeInTheDocument(),
      { timeout: 10_000 },
    );
    expect(
      screen.queryByRole("link", { name: "Edit homepage" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      await router.navigate("/content");
    });
    const pages = await screen.findByRole("table", { name: "Live site pages" });
    expect(pages).toBeInTheDocument();
    expect(within(pages).queryByRole("link", { name: /Edit page draft:/ })).not.toBeInTheDocument();
  });

  it("defaults to comfortable and persists compact without removing navigation from the accessibility tree", () => {
    const first = renderRouted(shellFor(adminPrincipal), ["/dashboard"]);
    const shell = first.container.querySelector(".app-shell");
    const nav = screen.getByRole("navigation", { name: "Primary" });

    expect(shell).toHaveAttribute("data-density", "comfortable");
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "false");

    const collapse = screen.getByRole("button", {
      name: "Collapse primary navigation",
    });
    fireEvent.click(collapse);
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    expect(
      screen.getByRole("button", { name: "Expand primary navigation" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      within(nav).getByRole("link", { name: "Pages" }),
    ).toBeInTheDocument();

    const viewOptions = screen.getByRole("button", { name: "View options" });
    expect(viewOptions).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(viewOptions);
    expect(viewOptions).toHaveAttribute("aria-expanded", "true");

    const density = screen.getByRole("radiogroup", { name: "Density" });
    const compact = within(density).getByRole("radio", { name: "Compact" });
    fireEvent.click(compact);
    expect(shell).toHaveAttribute("data-density", "compact");
    expect(viewOptions).toHaveAttribute("aria-expanded", "false");
    expect(viewOptions).toHaveFocus();
    expect(
      screen.queryByRole("radiogroup", { name: "Density" }),
    ).not.toBeInTheDocument();

    fireEvent.click(viewOptions);
    expect(screen.getByRole("radio", { name: "Compact" })).toHaveAttribute("aria-checked", "true");
    first.unmount();
    const second = renderRouted(shellFor(adminPrincipal), ["/dashboard"]);
    expect(second.container.querySelector(".app-shell")).toHaveAttribute(
      "data-sidebar-collapsed",
      "true",
    );
    expect(second.container.querySelector(".app-shell")).toHaveAttribute(
      "data-density",
      "compact",
    );
  });

  it("keeps view and account controls in the footer and reporting in the header", () => {
    const { container } = renderRouted(shellFor(adminPrincipal), ["/dashboard"]);
    const rail = container.querySelector<HTMLElement>(".sidebar");
    const navigationHeader = container.querySelector<HTMLElement>(".sidebar-header");
    const navigation = container.querySelector<HTMLElement>(".primary-nav");
    const navigationFooter = container.querySelector<HTMLElement>(".sidebar-footer");
    const workspaceHeader = container.querySelector<HTMLElement>(".workspace-header");
    if (
      !rail ||
      !navigationHeader ||
      !navigation ||
      !navigationFooter ||
      !workspaceHeader
    ) {
      throw new Error("Missing shell regions");
    }

    const utilities = navigationFooter.querySelector<HTMLElement>(
      ".sidebar-footer-utilities",
    );
    if (!utilities) throw new Error("Missing navigation footer utilities");
    expect(
      screen.getByRole("group", { name: "View and account controls" }),
    ).toBe(utilities);
    expect(
      within(utilities).getByRole("button", { name: "View options" }),
    ).toBeVisible();
    expect(
      within(utilities).getByRole("button", {
        name: "Account menu for Test User",
      }),
    ).toBeVisible();
    expect(utilities.querySelectorAll(".account-avatar")).toHaveLength(1);
    expect(
      within(navigation).getByRole("link", { name: "Admin settings" }),
    ).toBeVisible();
    expect(
      within(navigationFooter).queryByRole("link", { name: "Admin settings" }),
    ).toBeNull();
    expect(navigationHeader.querySelector(".sidebar-footer-utilities")).toBeNull();
    expect(
      within(workspaceHeader).queryByRole("button", { name: "View options" }),
    ).toBeNull();
    expect(
      within(workspaceHeader).getByRole("button", { name: "Report a problem" }),
    ).toBeVisible();
    expect(
      within(workspaceHeader).getByRole("link", {
        name: "Open Boardwalk guide in a new tab",
      }),
    ).toHaveAttribute("href", "/guide");
    expect(workspaceHeader.querySelector(".workspace-identity")).toBeNull();
    expect(workspaceHeader.querySelector(".workspace-tools")?.children).toHaveLength(2);
    expect(
      navigation.compareDocumentPosition(navigationFooter) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(navigationFooter.parentElement).toBe(rail);
  });

  it("closes view options after an outside activation", () => {
    renderRouted(shellFor(adminPrincipal), ["/dashboard"]);

    const viewOptions = screen.getByRole("button", { name: "View options" });
    fireEvent.click(viewOptions);
    expect(viewOptions).toHaveAttribute("aria-expanded", "true");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Collapse primary navigation" }),
    );

    expect(viewOptions).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("radiogroup", { name: "Density" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a shadow-scoped density choice open until its click is applied", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    const mount = document.createElement("div");
    shadowRoot.append(mount);
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/dashboard"],
    });
    const rendered = render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
      { container: mount },
    );
    const shadow = within(mount);

    const viewOptions = shadow.getByRole("button", { name: "View options" });
    fireEvent.click(viewOptions);
    const compact = shadow.getByRole("radio", { name: "Compact" });

    fireEvent(
      compact,
      new Event("pointerdown", { bubbles: true, composed: true }),
    );
    expect(viewOptions).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(compact);
    expect(mount.querySelector(".app-shell")).toHaveAttribute(
      "data-density",
      "compact",
    );
    expect(viewOptions).toHaveAttribute("aria-expanded", "false");

    rendered.unmount();
    host.remove();
  });

  it("gives Content Studio routes their edge-to-edge working canvas", () => {
    const { container } = renderRouted(shellFor(adminPrincipal), [
      "/content/pages/home/edit",
    ]);

    expect(container.querySelector("#main-content")).toHaveClass(
      "content-area-studio",
    );
  });

  it("keeps the document title, status, preview, save, and publish actions in one header", async () => {
    functionMocks.cmsGetContent.mockResolvedValue({
      success: true,
      found: true,
      document: {
        id: "schedule",
        template: "programLanding",
        title: "Schedule",
        blocks: [],
        status: "approved",
        version: 4,
        createdBy: "user",
      },
    });
    const { container } = renderRouted(shellFor(adminPrincipal), [
      "/content/pages/schedule/edit",
    ]);

    const header = container.querySelector(".workspace-editor-document-bar");
    expect(header).toBeTruthy();
    // The page editor's first hydration is the slowest render in this file, and the default
    // one-second wait sat right on that boundary. The wait is a load allowance, not the behavior
    // under test: the assertion is still that the title lands in the one document header.
    expect(
      await within(header as HTMLElement).findByRole(
        "heading",
        { level: 1, name: "Schedule" },
        { timeout: 10_000 },
      ),
    ).toBeVisible();
    expect(
      await within(header as HTMLElement).findByText("Approved"),
    ).toBeVisible();
    expect(
      await within(header as HTMLElement).findByRole("button", {
        name: "Preview",
      }),
    ).toBeVisible();
    expect(
      await within(header as HTMLElement).findByRole("button", {
        name: "Save draft",
      }),
    ).toBeVisible();
    fireEvent.click(await within(header as HTMLElement).findByRole("button", { name: "Review & publish" }));
    expect(screen.getByRole("button", { name: "Publish" })).toBeVisible();
    expect(
      container.querySelector(".editor-canvas-header"),
    ).not.toBeInTheDocument();
  });

  it.each([
    "A very long saved document title with enough words to exceed the persistent header width without changing its accessible name",
    "Averylongsaveddocumenttitlewithoutanybreakopportunitythatmustremaincompleteforassistivetechnology",
  ])("keeps the complete canonical headline beneath the short document title: %s", async (title) => {
    functionMocks.cmsGetContent.mockResolvedValue({
      success: true,
      found: true,
      document: {
        id: "post-1",
        type: "post",
        title,
        date: "2026-08-14",
        tags: [],
        blocks: [],
        status: "draft",
        version: 4,
        createdBy: "user",
      },
    });
    const { container, unmount } = renderRouted(shellFor(adminPrincipal), [
      "/content/post/post-1/edit",
    ]);

    const header = container.querySelector(".workspace-editor-document-bar");
    const heading = await within(header as HTMLElement).findByRole("heading", {
      level: 1,
      name: "Edit post",
    });
    expect(heading).toHaveTextContent("Edit post");
    expect(await screen.findByRole("textbox", { name: "Headline" })).toHaveValue(title);
    expect(heading).toHaveClass("programmatic-focus-target");

    unmount();
  });

  it("keeps post body commands out of the persistent document header", async () => {
    functionMocks.cmsGetContent.mockResolvedValue({
      success: true,
      found: true,
      document: {
        id: "post-1",
        type: "post",
        title: "Garden State update",
        date: "2026-08-14",
        tags: [],
        blocks: [],
        status: "draft",
        version: 2,
        createdBy: "user",
      },
    });
    const { container } = renderRouted(shellFor(adminPrincipal), [
      "/content/post/post-1/edit",
    ]);

    const header = container.querySelector(".workspace-editor-document-bar");
    expect(header).toBeTruthy();
    expect(
      await within(header as HTMLElement).findByRole("heading", {
        level: 1,
        name: "Edit post",
      }),
    ).toBeVisible();
    expect(
      within(header as HTMLElement).queryByRole("toolbar", {
        name: "Page editing commands",
      }),
    ).toBeNull();
    expect(
      within(header as HTMLElement).queryByRole("button", { name: "Undo" }),
    ).toBeNull();
    const status = header?.querySelector<HTMLElement>(".workspace-status");
    expect(status).toBeTruthy();
    expect(await within(status as HTMLElement).findByText("Captured draft")).toBeVisible();
    expect(within(status as HTMLElement).getByText(/Checking public site…|Public status unavailable/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    fireEvent.click(await within(header as HTMLElement).findByRole("button", { name: "Review & publish" }));
    expect(screen.getByRole("button", { name: "Publish" })).toHaveClass("ui-menu-item");
    expect(screen.getByRole("button", { name: "Publish" }).querySelector(".icon")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      within(header as HTMLElement).getByRole("button", { name: "Save draft" }),
    ).toHaveClass("button-secondary");
    const actions = header?.querySelector<HTMLElement>(".workspace-actions");
    const editing = within(header as HTMLElement).getByRole("group", { name: "Editing" });
    expect(within(editing).getByRole("button", { name: "Save draft" })).toBeVisible();
    expect(within(header as HTMLElement).getByRole("button", { name: "Review & publish" })).toBeVisible();
    expect(actions?.querySelector(".status-label")).toBeNull();
    const editor = await screen.findByRole("group", {
      name: "Post editor sections",
    });
    const writing = within(editor).getByRole("region", { name: "Main area" });
    const body = within(writing).getByRole("article", { name: "Post body" });
    expect(within(body).queryByRole("toolbar", { name: "Post editing commands" })).toBeNull();
    expect(within(container.querySelector(".workspace-editing-bar") as HTMLElement).getByRole("toolbar", { name: "Post editing commands" })).toBeVisible();
  });

  it("moves through density choices with radio-group arrow keys", () => {
    renderRouted(shellFor(adminPrincipal), ["/dashboard"]);

    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    const density = screen.getByRole("radiogroup", { name: "Density" });
    const comfortable = within(density).getByRole("radio", {
      name: "Comfortable",
    });
    const loose = within(density).getByRole("radio", { name: "Loose" });

    comfortable.focus();
    fireEvent.keyDown(comfortable, { key: "ArrowRight" });

    expect(loose).toHaveAttribute("aria-checked", "true");
    expect(loose).toHaveFocus();
  });

  // The visual section highlight and announced current page have separate jobs. An exact
  // shortcut is the one current page; otherwise the parent section link owns that state.
  it.each([
    ["Pages", "Edit home page", ["Posts", "All content"], "/content/pages/home/edit"],
    ["All content", "All content", ["Pages", "Posts"], "/content/program/prog-123/edit"],
  ])(
    "marks %s current on its nested editor route",
    async (section, current, others, path) => {
      renderRouted(shellFor(adminPrincipal), [path]);
      const nav = screen.getByRole("navigation", { name: "Primary" });

      fireEvent.click(within(nav).getByRole("button", { name: `Show ${section} actions` }));
      const sectionLink = within(nav).getByRole("link", { name: section });
      const currentLink = within(nav).getByRole("link", { name: current });
      expect(currentLink).toHaveAttribute("aria-current", "page");
      expect(sectionLink).toHaveClass("active");
      if (current !== section) {
        expect(sectionLink).not.toHaveAttribute("aria-current");
      }

      // The other sections must not also claim to be current.
      for (const other of others) {
        const otherLink = within(nav).getByRole("link", { name: other });
        expect(otherLink).not.toHaveAttribute("aria-current");
        expect(otherLink).not.toHaveClass("active");
      }
    },
  );

  it("uses one responsive navigation hierarchy and closes it after a destination opens", async () => {
    renderRouted(shellFor(adminPrincipal), ["/dashboard"]);

    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Pages" })).toHaveAttribute(
      "href",
      "/content",
    );
    expect(
      within(nav).getByRole("link", { name: "All content" }),
    ).toHaveAttribute("href", "/content/library");
    expect(within(nav).getByRole("link", { name: "Posts" })).toHaveAttribute(
      "href",
      "/content/post",
    );
    expect(
      within(nav).queryByRole("link", { name: "Home page" }),
    ).not.toBeInTheDocument();

    const menu = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(nav).getByRole("button", { name: "Show Pages actions" }));
    fireEvent.click(within(nav).getByRole("link", { name: "Pages" }));
    expect(
      await screen.findByRole(
        "heading",
        { level: 1, name: "Site pages" },
        { timeout: 5_000 },
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("Edit pages and records."),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(menu).toHaveAttribute("aria-expanded", "false"));
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(within(nav).getByRole("button", { name: "Hide Pages actions" })).toHaveAttribute(
      "aria-expanded", "true",
    );
  });

  it.each([
    ["/content/post", "All posts"],
    ["/content/post/+", "Add new post"],
    ["/content/post/post-123/edit", "Posts"],
  ])(
    "marks Posts current throughout its nested route at %s",
    async (path, current) => {
      renderRouted(shellFor(adminPrincipal), [path]);
      const nav = screen.getByRole("navigation", { name: "Primary" });

      fireEvent.click(within(nav).getByRole("button", { name: "Show Posts actions" }));
      const posts = within(nav).getByRole("link", { name: "Posts" });
      expect(within(nav).getByRole("link", { name: current })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(posts).toHaveClass("active");
      if (current !== "Posts") {
        expect(posts).not.toHaveAttribute("aria-current");
      }
      expect(
        within(nav).getByRole("link", { name: "All content" }),
      ).not.toHaveAttribute("aria-current");
      expect(
        within(nav).getByRole("link", { name: "Pages" }),
      ).not.toHaveAttribute("aria-current");
    },
  );

  it("reports a client-side lazy navigation until the destination resolves", async () => {
    const routes = buildRoutes();
    const rootRoute = routes[0];
    const surfaceRoutes = rootRoute?.children?.find(
      (route) => route.path === undefined && route.index !== true,
    )?.children;
    const indexRoute = surfaceRoutes?.find((route) => route.index);
    const staffRoute = surfaceRoutes?.find(
      (route) => route.path === "staff-access",
    );
    if (!indexRoute || !staffRoute)
      throw new Error("Expected admin routes are missing");

    // Start on an eager test-only home, then hold the real staff destination seam open. This
    // isolates a client navigation from the separate initial-hydration fallback and proves the
    // persistent shell owns feedback while a lazy chunk is still in flight.
    indexRoute.lazy = undefined;
    indexRoute.element = <p>Home ready</p>;
    let finishNavigation: (() => void) | undefined;
    staffRoute.lazy = () =>
      new Promise((resolve) => {
        finishNavigation = () =>
          resolve({ Component: () => <p>Staff workspace ready</p> });
      });

    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Staff access" }));
    // The main region is busy from the first frame, but the notice waits out the delay so a
    // fast route never flashes it; a load that outlasts the delay shows the progress bar.
    await waitFor(() =>
      expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true"),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Opening this workspace",
    );
    expect(screen.getByRole("status").querySelector(".spinner")).not.toBeNull();
    expect(document.querySelector(".route-loading-bar")).toBeNull();

    await act(async () => finishNavigation?.());
    expect(await screen.findByText("Staff workspace ready")).toBeVisible();
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false");
  });

  it("marks the active destination on the matching route", async () => {
    renderRouted(shellFor(adminPrincipal), ["/publish-queue"]);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(nav).getByRole("link", { name: "Editorial queue" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("opens the verified broadcast schedule for a guide-only account", async () => {
    renderRouted(
      shellFor({ id: "new-staff", grants: [{ role: "staff" }] }),
      ["/schedule?week=2026-09-28"],
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "Broadcast schedule" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Source packet · Read only")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Oct 1 to Nov 5, 2026" })).toBeVisible();
    fireEvent.click(screen.getByText("Source details and update limits"));
    expect(
      screen.getByText(
        /Synthetic broadcast packet A\. Received Sep 1, 2026\./,
      ),
    ).toBeVisible();
    const dayNav = screen.getByRole("group", { name: "Choose a day" });
    expect(within(dayNav).getAllByRole("button")).toHaveLength(8);
    expect(within(dayNav).getAllByText("Not covered")).toHaveLength(3);
    expect(
      screen.getByText("No broadcast times are listed for this week."),
    ).toBeVisible();
    expect(functionMocks.cmsGetBroadcastSchedule).toHaveBeenCalledWith("id-token");
    expect(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
        "link",
        { name: "Broadcast schedule" },
      ),
    ).toHaveAttribute("aria-current", "page");
  });

  it("does not mark a content destination active for a malformed content address", () => {
    renderRouted(shellFor(adminPrincipal), ["/content/not-a-type/edit"]);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(nav).getByRole("link", { name: "Pages" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(nav).getByRole("link", { name: "Posts" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(nav).getByRole("link", { name: "All content" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("defaults a new Post to the contributor's only permitted Area", async () => {
    await import("../src/components/EditorWorkspace");
    renderRouted(shellFor(contributorPrincipal), ["/content/post/+"]);
    const area = await screen.findByRole("combobox", { name: /^Area/ });
    await waitFor(() => expect(area).toHaveValue("news"));
    expect(functionMocks.cmsGetContent).not.toHaveBeenCalled();
  });

  it("opens a create form for a scoped contributor, who now has a desk to create into", async () => {
    // This used to be the "Content studio is outside your current scope" wall, which was
    // the honest answer only while no content carried a desk (#194). A news-scoped
    // contributor can now create into their own desk (#845), so the form is real work and
    // the server decides the save against the section the create names.
    renderRouted(shellFor(contributorPrincipal), ["/content/event/+"]);
    // The create-time desk picker is the proof: the form is offered, and it asks this
    // person which of their desks the record belongs to.
    expect(
      await screen.findByRole("combobox", { name: /^Area/ }, { timeout: 5000 }),
    ).toBeVisible();
    expect(
      screen.queryByText("Content studio is outside your current scope"),
    ).not.toBeInTheDocument();
    // A create addresses no stored document, so nothing is hydrated.
    expect(functionMocks.cmsGetContent).not.toHaveBeenCalled();
  });

  it("keeps the sidebar links on the shared button style contract", () => {
    renderRouted(shellFor(adminPrincipal), ["/dashboard"]);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    // The sidebar CSS targets `.nav-item.button` for the full-width layout, padding, hover, and
    // focus treatment the old Button component supplied. Both the active link and the inactive
    // links have to keep that class or they lose the styling.
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveClass(
      "nav-item",
      "button",
    );
    expect(within(nav).getByRole("link", { name: "Pages" })).toHaveClass(
      "nav-item",
      "button",
    );
    expect(within(nav).getByRole("link", { name: "Posts" })).toHaveClass(
      "nav-item",
      "button",
    );
  });

  it("shows an in-app not-found with a way back for an unknown path", async () => {
    renderRouted(shellFor(adminPrincipal), ["/nowhere"]);
    expect(
      await screen.findByRole("heading", { name: "This page doesn't exist" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Go to newsroom home" }),
    ).toBeInTheDocument();
  });
});

describe("capability-gated routes", () => {
  it("renders site-wide Admin settings for an admin", async () => {
    renderRouted(shellFor(adminPrincipal), ["/admin/settings"]);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Admin settings" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "Public homepage banner" })).toBeVisible();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Newsroom defaults" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Newsroom home banner" }),
    ).toBeInTheDocument();
    expect(functionMocks.cmsGetSettings).toHaveBeenCalledWith(
      "id-token",
      { id: "newsroom-home" },
    );
    expect(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
        "link",
        { name: "Admin settings" },
      ),
    ).toHaveAttribute("aria-current", "page");
  });

  it("redirects an editor off Admin settings without reading them", async () => {
    renderRouted(shellFor(siteWideEditorPrincipal), ["/admin/settings"]);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Admin settings aren't available for your account."),
    ).toBeInTheDocument();
    expect(functionMocks.cmsGetSettings).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("navigation", { name: "Primary" })).queryByRole(
        "link",
        { name: "Admin settings" },
      ),
    ).not.toBeInTheDocument();
  });

  it("renders administrative activity for an admin", async () => {
    renderRouted(shellFor(adminPrincipal), ["/activity"]);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Activity" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("No administrative activity has been recorded."),
    ).toBeInTheDocument();
    expect(functionMocks.cmsListAudit).toHaveBeenCalledWith("id-token");
  });

  it("redirects an editor off administrative activity without reading it", async () => {
    renderRouted(shellFor(siteWideEditorPrincipal), ["/activity"]);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Administrative activity isn't available for your account.",
      ),
    ).toBeInTheDocument();
    expect(functionMocks.cmsListAudit).not.toHaveBeenCalled();
  });

  it("redirects a contributor off staff access to newsroom home with a notice", async () => {
    renderRouted(shellFor(contributorPrincipal), ["/staff-access"]);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Staff access isn't available for your account."),
    ).toBeInTheDocument();
  });

  it("redirects a contributor off the editorial queue to newsroom home with a notice", async () => {
    renderRouted(shellFor(contributorPrincipal), ["/publish-queue"]);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The editorial queue is available to staff who can review content."),
    ).toBeInTheDocument();
  });

  it("renders staff access for a principal that holds the capability", () => {
    renderRouted(shellFor(adminPrincipal), ["/staff-access"]);
    expect(
      screen.getByRole("heading", { level: 1, name: "Staff access" }),
    ).toBeInTheDocument();
  });
});

describe("content layout", () => {
  it("opens the live-page directory when the bare content path is loaded", async () => {
    renderRouted(shellFor(adminPrincipal), ["/content"]);
    expect(
      await screen.findByRole(
        "heading",
        { name: "Site pages" },
        { timeout: 10_000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: "Live site pages" }),
    ).toBeInTheDocument();
  });

  it("keeps page filters on the page directory", async () => {
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content?page_q=donate&page_section=Support"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    expect(
      await screen.findByRole(
        "heading",
        { name: "Site pages" },
        { timeout: 10_000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search pages" })).toHaveValue("donate");
    expect(screen.getByRole("button", { name: /^Support \d+$/ })).toHaveAttribute("aria-pressed", "true");
    expect(router.state.location.pathname).toBe("/content");
    expect(router.state.location.search).toBe("?page_q=donate&page_section=Support");
  });

  it("preserves a saved library query on the addressable library surface", async () => {
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content?q=transit&v=1#saved-view"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    expect(
      await screen.findByRole(
        "heading",
        { name: "All content" },
        { timeout: 10_000 },
      ),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/content/library");
    expect(router.state.location.search).toBe("?q=transit&v=1");
    expect(router.state.location.hash).toBe("#saved-view");
    expect(await screen.findByRole("searchbox", { name: "Search content" })).toHaveValue(
      "transit",
    );
  });

  it("keeps a contributor on the bare path rather than the page directory", async () => {
    // A contributor holds no edit-any grant at any scope, so the canonical page directory
    // is still not theirs and the bare path must not redirect into it. What changed with
    // #845 is only that a section-scoped grant is no longer walled out of content
    // entirely: the page directory refusal is about edit-any, not about scope.
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content"],
    });
    render(
      <ShellProvider value={shellFor(contributorPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    expect(router.state.location.pathname).toBe("/content");
    expect(
      screen.queryByRole("heading", { level: 2, name: "Site pages" }),
    ).not.toBeInTheDocument();
    expect(functionMocks.cmsGetContent).not.toHaveBeenCalled();
  });

  it("keeps an unsaved draft while visiting the combined library", async () => {
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/pages/schedule/edit"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );
    // Edit a seeded Schedule action so the mounted editor holds an in-memory draft.
    await editScheduleWatchLiveLabel("Watch live later");

    // Move to the real library surface. It must not unmount ContentTab/EditorWorkspace, because
    // that shared owner holds the draft map while the person browses for another record.
    await act(async () => {
      await router.navigate("/content/library");
    });

    expect(router.state.location.pathname).toBe("/content/library");
    expect(
      await screen.findByRole("heading", { name: "All content" }),
    ).toBeInTheDocument();

    await act(async () => {
      await router.navigate("/content/pages/schedule/edit");
    });
    expect(
      await screen.findByRole("heading", { name: "Schedule" }),
    ).toBeInTheDocument();
    await expectScheduleWatchLiveLabel("Watch live later");
    expect(screen.queryByText("This page is empty.")).not.toBeInTheDocument();

    await act(async () => { await router.navigate(-1); });
    expect(await screen.findByRole("heading", { name: "All content" })).toBeInTheDocument();
    await act(async () => { await router.navigate(1); });
    expect(await screen.findByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    await expectScheduleWatchLiveLabel("Watch live later");
  });

  it("shows the in-app not-found body for an unresolvable content sub-path", async () => {
    renderRouted(shellFor(adminPrincipal), ["/content/not-a-type/edit"]);
    expect(
      await screen.findByRole("heading", {
        name: "That content page doesn't exist",
      }),
    ).toBeInTheDocument();
  });

  it("moves freely between surfaces inside the subtree while dirty, without a prompt", async () => {
    renderRouted(shellFor(adminPrincipal), ["/content/pages/schedule/edit"]);
    // Edit a Schedule action so the page is dirty, then switch to a record surface. Staying inside
    // the library is allowed while dirty: the mounted editor keeps the draft, so no guard fires.
    await editScheduleWatchLiveLabel("Watch live in library");
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
        "link",
        {
          name: "All content",
        },
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "All content" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Leave with unsaved changes?"),
    ).not.toBeInTheDocument();
  });
});

describe("content records by link (#580/#566)", () => {
  it("updates dirty page blocks and metadata from one header action", async () => {
    let version = 0;
    let storedDocument: Record<string, unknown> = {
      id: "schedule",
      template: "schedule",
      title: "Schedule",
      blocks: [],
    };
    functionMocks.cmsSaveContent.mockImplementation(
      async (_token: string, body: { document: Record<string, unknown> }) => {
        version += 1;
        storedDocument = {
          ...storedDocument,
          ...body.document,
          version,
        };
        return {
          success: true,
          collection: "cmsPages",
          id: "schedule",
          created: version === 1,
          document: storedDocument,
        };
      },
    );

    renderRouted(shellFor(adminPrincipal), ["/content/pages/schedule/edit"]);
    await editScheduleWatchLiveLabel("Watch live tonight");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("tab", { name: "Page" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Page title/ }), {
      target: { value: "Tonight on NJ PBS" },
    });

    const update = screen.getByRole("button", { name: "Save draft" });
    await waitFor(() => expect(update).toBeEnabled());
    expect(update.closest(".workspace-actions")).toBeTruthy();
    fireEvent.click(update);

    await waitFor(() =>
      expect(functionMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );
    const blocksRequest = functionMocks.cmsSaveContent.mock.calls[0]![1];
    const metadataRequest = functionMocks.cmsSaveContent.mock.calls[1]![1];
    expect(JSON.stringify(blocksRequest.document.blocks)).toContain(
      "Watch live tonight",
    );
    expect(metadataRequest.document).toMatchObject({
      title: "Tonight on NJ PBS",
    });
    expect(metadataRequest.baseVersion).toBe(1);
    await waitFor(() =>
      expect(document.querySelector(".success-notice")).toHaveTextContent(
        "Draft saved.",
      ),
    );

    const nav = screen.getByRole("navigation", { name: "Primary" });
    fireEvent.click(within(nav).getByRole("link", { name: "Pages" }));
    await screen.findByRole("heading", { name: "Site pages" });
    fireEvent.click(
      screen.getByRole("link", { name: "Edit page draft: Schedule" }),
    );
    await screen.findByRole("heading", { name: "Schedule" });
    expect(screen.queryByText("Draft saved.")).not.toBeInTheDocument();
  });

  it("keeps the second write of one Update guarded on a page that loaded without a version", async () => {
    // The first request explicitly claims the legacy document with zero. The second
    // must claim the receipt from that same Update, so a writer in the gap causes a
    // conflict instead of silently replacing its metadata.
    let stored: Record<string, unknown> = {
      id: "schedule",
      template: "programLanding",
      title: "Schedule",
      status: "draft",
      blocks: pageCompositionSeed("schedule")!.blocks,
      // No `version`: this document was written before the field existed.
    };
    functionMocks.cmsGetContent.mockResolvedValue({
      success: true,
      found: true,
      document: stored,
    });

    let saves = 0;
    let storedVersion: number | undefined;
    functionMocks.cmsSaveContent.mockImplementation(
      async (
        _token: string,
        body: { document: Record<string, unknown>; baseVersion?: number },
      ) => {
        saves += 1;
        if (body.baseVersion === undefined) {
          throw Object.assign(new Error("An existing save requires its exact version."), { status: 400 });
        }
        if (body.baseVersion === 0 ? storedVersion !== undefined : body.baseVersion !== storedVersion) {
          throw Object.assign(new Error("This document changed since you opened it."), { status: 409 });
        }
        storedVersion = (storedVersion ?? 0) + 1;
        stored = { ...stored, ...body.document, version: storedVersion };
        const receipt = {
          success: true,
          collection: "cmsPages",
          id: "schedule",
          created: false,
          document: stored,
        };
        if (saves === 1) {
          // Another writer lands after the version-one receipt and before metadata.
          storedVersion = 2;
          stored = { ...stored, version: 2, title: "Their title" };
        }
        return receipt;
      },
    );

    renderRouted(shellFor(adminPrincipal), ["/content/pages/schedule/edit"]);
    await editScheduleWatchLiveLabel("Watch live tonight");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("tab", { name: "Page" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Page title/ }), {
      target: { value: "Tonight on NJ PBS" },
    });

    const update = screen.getByRole("button", { name: "Save draft" });
    await waitFor(() => expect(update).toBeEnabled());
    fireEvent.click(update);

    await waitFor(() =>
      expect(functionMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );
    const blocksRequest = functionMocks.cmsSaveContent.mock.calls[0]![1];
    const metadataRequest = functionMocks.cmsSaveContent.mock.calls[1]![1];
    expect(blocksRequest.baseVersion).toBe(0);
    expect(metadataRequest.baseVersion).toBe(1);
    expect(stored).toMatchObject({ version: 2, title: "Their title" });
    expect(
      await screen.findByText("Save did not finish. Review Page metadata."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Draft saved.")).not.toBeInTheDocument();
  }, 20000);

  it("opens the blank create form at a record create URL", async () => {
    renderRouted(shellFor(adminPrincipal), ["/content/event/+"]);
    // The create surface (id null) keeps today's behavior: the blank record form to compose a new
    // record, with a save control.
    expect(await screen.findByLabelText(/^Location/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Save draft" })
          .closest(".workspace-actions"),
      ).toBeTruthy(),
    );
  });

  it("replaces a successful create URL with the server-minted record address", async () => {
    functionMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPosts",
      id: "spo-1",
      created: true,
      document: {
        id: "spo-1",
        type: "sponsor",
        version: 1,
        name: "WNET",
        href: "https://www.wnet.org",
      },
    });
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/sponsor/+"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );
    fireEvent.change(await screen.findByLabelText(/^Name/), {
      target: { value: "WNET" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://www.wnet.org" },
    });
    // A record create names the desk it is created into (#845); the picker is required.
    fireEvent.change(screen.getByRole("combobox", { name: /^Area/ }), {
      target: { value: "watch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        "/content/sponsor/spo-1/edit",
      );
    });
    await waitFor(() =>
      expect(document.querySelector(".success-notice")).toHaveTextContent(
        "Draft saved.",
      ),
    );
    expect(functionMocks.cmsSaveContent).toHaveBeenCalledTimes(1);
  });

  it("does not canonicalize a create URL over an edit typed while the save is in flight", async () => {
    let resolveSave: (value: unknown) => void = () => {};
    functionMocks.cmsSaveContent.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/sponsor/+"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );
    const name = await screen.findByLabelText(/^Name/);
    fireEvent.change(name, { target: { value: "WNET" } });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://www.wnet.org" },
    });
    // A record create names the desk it is created into (#845); the picker is required.
    fireEvent.change(screen.getByRole("combobox", { name: /^Area/ }), {
      target: { value: "watch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("button", { name: /^.+: Saving…$/ });
    fireEvent.change(name, { target: { value: "WNET updated locally" } });

    await act(async () => {
      resolveSave({
        success: true,
        collection: "cmsPosts",
        id: "spo-1",
        created: true,
        document: {
          id: "spo-1",
          type: "sponsor",
          version: 1,
          name: "WNET",
          href: "https://www.wnet.org",
        },
      });
    });

    expect(router.state.location.pathname).toBe("/content/sponsor/+");
    expect(
      screen.getByDisplayValue("WNET updated locally"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Draft saved.")).not.toBeInTheDocument();
  });

  it("shows a safe not-found state at an absent edit-by-id URL, with no create form and no save", async () => {
    renderRouted(shellFor(adminPrincipal), ["/content/event/evt-123/edit"]);
    // An absent record must not fall through to the blank create form: saving that form would
    // send no id and mint a duplicate instead of editing the addressed record.
    expect(
      await screen.findByText("This event could not be found"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Location/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Save/ }),
    ).not.toBeInTheDocument();
    // Two honest ways forward, both real links: start a new record of this kind, or go back to its
    // browse surface.
    expect(
      screen.getByRole("link", { name: /Create a new event/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to event list" }),
    ).toHaveAttribute("href", "/content/event");
  });

  it("does not share a create draft with an edit-by-id surface of the same kind", async () => {
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/event/+"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );
    // Start a draft on the create surface (keyed to /content/event/+).
    fireEvent.change(await screen.findByLabelText(/^Location/), {
      target: { value: "Draft in progress" },
    });

    // Visiting the edit-by-id surface for the same kind shows the safe missing state, never the
    // create draft, and offers no form to save.
    await act(async () => {
      await router.navigate("/content/event/evt-123/edit");
    });
    expect(
      await screen.findByText("This event could not be found"),
    ).toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("Draft in progress"),
    ).not.toBeInTheDocument();

    // Returning to the create surface still holds the draft: the two surfaces key separately, so a
    // create-post draft and an edit-post-123 visit never share state.
    await act(async () => {
      await router.navigate("/content/event/+");
    });
    expect(
      await screen.findByDisplayValue("Draft in progress"),
    ).toBeInTheDocument();
  });
});

describe("navigation protection", () => {
  it("keeps list lifecycle actions disabled while the full editor retains a draft", async () => {
    functionMocks.cmsListContent.mockResolvedValue({
      success: true,
      records: [
        {
          id: "post-1",
          kind: "post",
          title: "Published station update",
          status: "published",
          updatedAt: "2026-09-01T12:00:00.000Z",
        },
      ],
      total: 1,
      allCount: 1,
      mineCount: 0,
      assignedCount: 0,
      page: 1,
      pageCount: 1,
      statusCounts: {
        draft: 0,
        in_review: 0,
        scheduled: 0,
        published: 1,
        archived: 0,
      },
    });
    const quickActions: ContentQuickActionsApi = {
      principal: adminPrincipal,
      loadPage: vi.fn(async () => null),
      savePageMetadata: vi.fn(async () => ({})),
      loadRecord: vi.fn(async () => ({
        id: "post-1",
        type: "post",
        title: "Published station update",
        summary: "Original summary.",
        status: "published",
        section: "station",
        createdBy: "admin",
        version: 7,
      })),
      saveRecordMetadata: vi.fn(async () => ({})),
      transition: vi.fn(async () => ({})),
    };
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/post/+"],
    });
    render(
      <ContentQuickActionsBoundary value={quickActions}>
        <ShellProvider value={shellFor(adminPrincipal)}>
          <RouterProvider router={router} />
        </ShellProvider>
      </ContentQuickActionsBoundary>,
    );

    fireEvent.change(
      await screen.findByRole(
        "textbox",
        { name: "Headline" },
        { timeout: 10_000 },
      ),
      { target: { value: "Retained full-editor draft" } },
    );
    await act(async () => {
      await router.navigate("/content/post");
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Show details for Published station update",
      }),
    );

    expect(
      await screen.findByText(
        "Save or discard the full editor draft before changing status here.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Unpublish" }),
    ).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Title" })).toBeEnabled();
    expect(quickActions.transition).not.toHaveBeenCalled();
  });

  it("warns before browser unload while a quick lifecycle request is active", async () => {
    functionMocks.cmsListContent.mockResolvedValue({
      success: true,
      records: [
        {
          id: "post-1",
          kind: "post",
          title: "Published station update",
          status: "published",
          updatedAt: "2026-09-01T12:00:00.000Z",
        },
      ],
      total: 1,
      allCount: 1,
      mineCount: 0,
      assignedCount: 0,
      page: 1,
      pageCount: 1,
      statusCounts: {
        draft: 0,
        in_review: 0,
        scheduled: 0,
        published: 1,
        archived: 0,
      },
    });
    let finishTransition: (document: Record<string, unknown>) => void = () => {};
    const quickActions: ContentQuickActionsApi = {
      principal: adminPrincipal,
      loadPage: vi.fn(async () => null),
      savePageMetadata: vi.fn(async () => ({})),
      loadRecord: vi.fn(async () => ({
        id: "post-1",
        type: "post",
        title: "Published station update",
        summary: "Original summary.",
        status: "published",
        section: "station",
        createdBy: "admin",
        version: 7,
      })),
      saveRecordMetadata: vi.fn(async () => ({})),
      transition: vi.fn(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            finishTransition = resolve;
          }),
      ),
    };
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/post"],
    });
    render(
      <ContentQuickActionsBoundary value={quickActions}>
        <ShellProvider value={shellFor(adminPrincipal)}>
          <RouterProvider router={router} />
        </ShellProvider>
      </ContentQuickActionsBoundary>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Show details for Published station update",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Unpublish" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm unpublish" }));
    await screen.findByRole("button", { name: /^.+: Changing…$/ });

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await act(async () => {
      finishTransition({
        id: "post-1",
        type: "post",
        title: "Published station update",
        status: "draft",
        version: 8,
      });
    });
  });

  it("retains a contributor's dirty record while browsing their page directory", async () => {
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/event/+"],
    });
    render(
      <ShellProvider value={shellFor(siteWideContributorPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );
    fireEvent.change(
      await screen.findByLabelText(/^Location/, {}, { timeout: 10_000 }),
      { target: { value: "Contributor draft" } },
    );

    await act(async () => { await router.navigate("/content"); });
    expect(await screen.findByRole("table", { name: "Live site pages" })).toBeInTheDocument();
    expect(screen.queryByText("Leave with unsaved changes?")).not.toBeInTheDocument();
    await act(async () => { await router.navigate("/content/event/+"); });
    expect(await screen.findByDisplayValue("Contributor draft")).toBeInTheDocument();
  });

  it("holds a leave to another section while a page save is in flight and releases it after", async () => {
    let resolveSave: () => void = () => {};
    functionMocks.cmsSaveContent.mockImplementation(
      (_token: string, body: { document: { blocks: unknown[] } }) =>
        new Promise((resolve) => {
          resolveSave = () =>
            resolve({
              success: true,
              collection: "cmsPages",
              id: "schedule",
              created: true,
              document: { id: "schedule", blocks: body.document.blocks },
            });
        }),
    );

    renderRouted(shellFor(adminPrincipal), ["/content/pages/schedule/edit"]);
    await editScheduleWatchLiveLabel("Watch live after save");
    const actions = document.querySelector(".workspace-actions");
    expect(actions).toBeTruthy();
    const savePage = within(actions as HTMLElement).getByRole("button", { name: "Save draft" });
    await waitFor(() => expect(savePage).toBeEnabled());
    expect(savePage.closest(".workspace-actions")).toBeTruthy();
    fireEvent.click(savePage);
    const updating = await within(actions as HTMLElement).findByRole("button", { name: /^.+: Saving…$/ });
    expect(updating).toHaveAttribute("aria-busy", "true");
    expect(updating.querySelector(".activity-indicator")).toBeInTheDocument();
    expect(screen.getByText("Saving draft.")).toHaveAttribute("role", "status");

    // The save is in flight: leaving the content subtree is held, so the editor stays mounted to
    // keep the in-flight save's owner. The click does not navigate.
    const nav = screen.getByRole("navigation", { name: "Primary" });
    fireEvent.click(within(nav).getByRole("link", { name: "Home" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Schedule" }),
    ).toBeInTheDocument();
    expect(
      within(actions as HTMLElement).getByRole("button", { name: /^.+: Saving…$/ }),
    ).toBeInTheDocument();

    // Once the save settles, the hold releases; a fresh click navigates.
    await act(async () => {
      resolveSave();
    });
    await waitFor(() =>
      expect(document.querySelector(".success-notice")).toHaveTextContent(
        "Draft saved.",
      ),
    );
    fireEvent.click(within(nav).getByRole("link", { name: "Home" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
  });

  it("holds query-only browser history while a mutation is in flight", async () => {
    let resolveSave: () => void = () => {};
    functionMocks.cmsSaveContent.mockImplementation(
      (_token: string, body: { document: { blocks: unknown[] } }) =>
        new Promise((resolve) => {
          resolveSave = () =>
            resolve({
              success: true,
              collection: "cmsPages",
              id: "schedule",
              created: true,
              document: { id: "schedule", blocks: body.document.blocks },
            });
        }),
    );
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: [
        "/content/pages/schedule/edit?before=1",
        "/content/pages/schedule/edit?current=1",
      ],
      initialIndex: 1,
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    await editScheduleWatchLiveLabel("Watch live after history");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("button", { name: /^.+: Saving…$/ });

    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.search).toBe("?current=1");

    await act(async () => {
      resolveSave();
    });
    await waitFor(() =>
      expect(document.querySelector(".success-notice")).toHaveTextContent(
        "Draft saved.",
      ),
    );
    expect(router.state.location.search).toBe("?current=1");

    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.search).toBe("?before=1");
  });

  it("drops a save-held navigation when the save fails instead of offering to discard", async () => {
    // A click made while a save is in flight is a save-hold, and a save-hold is silent: it becomes a
    // no-op once the save settles, matching the pre-routing behavior where the nav was disabled.
    // That has to hold when the save fails too, and the failure path is where it is load-bearing.
    // The work is still unsaved, so dirty stays true, and a guard that reads the block's reason off
    // current state cannot tell that block apart from a fresh dirty leave. It then offers to discard
    // the exact work whose save just failed, on the strength of a click the person made before they
    // knew the save would fail.
    let rejectSave: (error: Error) => void = () => {};
    functionMocks.cmsSaveContent.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject;
        }),
    );

    renderRouted(shellFor(adminPrincipal), ["/content/pages/schedule/edit"]);
    await editScheduleWatchLiveLabel("Watch live after failure");
    const savePage = screen.getByRole("button", { name: "Save draft" });
    await waitFor(() => expect(savePage).toBeEnabled());
    fireEvent.click(savePage);
    await screen.findByRole("button", { name: /^.+: Saving…$/ });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    fireEvent.click(within(nav).getByRole("link", { name: "Home" }));

    await act(async () => {
      rejectSave(new Error("network down"));
    });

    expect(
      screen.queryByText("Leave with unsaved changes?"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Schedule" }),
    ).toBeInTheDocument();
  });

  it("lets an edit that was undone back to the loaded page leave without a prompt", async () => {
    // The guard's credibility is the whole point of it. An edit taken back before leaving is not
    // unsaved work, and a guard that stops someone anyway teaches them the question is noise —
    // which is exactly the habit that costs real work the one time the question is real. #595 knows
    // a reverted draft is clean; the dirty signal that arms this guard has to know it too.
    renderRouted(shellFor(adminPrincipal), ["/content/pages/schedule/edit"]);
    await editScheduleWatchLiveLabel("Watch live undone");
    fireEvent.click(
      within(
        screen.getByRole("toolbar", { name: "Page editing commands" }),
      ).getByRole("button", { name: "Undo" }),
    );

    const nav = screen.getByRole("navigation", { name: "Primary" });
    fireEvent.click(within(nav).getByRole("link", { name: "Home" }));

    await screen.findByRole("heading", { level: 1, name: "Home" });
    expect(
      screen.queryByText("Leave with unsaved changes?"),
    ).not.toBeInTheDocument();
  });

  it("prompts before leaving the content subtree dirty and can keep editing or discard", async () => {
    renderRouted(shellFor(adminPrincipal), ["/content/pages/schedule/edit"]);
    await editScheduleWatchLiveLabel("Watch live with guard");

    const nav = screen.getByRole("navigation", { name: "Primary" });
    // Leaving the subtree while dirty raises the guard rather than navigating.
    fireEvent.click(within(nav).getByRole("link", { name: "Home" }));
    expect(
      await screen.findByText("Leave with unsaved changes?"),
    ).toBeInTheDocument();

    // Keep editing dismisses the guard and stays put.
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Leave with unsaved changes?"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Schedule" }),
    ).toBeInTheDocument();

    // Asking again and discarding proceeds to the destination.
    fireEvent.click(within(nav).getByRole("link", { name: "Home" }));
    expect(
      await screen.findByText("Leave with unsaved changes?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
  });

  it("prompts before a dirty leave to an invalid content path reached with Back, and keeps the draft on cancel", async () => {
    // Reviewer repro: a bad /content/... URL sits in history, the user clicks Go to content, edits,
    // then presses Back. The destination stays under /content but resolves to not-found, which would
    // unmount the editor and silently drop the draft. It has to raise the leave guard instead, so a
    // /content destination only bypasses the prompt when it actually keeps the editor mounted.
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/not-a-type/edit"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    // The bad content URL renders the in-app not-found with a way back into the editor.
    expect(
      await screen.findByRole("heading", {
        name: "That content page doesn't exist",
      }),
    ).toBeInTheDocument();

    // Go to pages lands on the live-page directory. Replace that entry with the Schedule editor so
    // Back still targets the original malformed path, then make the editor dirty.
    fireEvent.click(screen.getByRole("button", { name: "Go to pages" }));
    expect(
      await screen.findByRole("heading", { name: "Site pages" }),
    ).toBeInTheDocument();
    await act(async () => {
      await router.navigate("/content/pages/schedule/edit", { replace: true });
    });
    expect(
      await screen.findByRole("heading", { name: "Schedule" }),
    ).toBeInTheDocument();

    // Edit a seeded Schedule action so the page holds an in-memory draft.
    await editScheduleWatchLiveLabel("Watch live after back");

    // Press Back. History returns to the invalid content URL; the guard must fire rather than let
    // the editor unmount and drop the draft.
    await act(async () => {
      void router.navigate(-1);
    });
    expect(
      await screen.findByText("Leave with unsaved changes?"),
    ).toBeInTheDocument();

    // Keep editing cancels the leave: the editor stays mounted at the Schedule page with its draft, and
    // the URL never moves to the bad path.
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Leave with unsaved changes?"),
      ).not.toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe("/content/pages/schedule/edit");
    expect(
      screen.getByRole("heading", { name: "Schedule" }),
    ).toBeInTheDocument();
    await expectScheduleWatchLiveLabel("Watch live after back");
  });

  it("does not prompt when a dirty editor moves to the reusable-content library", async () => {
    // The /content/library route is a real surface in the persistent workspace, so moving to it while
    // dirty is staying in the editor subtree: no guard, and the draft remains available on return.
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/pages/schedule/edit"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );
    await editScheduleWatchLiveLabel("Watch live after library");

    await act(async () => {
      await router.navigate("/content/library");
    });

    expect(
      screen.queryByText("Leave with unsaved changes?"),
    ).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/content/library");
    expect(
      await screen.findByRole("heading", { name: "All content" }),
    ).toBeInTheDocument();

    await act(async () => {
      await router.navigate("/content/pages/schedule/edit");
    });
    await expectScheduleWatchLiveLabel("Watch live after library");
  });
});

// One dirty-state contract for every exit (#1032). Internal navigation and Back were already
// held by the layout's blocker, and a browser unload by the platform prompt; sign-out went
// around both. These cover that matrix against the editors staff actually use, and both halves
// of the decision the guard now offers: leave the work behind, or save it first and wait for the
// server's real answer before the exit happens.
describe("editor exit contract", () => {
  function openSignOut() {
    fireEvent.click(
      screen.getByRole("button", { name: "Account menu for Test User" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
  }

  it("signs out immediately when the editor holds no unsaved work", async () => {
    const signOut = vi.fn();
    renderRouted(shellFor(adminPrincipal, { signOut }), [
      "/content/pages/schedule/edit",
    ]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Schedule actions" })).toBeEnabled(), { timeout: 10_000 });

    openSignOut();

    expect(
      screen.queryByText("Leave with unsaved changes?"),
    ).not.toBeInTheDocument();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("asks before signing out of a dirty page editor and keeps the session on Keep editing", async () => {
    const signOut = vi.fn();
    renderRouted(shellFor(adminPrincipal, { signOut }), [
      "/content/pages/schedule/edit",
    ]);
    await editScheduleWatchLiveLabel("Watch live before sign-out");

    openSignOut();

    expect(
      await screen.findByText("Leave with unsaved changes?"),
    ).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Leave with unsaved changes?"),
      ).not.toBeInTheDocument(),
    );
    expect(signOut).not.toHaveBeenCalled();
    await expectScheduleWatchLiveLabel("Watch live before sign-out");
  });

  it("signs out of a dirty page editor after Discard and leave", async () => {
    const signOut = vi.fn();
    renderRouted(shellFor(adminPrincipal, { signOut }), [
      "/content/pages/schedule/edit",
    ]);
    await editScheduleWatchLiveLabel("Watch live discarded");

    openSignOut();
    fireEvent.click(
      await screen.findByRole("button", { name: "Discard and leave" }),
    );

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("asks before signing out of a dirty post editor too", async () => {
    const signOut = vi.fn();
    renderRouted(shellFor(adminPrincipal, { signOut }), ["/content/post/+"]);
    fireEvent.change(
      await screen.findByRole(
        "textbox",
        { name: "Headline" },
        { timeout: 10_000 },
      ),
      { target: { value: "Post draft before sign-out" } },
    );

    openSignOut();

    expect(
      await screen.findByText("Leave with unsaved changes?"),
    ).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("waits for the server save before signing out, and stays put when it fails", async () => {
    let settleSave: (outcome: { ok: boolean }) => void = () => {};
    functionMocks.cmsSaveContent.mockImplementation(
      (_token: string, body: { document: { blocks: unknown[] } }) =>
        new Promise((resolve, reject) => {
          settleSave = (outcome) =>
            outcome.ok
              ? resolve({
                  success: true,
                  collection: "cmsPages",
                  id: "schedule",
                  created: true,
                  document: { id: "schedule", blocks: body.document.blocks },
                  mintedIds: {},
                })
              : reject(new Error("network down"));
        }),
    );

    const signOut = vi.fn();
    renderRouted(shellFor(adminPrincipal, { signOut }), [
      "/content/pages/schedule/edit",
    ]);
    await editScheduleWatchLiveLabel("Watch live saved on exit");

    openSignOut();
    fireEvent.click(
      await screen.findByRole("button", { name: "Save and leave" }),
    );

    // The save is in flight: nothing has left yet, whatever the click was for.
    await waitFor(() => expect(functionMocks.cmsSaveContent).toHaveBeenCalled());
    expect(signOut).not.toHaveBeenCalled();

    // A failed save is not an instruction to leave. The prompt stays, with the work intact.
    await act(async () => {
      settleSave({ ok: false });
    });
    expect(signOut).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "The save didn’t finish, so nothing was left behind. Check the editor and try again.",
      ),
    ).toBeInTheDocument();

    // Retrying reaches the server again; only the save that lands ends the session.
    fireEvent.click(screen.getByRole("button", { name: "Save and leave" }));
    await waitFor(() =>
      expect(functionMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      settleSave({ ok: true });
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  }, 20_000);

  it("offers Save and leave on an internal navigation and proceeds once the save lands", async () => {
    configure({ asyncUtilTimeout: 10_000 });
    try {
      functionMocks.cmsSaveContent.mockImplementation(
        async (_token: string, body: { document: { blocks: unknown[] } }) => ({
          success: true,
          collection: "cmsPages",
          id: "schedule",
          created: true,
          document: { id: "schedule", blocks: body.document.blocks },
          mintedIds: {},
        }),
      );
      renderRouted(shellFor(adminPrincipal), ["/content/pages/schedule/edit"]);
      await editScheduleWatchLiveLabel("Watch live saved on leave");

      const nav = screen.getByRole("navigation", { name: "Primary" });
      fireEvent.click(within(nav).getByRole("link", { name: "Home" }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save and leave" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save and leave" }));
      await waitFor(() => expect(functionMocks.cmsSaveContent).toHaveBeenCalled());
      expect(
        await screen.findByRole("heading", { level: 1, name: "Home" }),
      ).toBeInTheDocument();
    } finally {
      configure({ asyncUtilTimeout: 5_000 }); // the default from tests/setup.ts
    }
  }, 30_000);

  it("does not ask when the exit starts outside the editor", async () => {
    const signOut = vi.fn();
    renderRouted(shellFor(adminPrincipal, { signOut }), ["/activity"]);
    await screen.findByRole("heading", { level: 1, name: "Activity" });

    openSignOut();

    expect(
      screen.queryByText("Leave with unsaved changes?"),
    ).not.toBeInTheDocument();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("refuses to report a save while another surface in this session is still unsaved", async () => {
    // The workspace keeps a draft per surface, so moving between editors inside /content/**
    // preserves work rather than losing it. Only the mounted surface has an editor to save
    // through, so "Save and leave" can commit that one and no more. Reporting success anyway
    // would discard the other draft on the exit the person chose precisely to keep their work.
    functionMocks.cmsSaveContent.mockImplementation(
      async (_token: string, body: { document: Record<string, unknown> }) => ({
        success: true,
        collection: "cmsPages",
        id: "schedule",
        created: true,
        document: { id: "schedule", ...body.document },
        mintedIds: {},
      }),
    );
    const signOut = vi.fn();
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/event/+"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal, { signOut })}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    fireEvent.change(
      await screen.findByLabelText(/^Location/, {}, { timeout: 10_000 }),
      { target: { value: "Event left unsaved" } },
    );

    // Moving to another editor surface keeps that draft; this is the retained-work contract.
    await act(async () => {
      await router.navigate("/content/pages/schedule/edit");
    });
    await editScheduleWatchLiveLabel("Watch live saved on exit");

    openSignOut();
    fireEvent.click(
      await screen.findByRole("button", { name: "Save and leave" }),
    );

    // The page saved, the record did not, so the session does not end and the prompt names the
    // work that is still only in the browser.
    await waitFor(() => expect(functionMocks.cmsSaveContent).toHaveBeenCalled());
    expect(
      await screen.findByText(
        "Event still has unsaved changes. Open it to save that work, or discard it and leave.",
      ),
    ).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();

    // Discarding is still available for someone who means it.
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  }, 30_000);

  it("holds a media sign-out while a metadata save is in flight", async () => {
    // The same held-exit rule the editor uses. A metadata save cannot be called back once it is
    // sent, so offering Discard mid-flight would let someone believe they had abandoned a change
    // that is already on its way to the server.
    functionMocks.cmsListMedia.mockResolvedValue({
      success: true,
      records: [mediaAsset],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    });
    let settleUpdate: () => void = () => {};
    functionMocks.cmsUpdateMediaMetadata.mockReturnValue(
      new Promise((resolve) => {
        settleUpdate = () =>
          resolve({
            success: true,
            changed: true,
            asset: { ...mediaAsset, name: "Renamed room", version: 3 },
          });
      }),
    );

    const signOut = vi.fn();
    renderRouted(shellFor(adminPrincipal, { signOut }), ["/media"]);
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: /^Studio control room/ },
        { timeout: 10_000 },
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Renamed room" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() =>
      expect(functionMocks.cmsUpdateMediaMetadata).toHaveBeenCalled(),
    );

    openSignOut();

    // Held, not asked: there is nothing honest to offer while the write is in flight.
    expect(
      screen.queryByText("Leave with unsaved changes?"),
    ).not.toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();

    // Once the save lands there is no unsaved work left, so the held exit simply completes.
    await act(async () => {
      settleUpdate();
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  }, 30_000);

  it("asks before signing out of an open media upload, which has no save to offer", async () => {
    const signOut = vi.fn();
    renderRouted(shellFor(adminPrincipal, { signOut }), ["/media"]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }, { timeout: 10_000 }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Unsaved upload" },
    });

    openSignOut();

    expect(
      await screen.findByText("Leave with unsaved changes?"),
    ).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
    // The upload form owns its own commit, so this exit offers the two answers it can honor.
    expect(
      screen.queryByRole("button", { name: "Save and leave" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Leave with unsaved changes?"),
      ).not.toBeInTheDocument(),
    );
    expect(signOut).not.toHaveBeenCalled();
    // Opening the account menu hides the upload panel without discarding its draft.
    expect(screen.queryByRole("complementary", { name: "Upload media" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue upload (0)" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Unsaved upload",
    );
  });

  it("forgets this tab's remembered destination when the session ends", async () => {
    const signOut = vi.fn();
    renderRouted(shellFor(adminPrincipal, { signOut }), ["/activity"]);
    await screen.findByRole("heading", { level: 1, name: "Activity" });
    await waitFor(() =>
      expect(sessionStorage.getItem("njpbs.admin.destination")).toContain(
        "/activity",
      ),
    );

    openSignOut();

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem("njpbs.admin.destination")).toBeNull();
  });
});

// #1037: one visible way out of an open editor, and a rail that owns its own collapse control.
describe("editor Back action and the primary rail", () => {
  it("clears the Home hero selection when returning to another Page editor", async () => {
    functionMocks.cmsGetContent.mockImplementation(async (_token, request) => ({
      success: true, found: true,
      document: { id: request.id, template: request.id === "home" ? "home" : "programLanding",
        title: request.id === "home" ? "Homepage" : "Schedule", blocks: [], status: "draft", version: 2, createdBy: "user" },
    }));
    const router = createMemoryRouter(buildRoutes(), { initialEntries: ["/content/pages/schedule/edit"] });
    const { container } = render(<ShellProvider value={shellFor(adminPrincipal)}><RouterProvider router={router} /></ShellProvider>);
    await screen.findByRole("link", { name: "Back to pages" }, { timeout: 10_000 });
    await act(async () => { await router.navigate("/content/pages/home/edit"); });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Home hero" }, { timeout: 10_000 }));
    await waitFor(() => expect(container.querySelector(".editor-selection-path")).toHaveTextContent("Home hero"));
    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/content/pages/schedule/edit"));
    await waitFor(() => expect(container.querySelector(".editor-selection-path")).not.toHaveTextContent("Home hero"));
    expect(container.querySelector(".editor-selection-details")).not.toHaveTextContent("Home hero");
    expect(functionMocks.cmsSaveContent).not.toHaveBeenCalled();
  }, 30_000);

  it("offers a page editor a Back action to the page directory", async () => {
    functionMocks.cmsGetContent.mockResolvedValue({
      success: true,
      found: true,
      document: {
        id: "schedule",
        template: "programLanding",
        title: "Schedule",
        blocks: [],
        status: "draft",
        version: 2,
        createdBy: "user",
      },
    });
    renderRouted(shellFor(adminPrincipal), ["/content/pages/schedule/edit"]);

    expect(
      await screen.findByRole(
        "link",
        { name: "Back to pages" },
        { timeout: 10_000 },
      ),
    ).toHaveAttribute("href", "/content");
  });

  it("offers a post editor a Back action to its own list on a direct link", async () => {
    functionMocks.cmsGetContent.mockResolvedValue({
      success: true,
      found: true,
      document: {
        id: "post-1",
        type: "post",
        title: "Garden State update",
        date: "2026-08-14",
        tags: [],
        blocks: [],
        status: "draft",
        version: 2,
        createdBy: "user",
      },
    });
    renderRouted(shellFor(adminPrincipal), ["/content/post/post-1/edit"]);

    expect(
      await screen.findByRole(
        "link",
        { name: "Back to posts list" },
        { timeout: 10_000 },
      ),
    ).toHaveAttribute("href", "/content/post");
    expect(screen.getByRole("link", { name: "Back to posts list" })).toHaveTextContent("Posts");
  });

  it("retries one Post duplicate request and opens the saved draft", async () => {
    const source = {
      id: "post-1",
      type: "post",
      title: "Garden State update",
      tags: [],
      blocks: [],
      status: "draft",
      version: 2,
      createdBy: "user",
    };
    const duplicate = {
      ...source,
      id: "post-copy",
      title: "Copy of Garden State update",
      version: 1,
    };
    functionMocks.cmsGetContent.mockImplementation(async (_token, request) => ({
      success: true,
      found: true,
      document: request.id === "post-copy" ? duplicate : source,
    }));
    functionMocks.cmsSaveContent
      .mockRejectedValueOnce(new Error("The response was interrupted."))
      .mockResolvedValueOnce({
        success: true,
        collection: "cmsPosts",
        id: "post-copy",
        created: true,
        replayed: true,
        mintedIds: {},
        document: duplicate,
      });
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/post/post-1/edit"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    await screen.findByRole("textbox", { name: "Headline" }, { timeout: 10_000 });
    fireEvent.click(await screen.findByRole("button", { name: "More document actions" }, { timeout: 10_000 }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate post" }));
    expect(await screen.findByText("The response was interrupted.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More document actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate post" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/content/post/post-copy/edit"));
    expect(functionMocks.cmsSaveContent).toHaveBeenCalledTimes(2);
    const firstRequest = functionMocks.cmsSaveContent.mock.calls[0]![1];
    const retryRequest = functionMocks.cmsSaveContent.mock.calls[1]![1];
    expect(firstRequest).toMatchObject({
      collection: "cmsPosts",
      document: { type: "post" },
      postSource: { id: "post-1", version: 2 },
    });
    expect(retryRequest.idempotencyKey).toBe(firstRequest.idempotencyKey);
  }, 30_000);

  it("mints a new Post duplicate request after an advanced replay conflict", async () => {
    const source = {
      id: "post-1",
      type: "post",
      title: "Garden State update",
      tags: [],
      blocks: [],
      status: "draft",
      version: 2,
      createdBy: "user",
    };
    const duplicate = {
      ...source,
      id: "post-copy-2",
      title: "Copy of Garden State update",
      version: 1,
    };
    const advancedReplay = Object.assign(
      new Error("This record changed after it was created. Reload before saving it again."),
      {
        status: 409,
        data: {
          conflict: "create-replay-advanced",
          recordId: "post-copy",
        },
      },
    );
    functionMocks.cmsGetContent.mockImplementation(async (_token, request) => ({
      success: true,
      found: true,
      document: request.id === "post-copy-2" ? duplicate : source,
    }));
    functionMocks.cmsSaveContent
      .mockRejectedValueOnce(new Error("The response was interrupted."))
      .mockRejectedValueOnce(advancedReplay)
      .mockResolvedValueOnce({
        success: true,
        collection: "cmsPosts",
        id: "post-copy-2",
        created: true,
        replayed: false,
        mintedIds: {},
        document: duplicate,
      });
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/post/post-1/edit"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    await screen.findByRole("textbox", { name: "Headline" }, { timeout: 10_000 });
    fireEvent.click(await screen.findByRole("button", { name: "More document actions" }, { timeout: 10_000 }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate post" }));
    expect(await screen.findByText("The response was interrupted.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More document actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate post" }));
    expect(await screen.findByText(
      "The earlier duplicate was already created and later edited. Select Duplicate post again to make another copy.",
    )).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More document actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate post" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/content/post/post-copy-2/edit"));
    expect(functionMocks.cmsSaveContent).toHaveBeenCalledTimes(3);
    const firstRequest = functionMocks.cmsSaveContent.mock.calls[0]![1];
    const replayRequest = functionMocks.cmsSaveContent.mock.calls[1]![1];
    const newRequest = functionMocks.cmsSaveContent.mock.calls[2]![1];
    expect(replayRequest.idempotencyKey).toBe(firstRequest.idempotencyKey);
    expect(newRequest.idempotencyKey).not.toBe(firstRequest.idempotencyKey);
  }, 30_000);

  it("offers a Back action on a create surface too", async () => {
    renderRouted(shellFor(adminPrincipal), ["/content/post/+"]);

    expect(
      await screen.findByRole(
        "link",
        { name: "Back to posts list" },
        { timeout: 10_000 },
      ),
    ).toHaveAttribute("href", "/content/post");
  });

  it("returns a post editor to the filtered library it was opened from", async () => {
    functionMocks.cmsGetContent.mockResolvedValue({
      success: true,
      found: true,
      document: {
        id: "post-1",
        type: "post",
        title: "Garden State update",
        date: "2026-08-14",
        tags: [],
        blocks: [],
        status: "draft",
        version: 2,
        createdBy: "user",
      },
    });
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/library?status=draft"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );
    await screen.findByRole("heading", { name: "All content" });

    await act(async () => {
      await router.navigate("/content/post/post-1/edit", {
        state: { from: "/content/library?status=draft" },
      });
    });

    const back = await screen.findByRole("link", {
      name: "Back to All content",
    });
    expect(back).toHaveAttribute("href", "/content/library?status=draft");

    // Back is a router link, so it rides the same navigation guard as every other exit.
    fireEvent.click(back);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/content/library"),
    );
    expect(router.state.location.search).toBe("?status=draft");
  });

  it("carries the originating list onto the editor a list link opens", async () => {
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    fireEvent.click(
      await screen.findByRole(
        "link",
        { name: /Edit page draft: Schedule/ },
        { timeout: 10_000 },
      ),
    );

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/content/pages/schedule/edit",
      ),
    );
    expect(router.state.location.state).toMatchObject({ from: "/content" });
  });

  it("puts the navigation collapse control inside the primary rail", () => {
    const { container } = renderRouted(shellFor(adminPrincipal), [
      "/content/pages/schedule/edit",
    ]);

    const rail = container.querySelector("aside.sidebar") as HTMLElement;
    const header = container.querySelector(".workspace-header") as HTMLElement;
    const collapse = within(rail).getByRole("button", {
      name: "Expand primary navigation",
    });
    expect(collapse).toHaveAttribute("aria-controls", "primary-navigation");
    expect(collapse).toHaveAttribute("aria-expanded", "false");
    expect(
      within(header).queryByRole("button", { name: /primary navigation/ }),
    ).toBeNull();

    // Rail header first, navigation after it: the control that collapses the rail is reached
    // before the links it collapses.
    const nav = within(rail).getByRole("navigation", { name: "Primary" });
    expect(
      collapse.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(collapse.closest(".sidebar-header")).toBeTruthy();
  });

  it("keeps the collapsed rail control named, reachable and expandable by keyboard", () => {
    const { container } = renderRouted(shellFor(adminPrincipal), ["/"]);
    const rail = container.querySelector("aside.sidebar") as HTMLElement;
    const collapse = within(rail).getByRole("button", {
      name: "Collapse primary navigation",
    });

    fireEvent.click(collapse);
    expect(container.querySelector(".app-shell")).toHaveAttribute(
      "data-sidebar-collapsed",
      "true",
    );

    const expand = within(rail).getByRole("button", {
      name: "Expand primary navigation",
    });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expand.focus();
    expect(expand).toHaveFocus();
    fireEvent.click(expand);
    expect(container.querySelector(".app-shell")).toHaveAttribute(
      "data-sidebar-collapsed",
      "false",
    );
  });

  it("keeps the rail control operable for an account that prefers text controls", () => {
    // The text preference gives every eligible control its written label. The rail is 14.75rem
    // wide and 4rem collapsed, so "Collapse primary navigation" as text pushes the lockup out
    // when open and spills outside the rail when collapsed, leaving no way back. The rail control
    // stays an icon with its tooltip and full accessible name, the way the rail's own links keep
    // their labels only in the accessibility tree once collapsed.
    const router = createMemoryRouter(buildRoutes(), { initialEntries: ["/"] });
    const { container } = render(
      <ControlPresentationProvider value="text">
        <ShellProvider value={shellFor(adminPrincipal)}>
          <RouterProvider router={router} />
        </ShellProvider>
      </ControlPresentationProvider>,
    );
    const rail = container.querySelector("aside.sidebar") as HTMLElement;

    const collapse = within(rail).getByRole("button", {
      name: "Collapse primary navigation",
    });
    expect(collapse).toHaveClass("action-control-icon");
    expect(collapse).not.toHaveClass("action-control-text");
    expect(collapse).not.toHaveTextContent("Collapse primary navigation");

    // Global header utilities remain familiar icons so the brand, view, account, and menu
    // controls fit at the 320px proof width.
    expect(screen.getByRole("button", { name: "View options" })).toHaveClass(
      "action-control-icon",
    );

    fireEvent.click(collapse);
    const expand = within(rail).getByRole("button", {
      name: "Expand primary navigation",
    });
    expect(expand).toHaveClass("action-control-icon");
    expect(expand).not.toHaveTextContent("Expand primary navigation");
    fireEvent.click(expand);
    expect(container.querySelector(".app-shell")).toHaveAttribute(
      "data-sidebar-collapsed",
      "false",
    );
  });

  it("keeps the originating library on a create opened from it, through the first save", async () => {
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/content/library?status=draft"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );
    await screen.findByRole(
      "heading",
      { name: "All content" },
      { timeout: 10_000 },
    );

    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "New content" },
        { timeout: 10_000 },
      ),
    );
    fireEvent.click(screen.getByRole("link", { name: "New post" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/content/post/+"),
    );
    expect(
      await screen.findByRole(
        "link",
        { name: "Back to All content" },
        { timeout: 10_000 },
      ),
    ).toHaveAttribute("href", "/content/library?status=draft");

    // The first save canonicalizes the URL from the create marker to the minted id. That
    // replacement must carry the origin with it, or Back silently loses the filtered library the
    // person started from.
    functionMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPosts",
      id: "post-9",
      created: true,
      document: {
        id: "post-9",
        type: "post",
        title: "Filed from the library",
        status: "draft",
        version: 1,
      },
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Headline" }), {
      target: { value: "Filed from the library" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /^Area/ }), {
      target: { value: "watch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/content/post/post-9/edit"),
    );
    expect(
      await screen.findByRole(
        "link",
        { name: "Back to All content" },
        { timeout: 10_000 },
      ),
    ).toHaveAttribute("href", "/content/library?status=draft");
  }, 30_000);
});

// The canonical editorial task flow (#1036, the Aug. 20 acceptance addition). The hierarchy work is
// judged as task-flow performance, not as a restyling, so the one repeatable path is walked here
// against the real route tree and its activations are counted against the budget declared in
// src/lib/task-flow.ts. A wrong turn or a recovery action shows up as an activation this walk
// cannot spend, which is what makes the criterion executable rather than a matter of opinion.
//
// An activation is one deliberate pointer or key action. Typing into a field the caret already
// sits in is not one, which is why filling the required alt text below does not count against the
// media stage: the alt text is an accessibility obligation, not friction to design away.
describe("the canonical editorial task flow (#1036)", () => {
  const postWithParagraph = {
    id: "post-1",
    type: "post",
    title: "Garden State update",
    date: "2026-08-14",
    tags: [],
    blocks: [
      {
        id: "block-1",
        type: "prose",
        order: 0,
        visible: true,
        data: {
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "First paragraph." }],
              },
            ],
          },
        },
      },
    ],
    status: "draft",
    version: 2,
    createdBy: "user",
  };

  const queuedPost = {
    requestId: `review_${"a".repeat(64)}`,
    recordId: "post-1",
    title: "Garden State update",
    state: "in_review",
    collection: "cmsPosts",
    contentType: "post",
    sourceVersion: 2,
    requestedByLabel: "Blake Sutton",
    requestedAt: "2026-08-18T12:00:00.000Z",
    assigneeLabel: null,
    recovered: false,
  };

  function queueWith(request: Record<string, unknown>) {
    reviewMocks.cmsListReviewQueue.mockResolvedValue({
      success: true,
      requests: [request],
    });
  }

  beforeEach(() => {
    functionMocks.cmsGetContent.mockResolvedValue({
      success: true,
      found: true,
      document: postWithParagraph,
    });
    functionMocks.cmsListMedia.mockResolvedValue({
      success: true,
      records: [mediaAsset],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    });
    functionMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      id: "post-1",
      created: false,
      document: { ...postWithParagraph, version: 3 },
    });
  });

  it("walks open, edit, media, save and return from the editorial queue inside its budget", async () => {
    queueWith(queuedPost);
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/publish-queue"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    // Every deliberate pointer or key action goes through spend(), so the counter reflects what
    // the walk actually dispatched rather than the budget it is checked against. An interaction
    // added anywhere on this path therefore fails its stage's assertion. Typing is not an
    // activation, so the paragraph rewrite and the required alt text are dispatched outside it.
    let activations = 0;
    const spend = (dispatch: () => void) => {
      activations += 1;
      dispatch();
    };
    let mark = 0;
    const spentSinceMark = () => activations - mark;

    // Open. The queue row's own title is the control, so the record opens from the list the
    // reviewer is reading rather than from a separate action column.
    mark = activations;
    const open = await screen.findByRole(
      "link",
      { name: "Garden State update" },
      { timeout: 10_000 },
    );
    spend(() => fireEvent.click(open));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/content/post/post-1/edit"),
    );
    expect(spentSinceMark()).toBe(taskFlowStage("open").activationBudget);

    // Edit the canonical inline paragraph. The former modal Done activation is no longer needed.
    // Count Edit, focus and returning to Post details; the saved document must contain the rewrite.
    mark = activations;
    const postBody = await screen.findByRole("article", { name: "Post body" }, { timeout: 10_000 });
    const editText = await within(postBody).findByRole("button", { name: "Edit text 1" }, { timeout: 10_000 });
    expect(editText).toBeVisible();
    const documentBar = document.querySelector<HTMLElement>(".workspace-editor-document-bar")!;
    expect(documentBar).toBeInTheDocument();
    await waitFor(() => expect(editText).toBeEnabled());
    spend(() => fireEvent.click(editText));
    const paragraph = await within(postBody).findByRole(
      "textbox",
      { name: "Body" },
      { timeout: 10_000 },
    );
    spend(() => fireEvent.focus(paragraph));
    await act(async () => {
      paragraph.innerHTML = "<p>Rewritten in the walk.</p>";
      fireEvent.input(paragraph);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(paragraph).toHaveTextContent("Rewritten in the walk.");
    const postTab = screen.getByRole("tab", { name: "Post" });
    spend(() => fireEvent.click(postTab));
    const postPane = document.getElementById(postTab.getAttribute("aria-controls")!)!;
    expect(postPane).toBeInTheDocument();
    expect(spentSinceMark()).toBe(3);
    expect(spentSinceMark()).toBeLessThanOrEqual(taskFlowStage("edit").activationBudget);

    // Add or select media: open the picker, choose one image.
    mark = activations;
    spend(() =>
      fireEvent.click(within(postPane).getByRole("button", { name: "Choose lead image" })),
    );
    const picker = await screen.findByRole("dialog");
    const asset = await within(picker).findByRole("button", {
      name: /^Studio control room/,
    });
    spend(() => fireEvent.click(asset));
    fireEvent.change(within(postPane).getByLabelText(/^Lead image alt text/), {
      target: { value: "Monitors and switchers in the control room" },
    });
    expect(spentSinceMark()).toBe(taskFlowStage("media").activationBudget);

    // Save, from the one persistent document header.
    mark = activations;
    spend(() => fireEvent.click(within(documentBar).getByRole("button", { name: "Save draft" })));
    await waitFor(() => expect(functionMocks.cmsSaveContent).toHaveBeenCalled());
    expect(spentSinceMark()).toBe(taskFlowStage("save").activationBudget);

    // The paragraph edit reached the save, not just the media choice.
    const [, saved] = functionMocks.cmsSaveContent.mock.calls[0];
    expect(JSON.stringify(saved.document.blocks)).toContain(
      "Rewritten in the walk.",
    );
    expect(saved.document.leadMedia).toEqual({ kind: "image", data: { assetId: mediaAsset.id, alt: "Monitors and switchers in the control room" } });

    // Return to the originating list. One activation, and it lands on the queue the reviewer was
    // working -- not on a content list they never opened and would have to navigate back out of.
    mark = activations;
    const back = await within(documentBar).findByRole("link", {
      name: "Back to editorial queue",
    });
    spend(() => fireEvent.click(back));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/publish-queue"),
    );
    expect(spentSinceMark()).toBe(taskFlowStage("return").activationBudget);

    expect(activations).toBeLessThanOrEqual(taskFlowActivationBudget());
    expect(activations).toBe(8);
  }, 30_000);

  it("returns a page opened from the editorial queue to the queue", async () => {
    queueWith({
      ...queuedPost,
      requestId: `review_${"b".repeat(64)}`,
      recordId: "home",
      title: "Homepage",
      collection: "cmsPages",
      contentType: "page",
    });
    functionMocks.cmsGetContent.mockResolvedValue({
      success: true,
      found: true,
      document: {
        id: "home",
        template: "home",
        title: "Homepage",
        blocks: [],
        status: "in_review",
        version: 2,
        createdBy: "user",
      },
    });
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ["/publish-queue"],
    });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    fireEvent.click(
      await screen.findByRole("link", { name: "Homepage" }, { timeout: 10_000 }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/content/pages/home/edit"),
    );

    expect(
      await screen.findByRole(
        "link",
        { name: "Back to editorial queue" },
        { timeout: 10_000 },
      ),
    ).toHaveAttribute("href", "/publish-queue");
  }, 30_000);

  it("returns work opened from newsroom home to newsroom home", async () => {
    functionMocks.cmsListContent.mockResolvedValue({
      success: true,
      records: [
        {
          id: "post-1",
          kind: "post",
          title: "Garden State update",
          status: "draft",
          updatedAt: "2026-08-11T12:00:00.000Z",
        },
      ],
      total: 1,
      allCount: 1,
      mineCount: 0,
      assignedCount: 0,
      page: 1,
      pageCount: 1,
      statusCounts: {
        draft: 1,
        in_review: 0,
        scheduled: 0,
        published: 0,
        archived: 0,
      },
    });
    const router = createMemoryRouter(buildRoutes(), { initialEntries: ["/"] });
    render(
      <ShellProvider value={shellFor(adminPrincipal)}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    fireEvent.click(
      await screen.findByRole(
        "link",
        { name: "Garden State update" },
        { timeout: 10_000 },
      ),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/content/post/post-1/edit"),
    );

    expect(
      await screen.findByRole(
        "link",
        { name: "Back to newsroom home" },
        { timeout: 10_000 },
      ),
    ).toHaveAttribute("href", "/");
  }, 30_000);
});
