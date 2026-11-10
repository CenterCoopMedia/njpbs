import { render, screen, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ShellLayout } from "../src/routes/ShellLayout";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import type { RouteHandle } from "../src/routes/buildRoutes";
import { ROUTE_PREFETCH_DELAY_MS } from "../src/lib/route-prefetch";

// The rail wired to the real loaders, with the loader table itself replaced. This is the seam
// that proves the shell reuses the shared `adminRoutePreloaders` rather than a prefetch-only
// copy: the module under test resolves the path through the shared map and calls whatever that
// table holds.
const loaders = vi.hoisted(() => ({
  accountSettings: vi.fn(async () => ({})),
  accountProfile: vi.fn(async () => ({})),
  authorProfiles: vi.fn(async () => ({})),
  adminSettings: vi.fn(async () => ({})),
  activity: vi.fn(async () => ({})),
  content: vi.fn(async () => ({})),
  postTemplates: vi.fn(async () => ({})),
  dashboard: vi.fn(async () => ({})),
  media: vi.fn(async () => ({})),
  notFound: vi.fn(async () => ({})),
  queue: vi.fn(async () => ({})),
  resources: vi.fn(async () => ({})),
  staff: vi.fn(async () => ({})),
}));

vi.mock("../src/routes/routeModules", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/routes/routeModules")>();
  return { ...actual, adminRoutePreloaders: loaders };
});

const superAdmin = {
  id: "sa",
  grants: [{ role: "super_admin" }],
} as unknown as ShellData["principal"];

function shell(): ShellData {
  return {
    principal: superAdmin,
    user: {
      uid: "sa",
      email: "account-26@example.org",
      displayName: "Staff Member",
    },
    userDoc: { role: null },
    signOut: vi.fn(),
  } as unknown as ShellData;
}

function page(title: string) {
  return {
    element: <p>{title} surface</p>,
    handle: { title, description: "" } satisfies RouteHandle,
  };
}

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <ShellLayout />,
        children: [
          { index: true, ...page("Newsroom home") },
          { path: "*", ...page("Elsewhere") },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(
    <ShellProvider value={shell()}>
      <RouterProvider router={router} />
    </ShellProvider>,
  );
}

// React implements onPointerEnter/onPointerLeave from the delegated pointerover/pointerout
// pair rather than from the non-bubbling native enter/leave events, so the tests drive the
// events React actually listens for, with a relatedTarget outside the row.
function pointerEnter(element: HTMLElement): void {
  fireEvent.pointerOver(element, { relatedTarget: document.body });
}

function pointerLeave(element: HTMLElement): void {
  fireEvent.pointerOut(element, { relatedTarget: document.body });
}

// Likewise for onFocus/onBlur, which React delegates from the bubbling focusin/focusout pair
// rather than the native focus/blur events.
function focusRow(element: HTMLElement): void {
  fireEvent.focusIn(element);
}

function blurRow(element: HTMLElement): void {
  fireEvent.focusOut(element);
}

function railLink(label: string): HTMLElement {
  return within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
    "link",
    { name: label },
  );
}

describe("rail destinations prefetch their own module after intent", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const loader of Object.values(loaders)) loader.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the destination module when the pointer settles on the row", () => {
    renderShell();

    pointerEnter(railLink("Media library"));
    expect(loaders.media).not.toHaveBeenCalled();

    vi.advanceTimersByTime(ROUTE_PREFETCH_DELAY_MS);
    expect(loaders.media).toHaveBeenCalledTimes(1);
  });

  it("preloads the resource code on intent without loading other workspaces", () => {
    renderShell();
    focusRow(railLink("Resources"));
    vi.advanceTimersByTime(ROUTE_PREFETCH_DELAY_MS);
    expect(loaders.resources).toHaveBeenCalledOnce();
    expect(Object.values(loaders).filter((loader) => loader.mock.calls.length > 0)).toHaveLength(1);
  });

  it("downloads nothing when the pointer crosses the rail without stopping", () => {
    renderShell();

    for (const label of ["Media library", "Activity", "Editorial queue"]) {
      const link = railLink(label);
      pointerEnter(link);
      pointerLeave(link);
    }
    vi.advanceTimersByTime(ROUTE_PREFETCH_DELAY_MS * 4);

    expect(
      Object.values(loaders).filter((loader) => loader.mock.calls.length > 0),
    ).toHaveLength(0);
  });

  it("starts the module once however often intent repeats on the same row", () => {
    renderShell();
    const link = railLink("Activity");

    pointerEnter(link);
    vi.advanceTimersByTime(ROUTE_PREFETCH_DELAY_MS);
    focusRow(link);
    vi.advanceTimersByTime(ROUTE_PREFETCH_DELAY_MS);
    fireEvent.pointerDown(link);

    expect(loaders.activity).toHaveBeenCalledTimes(1);
  });

  it("starts at once on a press, without waiting out the intent delay", () => {
    renderShell();

    fireEvent.pointerDown(railLink("Staff access"));

    expect(loaders.staff).toHaveBeenCalledTimes(1);
  });

  it("keeps a keyboard intent alive when the pointer slides off the focused row", () => {
    renderShell();
    const link = railLink("Editorial queue");

    focusRow(link);
    pointerLeave(link);
    vi.advanceTimersByTime(ROUTE_PREFETCH_DELAY_MS);

    // No second focus event follows a pointer leaving, so cancelling here would have left
    // Enter navigating cold.
    expect(loaders.queue).toHaveBeenCalledTimes(1);
  });

  it("drops the intent when the keyboard moves on and no pointer is holding it", () => {
    renderShell();
    const link = railLink("Editorial queue");

    focusRow(link);
    blurRow(link);
    vi.advanceTimersByTime(ROUTE_PREFETCH_DELAY_MS * 2);

    expect(loaders.queue).not.toHaveBeenCalled();
  });

  it("starts the content workspace, not only its routed boundary, for a content destination", () => {
    renderShell();

    pointerEnter(railLink("Pages"));
    vi.advanceTimersByTime(ROUTE_PREFETCH_DELAY_MS);

    // The rail reaches the composed preloader, the one that starts ContentLayout and the
    // editor workspace behind it together; the bare route module would leave the heaviest
    // graph for after the click.
    expect(loaders.content).toHaveBeenCalledTimes(1);
  });
});
