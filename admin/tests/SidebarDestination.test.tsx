import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { SidebarDestination } from "../src/components/SidebarDestination";
import {
  NAV_DESTINATIONS,
  eligibleNavDestinations,
  type NavDestinationDef,
} from "../src/lib/nav-destinations";
import type { RoutePrefetcher } from "../src/lib/route-prefetch";
import { parseContentPath } from "../src/lib/routes";

// Sidebar tests exercise intent callbacks, not the lazy editor module graph.
vi.mock("../src/routes/routeModules", () => ({
  adminRoutePreloaders: {},
  routeModuleKeyForPath: () => null,
}));

const prefetch: RoutePrefetcher = {
  intent: vi.fn(),
  cancel: vi.fn(),
  started: () => [],
};

function destination(id: string): NavDestinationDef {
  const match = NAV_DESTINATIONS.find((entry) => entry.id === id);
  if (!match) throw new Error(`Missing ${id} destination.`);
  return match;
}

function renderDestination(
  id: string,
  pathname: string,
  expanded = false,
) {
  const onExpandedChange = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={[pathname]}>
      <SidebarDestination
        destination={destination(id)}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        pathname={pathname}
        prefetch={prefetch}
      />
    </MemoryRouter>,
  );
  return { ...view, onExpandedChange };
}

describe("contextual sidebar actions", () => {
  it("shows canonical shortcuts when the selected Pages section is explicitly expanded", () => {
    renderDestination("pages", "/content", true);

    const toggle = screen.getByRole("button", { name: "Hide Pages actions" });
    const pages = screen.getByRole("link", { name: "Pages" });
    const allPages = screen.getByRole("link", { name: "All pages" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toBeEnabled();
    expect(pages).not.toHaveAttribute("aria-current");
    expect(allPages).toHaveAttribute("aria-current", "page");
    expect(allPages).toHaveAttribute("href", "/content");
    expect(screen.getByRole("link", { name: "Edit home page" })).toHaveAttribute(
      "href",
      "/content/pages/home/edit",
    );
    expect(screen.queryByRole("link", { name: /new page/i })).toBeNull();
  });

  it("opens and closes inactive Posts actions from the explicit disclosure", () => {
    const { rerender, onExpandedChange } = renderDestination("posts", "/", false);
    const toggle = screen.getByRole("button", { name: "Show Posts actions" });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "All posts" })).toBeNull();
    fireEvent.focus(toggle);
    expect(onExpandedChange).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);

    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <SidebarDestination
          destination={destination("posts")}
          expanded
          onExpandedChange={onExpandedChange}
          pathname="/"
          prefetch={prefetch}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "All posts" })).toHaveAttribute(
      "href",
      "/content/post",
    );
    expect(screen.getByRole("link", { name: "Add new post" })).toHaveAttribute(
      "href",
      "/content/post/+",
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide Posts actions" }));
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
  });

  it.each([false, true])("keeps disclosure stable during pointer and focus movement (expanded=%s)", (expanded) => {
    const { container, onExpandedChange } = renderDestination("pages", "/", expanded);
    const group = container.querySelector<HTMLDivElement>(".nav-destination-group");
    if (!group) throw new Error("Expected the Pages destination group.");
    const pagesLink = screen.getByRole("link", { name: "Pages" });
    fireEvent.pointerEnter(group, { pointerType: "mouse" });
    fireEvent.focus(pagesLink);
    fireEvent.pointerLeave(group, { pointerType: "mouse" });
    fireEvent.blur(pagesLink, { relatedTarget: document.body });
    expect(onExpandedChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", String(expanded));
    expect(prefetch.intent).toHaveBeenCalledWith("/content", "focus");
  });

  it.each(["pages", "posts", "library"])("allows the current %s section to open and close", (id) => {
    const entry = destination(id);
    const { rerender, onExpandedChange } = renderDestination(id, entry.to, false);
    const toggle = screen.getByRole("button", { name: `Show ${entry.label} actions` });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);
    rerender(
      <MemoryRouter initialEntries={[entry.to]}>
        <SidebarDestination destination={entry} expanded onExpandedChange={onExpandedChange}
          pathname={entry.to} prefetch={prefetch} />
      </MemoryRouter>,
    );
    const expandedToggle = screen.getByRole("button", { name: `Hide ${entry.label} actions` });
    expect(expandedToggle).toBeEnabled();
    fireEvent.click(expandedToggle);
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
  });

  it("marks only the exact selected subitem as the current page", () => {
    renderDestination("pages", "/content/pages/home/edit", true);

    expect(screen.getByRole("link", { name: "Pages" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(
      screen.getByRole("link", { name: "Edit home page" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("keeps subnavigation behind parent and shortcut capabilities", () => {
    const contributor = {
      id: "contributor",
      grants: [{ role: "contributor" as const }],
    };
    const newsEditor = {
      id: "news-editor",
      grants: [{ role: "editor" as const, sections: ["news"] }],
    };
    const stationEditor = {
      id: "station-editor",
      grants: [{ role: "editor" as const, sections: ["station"] }],
    };
    const superAdmin = {
      id: "admin",
      grants: [{ role: "super_admin" as const }],
    };

    expect(eligibleNavDestinations(contributor).map((entry) => entry.id)).toContain(
      "posts",
    );
    const contributorPages = eligibleNavDestinations(contributor).find(
      (entry) => entry.id === "pages",
    );
    expect(contributorPages?.subitems?.map((entry) => entry.id)).toEqual(["all-pages"]);

    const newsPages = eligibleNavDestinations(newsEditor).find(
      (entry) => entry.id === "pages",
    );
    expect(newsPages?.subitems?.map((entry) => entry.id)).toEqual(["all-pages"]);

    const stationPages = eligibleNavDestinations(stationEditor).find(
      (entry) => entry.id === "pages",
    );
    expect(stationPages?.subitems?.map((entry) => entry.id)).toEqual([
      "all-pages",
      "edit-home",
    ]);

    expect(eligibleNavDestinations(superAdmin).map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["pages", "posts"]),
    );
    expect(
      eligibleNavDestinations(superAdmin)
        .find((entry) => entry.id === "library")
        ?.subitems?.map((entry) => entry.label),
    ).toEqual([
      "Browse all content",
      "Programs",
      "Events",
      "Sponsors",
      "Newsletters",
    ]);
  });

  it("keeps every content shortcut on an admitted route", () => {
    for (const destination of NAV_DESTINATIONS) {
      for (const subitem of destination.subitems ?? []) {
        if (!subitem.to.startsWith("/content/")) continue;
        expect(parseContentPath(subitem.to), subitem.to).not.toEqual({ kind: "not-found" });
      }
    }
  });
});

