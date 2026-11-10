import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ShellLayout } from "../src/routes/ShellLayout";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import type { RouteHandle } from "../src/routes/buildRoutes";

// A phone editor hides the rail to give the canvas the width. Staff must still be able to reach
// every other destination from the editor, so the document bar carries a menu control that opens
// the rail as a drawer.

const editor = {
  principal: { id: "sa", grants: [{ role: "super_admin" }] },
  user: { uid: "sa", email: "account-26@example.org", displayName: "Staff Member" },
  userDoc: { role: null, preferences: {} },
  signOut: vi.fn(),
} as unknown as ShellData;

function stubScreen(phone: boolean) {
  const listeners = new Set<() => void>();
  const state = { phone };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return state.phone && (query === "(max-width: 619px)" || query === "(max-width: 720px)"); },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return (next: boolean) => {
    state.phone = next;
    act(() => listeners.forEach(listener => listener()));
  };
}

function renderEditor(path = "/content/post/story-1/edit", origin?: string) {
  const handle: RouteHandle = { title: "Edit post", description: "" };
  const router = createMemoryRouter(
    [{
      path: "/",
      element: <ShellLayout />,
      children: [
        { index: true, element: <p>Newsroom home surface</p>, handle },
        { path: "*", element: <p>Editor surface</p>, handle },
      ],
    }],
    { initialEntries: [{ pathname: path, state: origin ? { from: origin } : null }] },
  );
  const view = render(
    <ShellProvider value={editor}>
      <RouterProvider router={router} />
    </ShellProvider>,
  );
  return { ...view, router };
}

function rail() {
  return document.querySelector<HTMLElement>("aside.sidebar")!;
}

