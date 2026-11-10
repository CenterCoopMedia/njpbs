import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ShellLayout } from "../src/routes/ShellLayout";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import { NAVIGATION_PREFERENCES_VERSION } from "../src/lib/navigation-preferences";
import type { RouteHandle } from "../src/routes/buildRoutes";

// The rail as an account actually receives it: a stored arrangement, the role's capabilities, and
// the routes underneath. The route tree here is a stand-in for the real one, so this file proves
// the rail's rules rather than re-proving routing.

const superAdmin = {
  id: "sa",
  grants: [{ role: "super_admin" }],
} as unknown as ShellData["principal"];

const contributor = {
  id: "co",
  grants: [{ role: "contributor" }],
} as unknown as ShellData["principal"];

function shell(
  principal: ShellData["principal"],
  navigation: unknown,
): ShellData {
  return {
    principal,
    user: {
      uid: principal.id,
      email: "account-26@example.org",
      displayName: "Staff Member",
    },
    userDoc: { role: null, preferences: { navigation } },
    signOut: vi.fn(),
  } as unknown as ShellData;
}

function page(title: string) {
  return {
    element: <p>{title} surface</p>,
    handle: { title, description: "" } satisfies RouteHandle,
  };
}

function renderShell(data: ShellData, initialEntry = "/") {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <ShellLayout />,
        children: [
          { index: true, ...page("Newsroom home") },
          { path: "activity", ...page("Activity") },
          { path: "media", ...page("Media library") },
          { path: "reports/*", ...page("Reports") },
          { path: "resources/nj-politics", ...page("NJ politics") },
          { path: "settings/site", ...page("Admin settings") },
          { path: "*", ...page("Elsewhere") },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return render(
    <ShellProvider value={data}>
      <RouterProvider router={router} />
    </ShellProvider>,
  );
}

function railLabels(): string[] {
  return within(screen.getByRole("navigation", { name: "Primary" }))
    .getAllByRole("link")
    .map((link) => link.textContent?.trim() ?? "");
}

describe("primary navigation with per-account preferences", () => {
  it("opens the politics resource directly for guide-only staff", () => {
    renderShell(
      shell({ id: "staff", grants: [{ role: "staff" }] } as unknown as ShellData["principal"], undefined),
      "/resources/nj-politics",
    );
    expect(screen.getByRole("link", { name: "Resources" })).toHaveAttribute("href", "/resources/nj-politics");
    expect(screen.getByText("NJ politics surface")).toBeInTheDocument();
    expect(screen.queryByText("Use the Boardwalk guide, Resources, Broadcast schedule, the media library, Reports, or account settings.")).not.toBeInTheDocument();
  });

  it("offers Viewers their shared resources and report form without authoring access", () => {
    renderShell(
      shell(
        { id: "new-staff", grants: [{ role: "staff" }] } as unknown as ShellData["principal"],
        undefined,
      ),
    );

    expect(railLabels()).toEqual([
      "Media library",
      "StoryDesk",
      "Broadcast schedule",
      "Resources",
      "Reports",
      "Around NJ",
    ]);
    expect(
      screen.queryByRole("button", { name: "Report a problem" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Profile" })).not.toBeInTheDocument();
  });

  it.each(["/reports", "/reports/report-1"])("opens %s directly for a Viewer", (path) => {
    renderShell(shell({ id: "viewer", grants: [{ role: "staff" }] }, undefined), path);
    expect(screen.getByText("Reports surface")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(screen.getByRole("dialog", { name: "Report a problem" })).toBeVisible();
  });

  it("renders the approved default order when nothing is stored", () => {
    renderShell(shell(superAdmin, undefined));

    expect(railLabels()).toEqual([
      "Home", "Pages", "Posts", "All content", "Media library",
      "Editorial queue", "StoryDesk", "Activity", "Broadcast schedule", "Resources", "Staff profiles", "Staff access",
      "Analytics", "Reports", "Admin settings", "Around NJ",
    ]);
    const around = screen.getByRole("link", { name: "Open Around NJ in a new tab" });
    expect(around).toHaveAttribute("href", "https://centercoopmedia.github.io/around-nj/");
    expect(around).toHaveAttribute("target", "_blank");
  });

  it("hides Around NJ when this account takes it out of the rail", () => {
    renderShell(shell(superAdmin, {
      version: NAVIGATION_PREFERENCES_VERSION,
      order: ["around-nj", "home"],
      hidden: ["around-nj"],
    }));
    expect(railLabels()).not.toContain("Around NJ");
    expect(screen.queryByRole("link", { name: "Open Around NJ in a new tab" })).toBeNull();
  });

  it("applies this account's stored order and leaves hidden destinations out", () => {
    renderShell(
      shell(superAdmin, {
        version: NAVIGATION_PREFERENCES_VERSION,
        order: ["media", "home", "activity"],
        hidden: ["activity", "staff-profiles"],
      }),
    );

    expect(railLabels().indexOf("Media library")).toBeLessThan(railLabels().indexOf("Home"));
    expect(railLabels()).not.toContain("Activity");
    expect(railLabels()).not.toContain("Staff profiles");
  });

  it("falls back to the default for a malformed or older stored record", () => {
    renderShell(shell(superAdmin, { version: 0, order: ["media"], hidden: ["home"] }));
    expect(railLabels()[0]).toBe("Home");

    cleanup();
    renderShell(shell(superAdmin, "media,home"));
    expect(railLabels()[0]).toBe("Home");
  });

  it("keeps a required destination in the rail however the record was written", () => {
    renderShell(
      shell(superAdmin, {
        version: NAVIGATION_PREFERENCES_VERSION,
        order: ["media", "home", "admin-settings"],
        hidden: ["home", "admin-settings"],
      }),
    );

    expect(railLabels()).toContain("Home");
    expect(railLabels()).toContain("Admin settings");
  });

  it("drops a destination the role no longer allows, whatever the preference says", () => {
    renderShell(
      shell(contributor, {
        version: NAVIGATION_PREFERENCES_VERSION,
        order: ["staff-access", "admin-settings", "home"],
        hidden: [],
      }),
    );

    expect(railLabels()).not.toContain("Staff access");
    expect(railLabels()).not.toContain("Admin settings");
    expect(railLabels()[0]).toBe("Home");
  });

  it("ignores a stored id that no longer names a destination", () => {
    renderShell(
      shell(superAdmin, {
        version: NAVIGATION_PREFERENCES_VERSION,
        order: ["voiceovers", "media"],
        hidden: ["voiceovers"],
      }),
    );

    expect(railLabels()).toContain("Media library");
    expect(railLabels()).toHaveLength(16);
  });

  it("still opens a hidden destination at its own address", () => {
    renderShell(
      shell(superAdmin, {
        version: NAVIGATION_PREFERENCES_VERSION,
        order: [],
        hidden: ["activity"],
      }),
      "/activity",
    );

    expect(railLabels()).not.toContain("Activity");
    expect(screen.getByText("Activity surface")).toBeVisible();
  });

  it("keeps the account destinations out of the arrangeable rail", () => {
    renderShell(shell(superAdmin, undefined));

    expect(railLabels()).not.toContain("Profile");
    expect(railLabels()).not.toContain("Settings");
    expect(
      screen.getByRole("button", { name: /Staff Member/ }),
    ).toBeVisible();
  });

  it("keeps the report control in the persistent workspace header", () => {
    renderShell(shell(superAdmin, undefined));

    const reportControl = screen.getByRole("button", {
      name: "Report a problem",
    });
    expect(reportControl.closest("header")).toHaveClass("workspace-header");
    expect(
      within(screen.getByRole("navigation", { name: "Primary" })).queryByRole(
        "button",
        { name: "Report a problem" },
      ),
    ).not.toBeInTheDocument();
  });
});

it("opens a custom section by expanding the collapsed rail", () => {
  renderShell(shell(superAdmin, { version: 4, order: ["home", "custom:desk"], hidden: [], custom: [
    { id: "custom:desk", kind: "section", label: "My desk", links: [
      { id: "custom:one", kind: "link", label: "Page directory", destination: { kind: "url", url: "/content" } },
    ] },
  ] }));
  const rail = screen.getByRole("navigation", { name: "Primary" });
  const sidebar = rail.closest("aside")!;
  if (sidebar.getAttribute("data-collapsed") !== "true") fireEvent.click(screen.getByRole("button", { name: "Collapse primary navigation" }));
  expect(sidebar).toHaveAttribute("data-collapsed", "true");
  fireEvent.click(within(rail).getByRole("button", { name: "My desk" }));
  expect(sidebar).toHaveAttribute("data-collapsed", "false");
  expect(within(rail).getByRole("link", { name: "Page directory" })).toBeVisible();
});
