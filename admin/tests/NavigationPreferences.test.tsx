import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationPreferences } from "../src/components/NavigationPreferences";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import {
  NAVIGATION_PREFERENCES_VERSION,
  type NavigationPreferences as StoredNavigationPreferences,
} from "../src/lib/navigation-preferences";
import { NAV_DESTINATIONS, eligibleNavDestinations } from "../src/lib/nav-destinations";
import type { CustomNavLink, CustomNavSection } from "../src/lib/custom-navigation";
import type { Principal } from "../../packages/content-core/src/rbac";
import type { ControlPresentation } from "../src/lib/control-presentation";

const superAdmin = {
  id: "sa",
  grants: [{ role: "super_admin" }],
} as unknown as Principal;

const contributor = {
  id: "co",
  grants: [{ role: "contributor" }],
} as unknown as Principal;

const save = vi.fn();
const reset = vi.fn();

function renderPanel({
  principal = superAdmin,
  stored = null,
  presentation = "text",
}: {
  principal?: Principal;
  stored?: StoredNavigationPreferences | null;
  presentation?: ControlPresentation;
} = {}) {
  return render(
    <ControlPresentationProvider value={presentation}>
      <NavigationPreferences
        eligible={eligibleNavDestinations(principal)}
        onReset={reset}
        onSave={save}
        stored={stored}
      />
    </ControlPresentationProvider>,
  );
}

function arrangedNames(): string[] {
  return within(screen.getByRole("list", { name: "Your rail order" }))
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".nav-preference-name")?.textContent ?? "");
}

function moveControl(direction: "up" | "down", label: string) {
  const trigger = screen.getByRole("button", { name: `Move options for ${label}` });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return screen.getByRole("menuitem", { name: `Move ${direction}` });
}