function workspace() {
  return document.querySelector<HTMLElement>(".workspace-shell")!;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("primary navigation in a phone editor", () => {
  it("follows workspace defaults without storing a choice during navigation", async () => {
    stubScreen(false);
    const { router } = renderEditor("/");
    for (const [path, collapsed] of [
      ["/", "false"], ["/content", "false"], ["/content/post/story-1/edit", "true"],
      ["/activity", "false"], ["/content/pages/home/edit", "true"], ["/publish-queue", "false"],
    ]) {
      await act(() => router.navigate(path));
      expect(rail()).toHaveAttribute("data-collapsed", collapsed);
      expect(localStorage.getItem("njpbs-admin:navigation-collapsed")).toBeNull();
    }
  });

  it.each([true, false])("keeps a stored collapsed=%s choice across all workspace families", async (collapsed) => {
    vi.stubEnv("VITE_LIVE_PRODUCTION_ENABLED", "true");
    stubScreen(false);
    localStorage.setItem("njpbs-admin:navigation-collapsed", String(collapsed));
    const { router } = renderEditor("/");
    const paths = ["/content", "/activity", "/content/post/story-1/edit", "/publish-queue", "/live-production", "/"];
    for (const path of paths) {
      await act(() => router.navigate(path));
      expect(rail()).toHaveAttribute("data-collapsed", String(collapsed));
    }
    fireEvent.click(screen.getByRole("button", { name: collapsed ? "Expand primary navigation" : "Collapse primary navigation" }));
    for (const path of paths) {
      await act(() => router.navigate(path));
      expect(rail()).toHaveAttribute("data-collapsed", String(!collapsed));
      expect(localStorage.getItem("njpbs-admin:navigation-collapsed")).toBe(String(!collapsed));
    }
  });

  it("opens the rail as a drawer and returns focus to the menu control on Escape", () => {
    stubScreen(true);
    renderEditor();

    const trigger = screen.getByRole("button", { name: "Open navigation" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(rail()).toHaveAttribute("data-menu-open", "false");

    fireEvent.click(trigger);

    expect(rail()).toHaveAttribute("data-menu-open", "true");
    expect(rail()).toHaveAttribute("data-collapsed", "false");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(workspace()).toHaveAttribute("inert");
    expect(rail().contains(document.activeElement)).toBe(true);
    expect(screen.getByRole("navigation", { name: "Primary" })).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(rail()).toHaveAttribute("data-menu-open", "false");
    expect(workspace()).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(trigger);
  });

  it.each([
    ["Home", "/"], ["Activity", "/activity"], ["schedule", "/schedule"],
    ["Resources", "/resources/nj-politics"], ["Live production", "/live-production"],
    ["directory", "/content"], ["record list", "/content/sponsor"],
    ["library", "/content/library"], ["media", "/media/images"], ["queue", "/publish-queue"],
  ])("keeps every destination reachable in the phone %s workspace", (_family, path) => {
    stubScreen(true);
    renderEditor(path);
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(trigger);
    expect(rail()).toHaveAttribute("data-menu-open", "true");
    expect(rail()).toHaveAttribute("data-collapsed", "false");
    expect(workspace()).toHaveAttribute("inert");
    expect(document.querySelector(".skip-link")).toHaveAttribute("inert");
    expect(screen.getByRole("navigation", { name: "Primary" })).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(rail()).toHaveAttribute("data-menu-open", "false");
    expect(workspace()).not.toHaveAttribute("inert");
    expect(document.querySelector(".skip-link")).not.toHaveAttribute("inert");
    expect(trigger).toBe(document.activeElement);
  });

  it("closes from the scrim and from the drawer's close control", () => {
    stubScreen(true);
    renderEditor();
    const trigger = screen.getByRole("button", { name: "Open navigation" });

    fireEvent.click(trigger);
    fireEvent.click(document.querySelector(".editor-nav-scrim")!);
    expect(rail()).toHaveAttribute("data-menu-open", "false");
    expect(document.querySelector(".editor-nav-scrim")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(rail()).toHaveAttribute("data-menu-open", "false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the drawer when a destination is chosen", async () => {
    stubScreen(true);
    const { router } = renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    await act(() => router.navigate("/"));

    expect(screen.getByText("Newsroom home surface")).toBeInTheDocument();
    expect(rail()).toHaveAttribute("data-menu-open", "false");
    expect(workspace()).not.toHaveAttribute("inert");
  });

  it("makes the skip link inert with the workspace so Tab stays in the drawer", () => {
    stubScreen(true);
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    expect(document.querySelector(".skip-link")).toHaveAttribute("inert");
    expect(document.querySelector(".success-notice-region")).toHaveAttribute("inert");
    expect(rail()).not.toHaveAttribute("inert");
  });

  it("leaves Escape to an open modal and to an Escape another layer already handled", () => {
    stubScreen(true);
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => { document.dispatchEvent(handled); });
    expect(rail()).toHaveAttribute("data-menu-open", "true");

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(rail()).toHaveAttribute("data-menu-open", "true");
    modal.remove();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(rail()).toHaveAttribute("data-menu-open", "false");
  });

  it("lifts inert as soon as a destination is chosen, before the route commits", () => {
    stubScreen(true);
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    fireEvent.click(screen.getByRole("navigation", { name: "Primary" }).querySelector("a[href]")!);

    expect(workspace()).not.toHaveAttribute("inert");
    expect(document.querySelector(".skip-link")).not.toHaveAttribute("inert");
    expect(rail()).toHaveAttribute("data-menu-open", "false");
  });

  it("returns focus to the menu control when a destination choice does not navigate", () => {
    stubScreen(true);
    renderEditor();
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(trigger);

    // A canceled navigation: an earlier handler stops the link, as an exit guard's
    // "Keep editing" leaves the editor where it was.
    const cancel = (event: Event) => event.preventDefault();
    document.addEventListener("click", cancel, true);
    fireEvent.click(screen.getByRole("navigation", { name: "Primary" }).querySelector("a[href]")!);
    document.removeEventListener("click", cancel, true);

    expect(screen.getByText("Editor surface")).toBeInTheDocument();
    expect(rail()).toHaveAttribute("data-menu-open", "false");
    expect(workspace()).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(trigger);
  });

  it("lifts inert before route focus runs on any navigation, such as the workspace finder", async () => {
    stubScreen(true);
    const { router } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(workspace()).toHaveAttribute("inert");

    const inertWhenFocused: boolean[] = [];
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
      if (this.id === "page-title") inertWhenFocused.push(Boolean(this.closest("[inert]")));
    });
    await act(() => router.navigate("/"));
    focus.mockRestore();

    expect(inertWhenFocused).toEqual([false]);
    expect(rail()).toHaveAttribute("data-menu-open", "false");
  });

  it("does not open the editor drawer from a menu left open on the previous page", async () => {
    stubScreen(true);
    const { router } = renderEditor("/");
    fireEvent.click(rail().querySelector(".menu-toggle")!);
    expect(rail()).toHaveAttribute("data-menu-open", "true");

    const railFocus: string[] = [];
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
      if (this.closest("aside.sidebar")) railFocus.push(this.outerHTML.slice(0, 60));
    });
    await act(() => router.navigate("/content/post/story-1/edit"));
    focus.mockRestore();

    expect(railFocus).toEqual([]);
    expect(rail()).toHaveAttribute("data-menu-open", "false");
    expect(workspace()).not.toHaveAttribute("inert");
  });

  it("closes the drawer for an account menu destination", () => {
    stubScreen(true);
    renderEditor();
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /^Account menu for / }));

    // The destination is a lazy route, so the drawer must not wait for the route to commit.
    const hold = (event: Event) => event.preventDefault();
    document.addEventListener("click", hold, true);
    fireEvent.click(rail().querySelector<HTMLElement>(".account-menu-panel a[href]")!);
    document.removeEventListener("click", hold, true);

    expect(rail()).toHaveAttribute("data-menu-open", "false");
    expect(workspace()).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus from the phone menu control to the rail when the screen widens", () => {
    const resize = stubScreen(true);
    renderEditor();
    screen.getByRole("button", { name: "Open navigation" }).focus();

    resize(false);

    expect(screen.queryByRole("button", { name: "Open navigation" })).toBeNull();
    expect(document.activeElement).toBe(rail().querySelector(".sidebar-collapse-toggle"));
  });

  it("keeps the rail itself, with no extra menu control, on wider screens", () => {
    stubScreen(false);
    renderEditor();

    expect(screen.queryByRole("button", { name: "Open navigation" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });
});


describe("document bar breadcrumbs", () => {
  it.each([
    "/content", "/content/library", "/content/post", "/content/sponsor",
    "/media", "/media/images", "/media/videos", "/media/audio", "/publish-queue",
  ])("names the Home parent of %s and follows its native link", async (path) => {
    stubScreen(false);
    const { container, router } = renderEditor(path);
    const link = container.querySelector<HTMLAnchorElement>(".editor-document-breadcrumb")!;
    expect(link).toHaveTextContent("Home");
    expect(link).toHaveAccessibleName("Home");
    expect(link).toHaveAttribute("href", "/");
    fireEvent.click(link);
    await act(async () => {});
    expect(router.state.location.pathname).toBe("/");
  });

  it.each([
    ["/publish-queue?assignee=me", "Editorial queue", "Back to editorial queue"],
    ["/", "Home", "Back to newsroom home"],
    ["/content/post?page=2", "Posts", "Back to posts list"],
    ["/content/library?status=draft", "All content", "Back to All content"],
  ])("retains the explicit label, accessible Back name and exact origin %s", (origin, label, accessibleName) => {
    stubScreen(false);
    const { container } = renderEditor("/content/post/story-1/edit", origin);
    const link = container.querySelector<HTMLAnchorElement>(".editor-document-breadcrumb")!;
    expect(link).toHaveTextContent(label);
    expect(link).toHaveAccessibleName(accessibleName);
    expect(link).toHaveAttribute("href", origin);
  });
});
