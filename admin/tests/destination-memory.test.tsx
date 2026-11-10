import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, type Location } from "react-router";
import { buildRoutes } from "../src/routes/buildRoutes";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import { ADMIN_DESTINATION_KEY } from "../src/lib/route-memory";

function remember(uid: string, path: string) {
  sessionStorage.setItem(ADMIN_DESTINATION_KEY, JSON.stringify({ uid, path }));
}

function rememberedPath(): string | null {
  const raw = sessionStorage.getItem(ADMIN_DESTINATION_KEY);
  return raw ? (JSON.parse(raw) as { path: string }).path : null;
}

// The refresh contract (#1031), exercised through the real route tree. A router honors the
// address it is given, so these tests describe the case where the address did not survive the
// reload: the app boots at the default route while this tab still remembers where the person
// was. The restore has to reopen that destination, re-derive authorization from the principal
// this load resolved, and never override an address that did survive.

const authMocks = vi.hoisted(() => {
  const getIdToken = vi.fn();
  return {
    getIdToken,
    value: {
      state: {
        status: "signed-in",
        user: { uid: "user", email: "account-29@example.org", displayName: "Test User" },
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
  cmsGetContent: vi.fn(),
  cmsGetNewsroomBanner: vi.fn(),
  cmsGetSettings: vi.fn(),
  cmsListAudit: vi.fn(),
  cmsListContent: vi.fn(),
}));

const firestoreMocks = vi.hoisted(() => ({
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
  getDocs: vi.fn(async () => ({ docs: [] })),
  onSnapshot: vi.fn((_reference: unknown, next: (snapshot: unknown) => void) => {
    // Covers both shapes the shell subscribes to: a document listener (page hydration) and a
    // collection listener (the staff roster).
    next({ exists: () => false, docs: [] });
    return () => {};
  }),
}));

vi.mock("firebase/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase/firestore")>()),
  doc: firestoreMocks.doc,
  getDoc: firestoreMocks.getDoc,
  getDocs: firestoreMocks.getDocs,
  onSnapshot: firestoreMocks.onSnapshot,
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => authMocks.value,
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsGetAuthorProfile: functionMocks.cmsGetAuthorProfile,
  cmsGetContent: functionMocks.cmsGetContent,
  cmsGetNewsroomBanner: functionMocks.cmsGetNewsroomBanner,
  cmsGetSettings: functionMocks.cmsGetSettings,
  cmsListAudit: functionMocks.cmsListAudit,
  cmsListContent: functionMocks.cmsListContent,
}));

const adminPrincipal = {
  id: "admin",
  grants: [{ role: "admin" }],
} as unknown as ShellData["principal"];

const siteWideEditorPrincipal = {
  id: "editor",
  grants: [{ role: "editor" }],
} as unknown as ShellData["principal"];

function shellFor(principal: ShellData["principal"]): ShellData {
  return {
    principal,
    user: {
      uid: "user",
      email: "account-29@example.org",
      displayName: "Test User",
    } as unknown as ShellData["user"],
    userDoc: principal.id === "admin" ? { role: "admin" } : null,
    signOut: vi.fn(),
  };
}