function ownText(item: Element): string {
  return Array.from(item.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

const station: CustomNavLink = {
  id: "custom:external",
  kind: "link",
  label: "Station reference",
  destination: { kind: "url", url: "https://example.test/station" },
};
const samplePost: CustomNavLink = {
  id: "custom:post",
  kind: "link",
  label: "Sample post",
  destination: { kind: "post", id: "sample-post" },
};
const desk: CustomNavSection = {
  id: "custom:section",
  kind: "section",
  label: "My desk",
  links: [
    { id: "custom:home", kind: "link", label: "Edit home page", destination: { kind: "page", id: "home" } },
    { id: "custom:pages", kind: "link", label: "Page directory", destination: { kind: "url", url: "/content" } },
  ],
};
const spare: CustomNavSection = {
  id: "custom:spare",
  kind: "section",
  label: "Spare section",
  links: [],
};
const markupLink: CustomNavLink = {
  id: "custom:markup",
  kind: "link",
  label: "<img src=x onerror=alert(1)>",
  destination: { kind: "url", url: "https://example.test/markup" },
};

describe("navigation preferences panel", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VITE_LIVE_PRODUCTION_ENABLED", undefined);
    save.mockResolvedValue(undefined);
    reset.mockResolvedValue(undefined);
  });

  it("lists the destinations this account may see, in the approved default order", () => {
    renderPanel();

    expect(arrangedNames()).toEqual(
      NAV_DESTINATIONS.filter((destination) => destination.id !== "live-production").map((destination) => destination.label),
    );
  });

  it("offers the live production pilot after Broadcast schedule only when the build flag is enabled", () => {
    // The pilot task requires public builds to default off; that changes eligibility,
    // while preserving the existing default order of all established destinations.
    vi.stubEnv("VITE_LIVE_PRODUCTION_ENABLED", "true");
    renderPanel();
    const names = arrangedNames();
    expect(names[names.indexOf("Broadcast schedule") + 1]).toBe("Live production");
  });

  it("keeps Broadcast schedule required in Workflow immediately after Activity", () => {
    const activityIndex = NAV_DESTINATIONS.findIndex(
      (destination) => destination.id === "activity",
    );
    const schedule = NAV_DESTINATIONS[activityIndex + 1];

    expect(NAV_DESTINATIONS.find((destination) => destination.id === "schedule")?.group)
      .toBe("Workflow");
    expect(schedule?.id).toBe("schedule");
    expect(schedule?.required).toBe(true);
    expect(NAV_DESTINATIONS.some((destination) =>
      destination.id === "schedule" && destination.group === "Content",
    )).toBe(false);
  });

  it("offers only the destinations a contributor's role allows", () => {
    renderPanel({ principal: contributor });

    expect(arrangedNames()).not.toContain("Staff access");
    expect(arrangedNames()).not.toContain("Admin settings");
    expect(arrangedNames()).toContain("Home");
  });

  it("reorders from the keyboard and says where the destination landed", () => {
    renderPanel();

    const moveUp = moveControl("up", "Media library");
    moveUp.focus();
    fireEvent.click(moveUp);

    expect(arrangedNames().slice(0, 4)).toEqual([
      "Home",
      "Pages",
      "Posts",
      "Media library",
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Media library moved to position 4 of 16.",
    );
  });

  it("keeps focus on a usable control when a move reaches the end of the list", () => {
    renderPanel();

    const moveUp = moveControl("up", "Pages");
    moveUp.focus();
    fireEvent.click(moveUp);

    expect(arrangedNames()[0]).toBe("Pages");
    expect(screen.getByRole("button", { name: "Move: Pages" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Move options for Pages" }));
    expect(screen.queryByRole("menuitem", { name: "Move up" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Move down" })).toBeVisible();
  });

  it("moves an always-shown destination from its grip, keeps focus, and saves only on request", async () => {
    renderPanel();
    const grip = screen.getByRole("button", { name: "Move: Home" });
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(arrangedNames().slice(0, 2)).toEqual(["Pages", "Home"]);
    expect(grip).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Home moved to position 2");
    expect(save).not.toHaveBeenCalled();
    save.mockRejectedValueOnce(new Error("Account save unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await screen.findByText("Account save unavailable");
    expect(arrangedNames().slice(0, 2)).toEqual(["Pages", "Home"]);
    const cancel = screen.getByRole("button", { name: "Cancel changes" });
    cancel.focus();
    fireEvent.click(cancel);
    expect(arrangedNames().slice(0, 2)).toEqual(["Home", "Pages"]);
    expect(grip).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save rail" })).toBeDisabled();
  });

  it("cancels a rail drag without changing the saved or staged order", () => {
    renderPanel();
    const grip = screen.getByRole("button", { name: "Move: Pages" });
    fireEvent.dragStart(grip, { dataTransfer: { setData: vi.fn(), effectAllowed: "move" } });
    expect(grip).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(grip, { key: "Escape" });
    expect(grip).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Move canceled. Order unchanged.");
    expect(arrangedNames().slice(0, 2)).toEqual(["Home", "Pages"]);
    expect(screen.getByRole("button", { name: "Save rail" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });

  it("cancels later edits back to the last completed save", async () => {
    renderPanel();
    fireEvent.keyDown(screen.getByRole("button", { name: "Move: Home" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await screen.findByText("Your rail is saved.");
    fireEvent.keyDown(screen.getByRole("button", { name: "Move: Home" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel changes" }));
    expect(arrangedNames().slice(0, 3)).toEqual(["Pages", "Home", "Posts"]);
    expect(screen.getByRole("button", { name: "Save rail" })).toBeDisabled();
  });

  it("hides a destination and refuses to hide a required one", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Hide: Activity" }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Activity hidden from your navigation. It stays open to you by address.",
    );
    expect(screen.getByRole("button", { name: "Show: Activity" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Hide: Home" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide: Broadcast schedule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide: Admin settings" })).toBeNull();
    const home = within(
      screen.getByRole("list", { name: "Your rail order" }),
    ).getAllByRole("listitem")[0];
    expect(within(home).getByText("Always shown")).toBeVisible();
  });

  it("saves the arrangement as one versioned record for this account", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Hide: Activity" }));
    fireEvent.click(moveControl("up", "Media library"));
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      version: NAVIGATION_PREFERENCES_VERSION,
      custom: [],
      order: [
        "home",
        "pages",
        "posts",
        "media",
        "library",
        "editorial-queue",
        "cuez-storydesk",
        "activity",
        "schedule",
        "resources",
        "staff-profiles",
        "staff-access",
        "analytics",
        "reports",
        "admin-settings",
        "around-nj",
      ],
      hidden: ["activity"],
    });
    expect(await screen.findByText("Your rail is saved.")).toBeVisible();
  });

  it("keeps the arrangement and explains a refused save", async () => {
    save.mockRejectedValue(new Error("Your rail could not be saved. Try again."));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Hide: Activity" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    expect(
      await screen.findByText("Your rail could not be saved. Try again."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Show: Activity" })).toBeVisible();
  });

  it("restores the approved default through a reset that clears the record", async () => {
    renderPanel({
      stored: {
        version: NAVIGATION_PREFERENCES_VERSION,
      custom: [],
        order: ["activity", "home"],
        hidden: ["media"],
      },
    });

    expect(arrangedNames()[0]).toBe("Activity");
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(arrangedNames()).toEqual(
      NAV_DESTINATIONS.filter((destination) => destination.id !== "live-production").map((destination) => destination.label),
    );
    expect(screen.queryByRole("button", { name: "Show: Media library" })).toBeNull();
  });

  it("offers reset only when something has been arranged", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Hide: Activity" }));
    expect(screen.getByRole("button", { name: "Reset to default" })).not.toBeDisabled();
  });

  it("lets the last write win when another tab's arrangement arrives mid-save", async () => {
    // The save is held open, so a competing snapshot from another tab lands while this tab's
    // write is still in flight.
    let settleSave: () => void = () => undefined;
    save.mockReturnValue(
      new Promise<void>((resolve) => {
        settleSave = resolve;
      }),
    );
    const view = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Hide: Activity" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    // Another tab reorders the rail while the save is pending. The stored record is the truth
    // until this tab's own write lands, so the competing arrangement shows.
    const competing = {
      version: NAVIGATION_PREFERENCES_VERSION,
      custom: [],
      order: ["staff-access", "home"],
      hidden: [],
    };
    view.rerender(
      <ControlPresentationProvider value="text">
        <NavigationPreferences
          eligible={eligibleNavDestinations(superAdmin)}
          onReset={reset}
          onSave={save}
          stored={competing}
        />
      </ControlPresentationProvider>,
    );
    expect(arrangedNames()[0]).toBe("Staff access");

    settleSave();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Show: Activity" })).toBeVisible(),
    );

    // The write this tab completed is what the account now has, so it is what the panel shows,
    // with nothing left presented as an unsaved edit.
    expect(arrangedNames()[0]).toBe("Home");
    expect(screen.getByRole("button", { name: "Save rail" })).toBeDisabled();
    expect(screen.getByText("Your rail is saved.")).toBeVisible();

    // The listener then delivers this tab's own record. Nothing moves and nothing goes dirty.
    view.rerender(
      <ControlPresentationProvider value="text">
        <NavigationPreferences
          eligible={eligibleNavDestinations(superAdmin)}
          onReset={reset}
          onSave={save}
          stored={save.mock.calls[0][0]}
        />
      </ControlPresentationProvider>,
    );
    expect(arrangedNames()[0]).toBe("Home");
    expect(screen.getByRole("button", { name: "Show: Activity" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save rail" })).toBeDisabled();
  });

  it("offers reset while a stored record still holds destinations this role cannot see", () => {
    // A demoted account: the record still reorders and hides destinations the role lost, so the
    // visible rows resolve to the default even though an arrangement is stored.
    renderPanel({
      principal: contributor,
      stored: {
        version: NAVIGATION_PREFERENCES_VERSION,
      custom: [],
        order: ["staff-access", "admin-settings"],
        hidden: ["staff-access", "activity"],
      },
    });

    expect(arrangedNames()).toEqual(
      eligibleNavDestinations(contributor).map((destination) => destination.label),
    );
    expect(screen.getByRole("button", { name: "Reset to default" })).not.toBeDisabled();
  });

  it("holds the row controls while a reset is in flight", async () => {
    let settleReset: () => void = () => undefined;
    reset.mockReturnValue(
      new Promise<void>((resolve) => {
        settleReset = resolve;
      }),
    );
    renderPanel({
      stored: {
        version: NAVIGATION_PREFERENCES_VERSION,
      custom: [],
        order: ["activity", "home"],
        hidden: ["media"],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    expect(screen.getByRole("button", { name: "Move: Media library" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move options for Media library" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Show: Media library" })).toBeDisabled();

    settleReset();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Hide: Media library" })).not.toBeDisabled(),
    );
    expect(arrangedNames()).toEqual(
      NAV_DESTINATIONS.filter((destination) => destination.id !== "live-production").map((destination) => destination.label),
    );
  });

  it("holds the row controls while a save is in flight", () => {
    save.mockReturnValue(new Promise<void>(() => {}));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Hide: Activity" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    expect(screen.getByRole("button", { name: "Move: Pages" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move options for Pages" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Hide: Pages" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show: Activity" })).toBeDisabled();
  });

  it("keeps every control's action name in icon mode", () => {
    renderPanel({ presentation: "icons" });

    expect(moveControl("up", "Media library")).toBeVisible();
    expect(moveControl("down", "Media library")).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide: Media library" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save rail" })).toBeVisible();
  });

  it("names each plank and span before reset, with span planks nested beneath", () => {
    renderPanel({
      stored: {
        version: NAVIGATION_PREFERENCES_VERSION,
        order: [],
        hidden: ["custom:pages"],
        custom: [station, desk, samplePost, spare, markupLink],
      },
    });

    // Sample post starts under My desk. One move up places it between Station reference and My desk.
    fireEvent.click(moveControl("up", "Sample post"));
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    const group = screen.getByRole("group", { name: "Confirm rail reset" });
    expect(within(group).getByText(
      "Reset removes all your planks and spans, stops sharing them, and restores the built-in order.",
    )).toBeVisible();
    const listed = within(group).getByRole("list", { name: "Planks and spans this reset removes" });
    const top = listed.querySelectorAll(":scope > li");
    expect(Array.from(top).map(ownText)).toEqual([
      station.label,
      samplePost.label,
      desk.label,
      spare.label,
      markupLink.label,
    ]);
    expect(top[0]?.querySelector("ul")).toBeNull();
    expect(top[1]?.querySelector("ul")).toBeNull();
    expect(Array.from(top[2]?.querySelectorAll(":scope > ul > li") ?? []).map((item) => item.textContent))
      .toEqual(desk.links.map((link) => link.label));
    expect(top[3]?.querySelector("ul")).toBeNull();
    expect(within(group).getByText(markupLink.label)).toBeVisible();
    expect(group.querySelector("img, script")).toBeNull();
    expect(reset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove your planks and spans and reset" }));
    return waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
  });

  it("keeps the short reset message when no planks or spans remain", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Add to your rail" }));
    fireEvent.change(screen.getByLabelText("Label (required)"), { target: { value: "Draft link" } });
    fireEvent.change(screen.getByLabelText("Address (required)"), { target: { value: "https://example.test/draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply plank" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Draft link" }));

    const group = screen.getByRole("group", { name: "Confirm rail reset" });
    expect(within(group).getByText(
      "Reset removes all your planks and spans, stops sharing them, and restores the built-in order.",
    )).toBeVisible();
    expect(within(group).queryByRole("list")).toBeNull();
    expect(reset).not.toHaveBeenCalled();
  });

  it("confirms a reset after the only saved plank is deleted on screen", () => {
    renderPanel({
      stored: {
        version: NAVIGATION_PREFERENCES_VERSION,
        order: [],
        hidden: [],
        custom: [station],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete Station reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    const listed = within(screen.getByRole("group", { name: "Confirm rail reset" }))
      .getByRole("list", { name: "Planks and spans this reset removes" });
    expect(Array.from(listed.querySelectorAll(":scope > li")).map(ownText)).toEqual([station.label]);
    expect(reset).not.toHaveBeenCalled();
  });

  it("lists a saved plank that was deleted before the reset confirmation opens", () => {
    renderPanel({
      stored: {
        version: NAVIGATION_PREFERENCES_VERSION,
        order: [],
        hidden: [],
        custom: [station, samplePost],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete Station reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    const listed = within(screen.getByRole("group", { name: "Confirm rail reset" }))
      .getByRole("list", { name: "Planks and spans this reset removes" });
    expect(Array.from(listed.querySelectorAll(":scope > li")).map(ownText)).toEqual([
      samplePost.label,
      station.label,
    ]);
    expect(reset).not.toHaveBeenCalled();
  });

  it("keeps a saved plank in the reset list when deletion happens after confirmation opens", () => {
    renderPanel({
      stored: {
        version: NAVIGATION_PREFERENCES_VERSION,
        order: [],
        hidden: [],
        custom: [station],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Station reference" }));

    const group = screen.getByRole("group", { name: "Confirm rail reset" });
    expect(within(group).getByText(
      "Reset removes all your planks and spans, stops sharing them, and restores the built-in order.",
    )).toBeVisible();
    const listed = within(group).getByRole("list", { name: "Planks and spans this reset removes" });
    expect(Array.from(listed.querySelectorAll(":scope > li")).map(ownText)).toEqual([station.label]);
    expect(reset).not.toHaveBeenCalled();
  });

  it("shows a staged rename once in the reset list", () => {
    renderPanel({
      stored: {
        version: NAVIGATION_PREFERENCES_VERSION,
        order: [],
        hidden: [],
        custom: [station],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit Station reference" }));
    fireEvent.change(screen.getByLabelText("Label (required)"), { target: { value: "Station desk" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply plank" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    const listed = within(screen.getByRole("group", { name: "Confirm rail reset" }))
      .getByRole("list", { name: "Planks and spans this reset removes" });
    expect(Array.from(listed.querySelectorAll(":scope > li")).map(ownText)).toEqual(["Station desk"]);
    expect(within(listed).queryByText(station.label)).toBeNull();
  });
});