function bootAt(shell: ShellData, address: string | Partial<Location>) {
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [address] });
  const view = render(
    <ShellProvider value={shell}>
      <RouterProvider router={router} />
    </ShellProvider>,
  );
  return { router, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  authMocks.getIdToken.mockResolvedValue("id-token");
  functionMocks.cmsGetAuthorProfile.mockResolvedValue({
    success: true,
    profile: { photo: null },
  });
  functionMocks.cmsGetContent.mockResolvedValue({
    success: true,
    found: false,
    document: null,
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
  functionMocks.cmsListAudit.mockResolvedValue({
    success: true,
    entries: [],
    nextCursor: null,
  });
  functionMocks.cmsListContent.mockResolvedValue({
    success: true,
    records: [],
    total: 0,
    allCount: 0,
    mineCount: 0,
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
});

describe("admin destination memory", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { pathname: "/premiere/connect", stored: '{"uid":"user","path":"/premiere/connect?from=panel&mode=review#review"}' },
    { pathname: "/premiere/connect/", stored: '{"uid":"user","path":"/premiere/connect/?from=panel&mode=review#review"}' },
    { pathname: "/Premiere/Connect", stored: '{"uid":"user","path":"/Premiere/Connect?from=panel&mode=review#review"}' },
  ])("strips the code at $pathname from the router and never records it in the destination memory", async ({ pathname, stored }) => {
    const store = vi.spyOn(Storage.prototype, "setItem");
    const { router } = bootAt(shellFor(adminPrincipal), {
      pathname, search: "?from=panel&code=kxqr7m2p&mode=review",
      hash: "#review", state: { from: "staff-route" },
    });

    expect(await screen.findByLabelText("Connection code")).toHaveValue("KXQR-7M2P");
    await waitFor(() => {
      expect(router.state.location).toMatchObject({
        pathname, search: "?from=panel&mode=review",
        hash: "#review", state: { from: "staff-route" },
      });
      expect(sessionStorage.getItem(ADMIN_DESTINATION_KEY)).toBe(stored);
    });
    expect(router.state.historyAction).toBe("REPLACE");
    const destinations = store.mock.calls.filter(([key]) => key === ADMIN_DESTINATION_KEY);
    expect(destinations.length).toBeGreaterThan(0);
    for (const [, record] of destinations) {
      expect(record).toBe(stored);
    }
  });

  it("records the destination on every navigation", async () => {
    const { router } = bootAt(shellFor(adminPrincipal), "/");
    await waitFor(() =>
      expect(rememberedPath()).toBe("/"),
    );

    await router.navigate("/staff-access");
    await waitFor(() =>
      expect(rememberedPath()).toBe("/staff-access"),
    );

    await router.navigate("/content/library?status=draft");
    await waitFor(() =>
      expect(rememberedPath()).toBe("/content/library?status=draft"),
    );
  });

  it("reopens the remembered destination when the load lands on home", async () => {
    remember("user", "/staff-access");
    const { router } = bootAt(shellFor(adminPrincipal), "/");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Staff access" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/staff-access");
    // Replaced, not pushed: a restored load must not leave a bogus Back entry behind.
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("reopens an addressed record editor, query and all", async () => {
    remember("user", "/content/post/abc123/edit");
    const { router } = bootAt(shellFor(adminPrincipal), "/");

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/content/post/abc123/edit"),
    );
  });

  it("keeps an address that survived the load", async () => {
    remember("user", "/staff-access");
    const { router } = bootAt(shellFor(adminPrincipal), "/activity");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Activity" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/activity");
  });

  it("fails safe to home when the remembered route is outside this account's access", async () => {
    remember("user", "/staff-access");
    const { router } = bootAt(shellFor(siteWideEditorPrincipal), "/");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    // The refused address is dropped rather than retried on the next load, and no notice is
    // shown: the person did not ask for that route on this load.
    await waitFor(() =>
      expect(rememberedPath()).toBe("/"),
    );
    expect(
      screen.queryByText("Staff access isn't available for your account."),
    ).not.toBeInTheDocument();
  });

  it("ignores a stored value that is not an in-app path", async () => {
    remember("user", "//evil.example.com/x");
    const { router } = bootAt(shellFor(adminPrincipal), "/");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("ignores a destination another account left in this tab", async () => {
    // A shared machine: someone signs out and a colleague signs in on the same tab. The stored
    // address belongs to the previous session, so it is neither restored nor kept.
    remember("someone-else", "/staff-access");
    const { router } = bootAt(shellFor(adminPrincipal), "/");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    await waitFor(() => expect(rememberedPath()).toBe("/"));
  });

  it("leaves a fresh tab with no memory at the address it was given", async () => {
    const { router } = bootAt(shellFor(adminPrincipal), "/");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("keeps Back and Forward on the prior destination instead of resetting to home", async () => {
    const { router } = bootAt(shellFor(adminPrincipal), "/");
    await router.navigate("/activity");
    await router.navigate("/staff-access");

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe("/activity"));

    await router.navigate(1);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/staff-access"),
    );
  });
});
