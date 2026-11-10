import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { NavigationPreferences } from "../src/components/NavigationPreferences";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import { customNavDestinations } from "../src/lib/custom-nav-destinations";
import type { CustomNavItem, CustomNavLink } from "../src/lib/custom-navigation";
import { eligibleNavDestinations } from "../src/lib/nav-destinations";
import {
  parseNavigationPreferences,
  type NavigationPreferences as StoredNavigationPreferences,
} from "../src/lib/navigation-preferences";
import {
  capAdoptedShares,
  MAX_SHARED_NAVIGATION_ENTRIES,
  SHARED_ITEM_DELETED,
  SHARED_ITEM_UNSHARED,
  parseNavigationShare,
  sharedCapMessage,
  sharedEntriesFit,
  type NavigationShare,
} from "../src/lib/navigation-shares";
import { ShellLayout } from "../src/routes/ShellLayout";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import type { RouteHandle } from "../src/routes/buildRoutes";
import type { Principal } from "../../packages/content-core/src/rbac";

const superAdmin = { id: "sa", grants: [{ role: "super_admin" }] } as unknown as Principal;
const staff = { id: "st", grants: [{ role: "staff" }] } as unknown as Principal;
const save = vi.fn();
const reset = vi.fn();
const onShare = vi.fn();

function link(id: string, label: string, url = "https://example.test/handbook"): CustomNavLink {
  return { id, kind: "link", label, icon: "link", destination: { kind: "url", url } };
}

function share(item: CustomNavItem, extra: Partial<NavigationShare> = {}): NavigationShare {
  return {
    id: item.id,
    ownerUid: "ed",
    ownerName: "Sample editor",
    status: "active",
    item,
    ...extra,
  };
}

function stored(partial: Partial<StoredNavigationPreferences> = {}): StoredNavigationPreferences {
  return { version: 4, order: [], hidden: [], custom: [], ...partial };
}

function renderPanel({
  preferences = stored(),
  shares = [],
  sharesReady = true,
  viewerUid = "viewer",
  principal = superAdmin,
}: {
  preferences?: StoredNavigationPreferences | null;
  shares?: readonly NavigationShare[];
  sharesReady?: boolean;
  viewerUid?: string;
  principal?: Principal;
} = {}) {
  return render(
    <ControlPresentationProvider value="text">
      <NavigationPreferences
        eligible={eligibleNavDestinations(principal)}
        onReset={reset}
        onSave={save}
        onShare={onShare}
        shares={shares}
        sharesReady={sharesReady}
        stored={preferences}
        viewerUid={viewerUid}
      />
    </ControlPresentationProvider>,
  );
}

function orderList() {
  return screen.getByRole("list", { name: "Your rail order" });
}

function sharedList() {
  return screen.getByRole("list", { name: "Shared planks" });
}

describe("shared navigation settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    save.mockResolvedValue(undefined);
    reset.mockResolvedValue(undefined);
    onShare.mockResolvedValue(undefined);
  });

  it("lists the owner and turns a shared item on and off for this rail", async () => {
    const notes = link("custom:notes", "Desk notes", "/resources");
    const own = link("custom:external", "Station reference", "https://example.test/station");
    const view = renderPanel({
      viewerUid: "sa",
      preferences: stored({ custom: [own] }),
      shares: [share(own, { ownerUid: "sa", ownerName: "Jordan Avery" }), share(notes)],
    });

    const sharedItems = sharedList();
    expect(within(sharedItems).getByText("Shared by Jordan Avery")).toBeInTheDocument();
    expect(within(sharedItems).getByText("Shared by Sample editor")).toBeInTheDocument();
    expect(within(sharedItems).queryByRole("button", { name: "Turn on Station reference" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop sharing Station reference" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Turn on Desk notes" }));
    expect(within(orderList()).getByText("Desk notes")).toBeInTheDocument();
    expect(within(orderList()).queryByRole("button", { name: "Edit Desk notes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const turnedOn = save.mock.calls[0][0] as StoredNavigationPreferences;
    expect(turnedOn.shared).toEqual(["custom:notes"]);
    expect(turnedOn.custom).toEqual([own]);
    expect(turnedOn.order.at(-1)).toBe("custom:notes");

    view.rerender(
      <ControlPresentationProvider value="text">
        <NavigationPreferences
          eligible={eligibleNavDestinations(superAdmin)}
          onReset={reset}
          onSave={save}
          onShare={onShare}
          shares={[share(own, { ownerUid: "sa", ownerName: "Jordan Avery" }), share(notes)]}
          stored={turnedOn}
          viewerUid="sa"
        />
      </ControlPresentationProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Turn off Desk notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    const turnedOff = save.mock.calls[1][0] as StoredNavigationPreferences;
    expect(turnedOff.shared).toEqual([]);
    expect(turnedOff.order.filter((id) => id === "custom:notes")).toEqual([]);
    expect(turnedOff.custom).toEqual([own]);
  });

  function rowLabels() {
    return [...orderList().querySelectorAll(".nav-preference-name")].map((node) => node.textContent);
  }

  it("keeps an adopted plank in place and stays clean after an unchanged personal plank apply", () => {
    const own = link("custom:external", "Station reference");
    const handbook = link("custom:handbook", "Newsroom handbook");
    renderPanel({
      preferences: stored({ custom: [own], shared: [handbook.id], order: ["home", handbook.id, own.id] }),
      shares: [share(handbook)],
    });
    const before = rowLabels();
    fireEvent.click(screen.getByRole("button", { name: "Edit Station reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply plank" }));
    expect(rowLabels()).toEqual(before);
    expect(screen.getByRole("button", { name: "Save rail" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["stored", "enabled", "disabled"] as const)("preserves %s shared-plank draft state through personal edit, save and reload", async state => {
    const own = link("custom:external", "Station reference");
    const handbook = link("custom:handbook", "Newsroom handbook");
    const shares = [share(handbook)];
    const view = renderPanel({
      preferences: stored({ custom: [own], order: ["home", handbook.id, own.id],
        shared: state === "enabled" ? [] : [handbook.id], hidden: state === "stored" ? [handbook.id] : [] }),
      shares,
    });
    if (state === "enabled") {
      fireEvent.click(screen.getByRole("button", { name: "Turn on Newsroom handbook" }));
      fireEvent.keyDown(screen.getByRole("button", { name: "Move: Newsroom handbook" }), { key: "ArrowUp" });
    } else if (state === "disabled") {
      fireEvent.click(screen.getByRole("button", { name: "Turn off Newsroom handbook" }));
    }
    const expected = rowLabels().map(label => label === own.label ? "Station desk" : label);
    fireEvent.click(screen.getByRole("button", { name: "Edit Station reference" }));
    fireEvent.change(screen.getByLabelText("Label (required)"), { target: { value: "Station desk" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply plank" }));
    expect(rowLabels()).toEqual(expected);
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const written = save.mock.calls[0][0] as StoredNavigationPreferences;
    expect(written.shared).toEqual(state === "disabled" ? [] : [handbook.id]);
    expect(written.hidden.includes(handbook.id)).toBe(state === "stored");
    expect(written.custom).toEqual([{ ...own, label: "Station desk" }]);
    view.unmount();
    renderPanel({ preferences: written, shares });
    expect(rowLabels()).toEqual(expected);
  });

  it("keeps the draft and the open editor when a share snapshot arrives", () => {
    const own = link("custom:external", "Station reference", "https://example.test/station");
    const handbook = link("custom:handbook", "Newsroom handbook");
    const preferences = stored({
      custom: [own],
      order: ["home", "custom:handbook", own.id],
      shared: ["custom:handbook"],
    });
    const view = renderPanel({ preferences, shares: [share(handbook)] });
    fireEvent.keyDown(screen.getByRole("button", { name: "Move: Home" }), { key: "ArrowDown" });
    const moved = rowLabels();
    expect(moved.indexOf("Home")).toBeGreaterThan(0);
    const before = moved.filter((label) => label !== "Newsroom handbook");
    fireEvent.click(screen.getByRole("button", { name: "Edit Station reference" }));
    fireEvent.change(screen.getByLabelText("Label (required)"), { target: { value: "Station desk" } });

    const edited = link("custom:handbook", "Updated handbook");
    view.rerender(
      <ControlPresentationProvider value="text">
        <NavigationPreferences
          eligible={eligibleNavDestinations(superAdmin)}
          onReset={reset}
          onSave={save}
          onShare={onShare}
          shares={[share(edited)]}
          stored={preferences}
          viewerUid="viewer"
        />
      </ControlPresentationProvider>,
    );

    expect(screen.getByLabelText("Label (required)")).toHaveValue("Station desk");
    expect(screen.getByRole("button", { name: "Apply plank" })).toBeInTheDocument();
    expect(rowLabels()).toContain("Updated handbook");
    expect(rowLabels().filter((label) => label !== "Updated handbook")).toEqual(before);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it.each(["renamed", "unshared", "deleted"] as const)("cancels personal changes using the current %s shared plank", change => {
    const own = link("custom:external", "Station reference");
    const handbook = link("custom:handbook", "Newsroom handbook");
    const preferences = stored({
      custom: [own], order: ["home", handbook.id, own.id], shared: [handbook.id],
    });
    const view = renderPanel({ preferences, shares: [share(handbook)] });
    const savedLabels = rowLabels();
    fireEvent.keyDown(screen.getByRole("button", { name: "Move: Home" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Hide: Station reference" }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    const current = change === "renamed"
      ? share(link(handbook.id, "Updated handbook"))
      : share(handbook, { status: "removed", removedReason: change });
    view.rerender(
      <ControlPresentationProvider value="text">
        <NavigationPreferences eligible={eligibleNavDestinations(superAdmin)} onReset={reset}
          onSave={save} onShare={onShare} shares={[current]} stored={preferences} viewerUid="viewer" />
      </ControlPresentationProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel changes" }));

    const expected = savedLabels.flatMap(label => label !== handbook.label ? [label]
      : change === "renamed" ? ["Updated handbook"] : []);
    expect(rowLabels()).toEqual(expected);
    expect(within(orderList()).queryByText("Newsroom handbook")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide: Station reference" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save rail" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel changes" })).toBeDisabled();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("shows an owner edit in the settings list and the order list", async () => {
    const item = link("custom:handbook", "Newsroom handbook");
    const preferences = stored({ order: ["custom:handbook"], shared: ["custom:handbook"] });
    const view = renderPanel({ preferences, shares: [share(item)] });
    expect(within(orderList()).getByText("Newsroom handbook")).toBeInTheDocument();

    const edited = link("custom:handbook", "Updated handbook");
    view.rerender(
      <ControlPresentationProvider value="text">
        <NavigationPreferences
          eligible={eligibleNavDestinations(superAdmin)}
          onReset={reset}
          onSave={save}
          onShare={onShare}
          shares={[share(edited)]}
          stored={preferences}
          viewerUid="viewer"
        />
      </ControlPresentationProvider>,
    );
    await waitFor(() => expect(within(orderList()).getByText("Updated handbook")).toBeInTheDocument());
    expect(within(sharedList()).getByText("Updated handbook")).toBeInTheDocument();
    expect(within(sharedList()).getByText("Shared by Sample editor")).toBeInTheDocument();
  });

  it("removes an unshared or deleted item from the rail list and says why", () => {
    const unshared = link("custom:retired", "Old bulletin", "https://example.test/bulletin");
    const deleted = link("custom:gone", "Closed desk", "https://example.test/closed");
    renderPanel({
      preferences: stored({
        order: ["custom:retired", "custom:gone"],
        shared: ["custom:retired", "custom:gone"],
      }),
      shares: [
        share(unshared, { status: "removed", removedReason: "unshared" }),
        share(deleted, { status: "removed", removedReason: "deleted" }),
      ],
    });

    expect(within(sharedList()).getByText(SHARED_ITEM_UNSHARED)).toBeInTheDocument();
    expect(within(sharedList()).getByText(SHARED_ITEM_DELETED)).toBeInTheDocument();
    expect(SHARED_ITEM_UNSHARED).toBe("The owner stopped sharing this plank.");
    expect(SHARED_ITEM_DELETED).toBe("The owner deleted this plank.");
    expect(within(orderList()).queryByText("Old bulletin")).toBeNull();
    expect(within(orderList()).queryByText("Closed desk")).toBeNull();
  });

  it.each(["link", "section"] as const)("keeps the owner-removal explanation when an adopted %s is removed live", async kind => {
    const handbook = link("custom:handbook", "Newsroom handbook");
    const item: CustomNavItem = kind === "link" ? handbook
      : { id: "custom:desk", kind: "section", label: "Desk", icon: "folder", links: [handbook] };
    const own = link("custom:external", "Station reference");
    const preferences = stored({ custom: [own], order: [item.id, own.id], shared: [item.id] });
    const view = renderPanel({ preferences, shares: [share(item)] });
    expect(within(orderList()).getByText(item.label)).toBeInTheDocument();

    // The active listener drops the share before the referenced tombstone read resolves.
    view.rerender(
      <ControlPresentationProvider value="text">
        <NavigationPreferences eligible={eligibleNavDestinations(superAdmin)} onReset={reset}
          onSave={save} onShare={onShare} shares={[]} sharesReady={false} stored={preferences} viewerUid="viewer" />
      </ControlPresentationProvider>,
    );
    const removed = parseNavigationShare(item.id, {
      ownerUid: "ed", ownerName: "Sample editor", item,
      status: "removed", removedReason: "owner_removed",
    });
    expect(removed).not.toBeNull();
    view.rerender(
      <ControlPresentationProvider value="text">
        <NavigationPreferences eligible={eligibleNavDestinations(superAdmin)} onReset={reset}
          onSave={save} onShare={onShare} shares={[removed!]} stored={preferences} viewerUid="viewer" />
      </ControlPresentationProvider>,
    );

    expect(within(orderList()).queryByText(item.label)).not.toBeInTheDocument();
    expect(within(sharedList()).getByText("The owner no longer has staff access.")).toBeInTheDocument();
    expect(within(sharedList()).queryByRole("button", { name: new RegExp(`Turn (on|off) ${item.label}`) })).toBeNull();
    expect(screen.getByRole("button", { name: "Save rail" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Hide: Station reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel changes" }));
    expect(within(sharedList()).getByText("The owner no longer has staff access.")).toBeInTheDocument();
    expect(within(orderList()).queryByText(item.label)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save rail" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Hide: Station reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ shared: [], custom: [own] })));
  });

  it("hides a shared CMS screen the viewer cannot open and still lists it in settings", () => {
    const analytics = link("custom:analytics", "Audience analytics", "/analytics");
    const handbook = link("custom:handbook", "Newsroom handbook");
    const preferences = stored({
      order: ["custom:analytics", "custom:handbook"],
      shared: ["custom:analytics", "custom:handbook"],
    });
    renderPanel({ preferences, shares: [share(analytics), share(handbook)], principal: staff });
    expect(within(orderList()).getByText("Audience analytics")).toBeInTheDocument();
    expect(customNavDestinations({ ...preferences, custom: [analytics] }, staff)).toEqual([]);
    expect(customNavDestinations({ ...preferences, custom: [analytics] }, superAdmin).map((entry) => entry.to)).toEqual(["/analytics"]);
    expect(customNavDestinations({ ...preferences, custom: [handbook] }, staff).map((entry) => entry.to)).toEqual(["https://example.test/handbook"]);
  });

  it("keeps ten personal entries and still accepts one shared id", () => {
    const custom = Array.from({ length: 10 }, (_, index) => link(`custom:own-${index}`, "Own link"));
    const record = {
      version: 4,
      order: ["home", ...custom.map((entry) => entry.id), "custom:share-0"],
      hidden: [],
      custom,
      shared: ["custom:share-0"],
    };
    expect(parseNavigationPreferences(record)).toEqual(record);
    expect(parseNavigationPreferences({ ...record, custom: [...custom, link("custom:own-10", "Extra")] })).toBeNull();
    const enabled = Array.from({ length: MAX_SHARED_NAVIGATION_ENTRIES }, (_, index) => `custom:share-${index}`);
    expect(sharedEntriesFit(enabled, link("custom:extra", "Extra"))).toBe(false);
    expect(sharedEntriesFit(enabled.slice(0, 9), link("custom:extra", "Extra"))).toBe(true);
  });

  it("keeps adopted ids when the share list is not ready", async () => {
    renderPanel({
      sharesReady: false,
      shares: [],
      preferences: stored({
        order: ["home", "custom:notes"],
        shared: ["custom:notes"],
      }),
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "Move: Home" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0][0] as StoredNavigationPreferences;
    expect(saved.shared).toEqual(["custom:notes"]);
  });

  it("keeps stored order and hidden state for unresolved shares while the list is not ready", async () => {
    renderPanel({
      sharesReady: false,
      shares: [],
      preferences: stored({
        order: ["home", "custom:notes", "custom:child", "pages"],
        hidden: ["custom:notes", "custom:child"],
        shared: ["custom:notes", "custom:child"],
      }),
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "Move: Home" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0][0] as StoredNavigationPreferences;
    const pagesIndex = saved.order.indexOf("pages");
    const homeIndex = saved.order.indexOf("home");
    expect(pagesIndex).toBeGreaterThanOrEqual(0);
    expect(homeIndex).toBeGreaterThan(pagesIndex);
    expect(saved.order.slice(homeIndex, homeIndex + 3)).toEqual(["home", "custom:notes", "custom:child"]);
    expect(saved.hidden).toEqual(["custom:notes", "custom:child"]);
    expect(saved.shared).toEqual(["custom:notes", "custom:child"]);
    expect(saved.order.at(-1)).not.toBe("custom:child");
  });

  it("keeps a shown adopted plank visible when shares are not ready", async () => {
    const notes = link("custom:notes", "Desk notes");
    const preferences = stored({
      order: ["home", "custom:notes"],
      hidden: ["custom:notes"],
      shared: ["custom:notes"],
    });
    const shares = [share(notes)];
    const view = renderPanel({ preferences, shares });
    fireEvent.click(screen.getByRole("button", { name: "Show: Desk notes" }));
    view.rerender(
      <ControlPresentationProvider value="text">
        <NavigationPreferences
          eligible={eligibleNavDestinations(superAdmin)}
          onReset={reset}
          onSave={save}
          onShare={onShare}
          shares={shares}
          sharesReady={false}
          stored={preferences}
          viewerUid="viewer"
        />
      </ControlPresentationProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0][0] as StoredNavigationPreferences;
    expect(saved.hidden).toEqual([]);
    expect(saved.order).toContain("custom:notes");
    expect(saved.shared).toEqual(["custom:notes"]);
  });

  it("does not count the viewer's own span or a custom item toward the shared cap", () => {
    const children = Array.from({ length: 9 }, (_, index) => link(`custom:own-${index}`, `Own ${index}`));
    const own = { id: "custom:mine", kind: "section" as const, label: "Mine", icon: "folder" as const, links: children };
    const incoming = link("custom:incoming", "Incoming");
    const enabled = [own.id, ...children.map((entry) => entry.id)];
    const ownShare = share(own, { ownerUid: "viewer" });
    expect(sharedEntriesFit(enabled, incoming, [ownShare, share(incoming)], "viewer", new Set([own.id]))).toBe(true);
    expect(capAdoptedShares(
      [ownShare, share(incoming)],
      stored({ custom: [own], shared: [...enabled, incoming.id] }),
      "viewer",
    ).items.map((item) => item.id)).toEqual([incoming.id]);

    const collided = share(own);
    expect(sharedEntriesFit(enabled, incoming, [collided, share(incoming)], "viewer", new Set([own.id]))).toBe(true);
    expect(capAdoptedShares(
      [collided, share(incoming)],
      stored({ custom: [own], shared: [...enabled, incoming.id] }),
      "viewer",
    ).items.map((item) => item.id)).toEqual([incoming.id]);
  });

  it("keeps an adopted span inside ten entries and stops counting removed planks", async () => {
    const children = Array.from({ length: 10 }, (_, index) => link(`custom:child-${index}`, `Child ${index}`, `https://example.test/child-${index}`));
    const desk = { id: "custom:desk", kind: "section" as const, label: "Desk", icon: "folder" as const, links: children };
    const childIds = children.map((entry) => entry.id);
    const enabled = stored({ order: ["custom:desk"], shared: ["custom:desk", ...childIds] });
    const full = capAdoptedShares([share(desk)], enabled, "viewer");
    expect(full.items).toHaveLength(1);
    expect(full.items[0]?.kind).toBe("section");
    if (full.items[0]?.kind !== "section") return;
    expect(full.items[0].links.map((entry) => entry.id)).toEqual(childIds.slice(0, 9));
    expect(full.omissions).toEqual([{ id: "custom:desk", label: "Desk", omittedChildren: 1 }]);

    const remaining = children.slice(2);
    const afterRemoval = capAdoptedShares([share({ ...desk, links: remaining })], enabled, "viewer");
    expect(afterRemoval.omissions).toEqual([]);
    expect(afterRemoval.items[0]?.kind).toBe("section");
    if (afterRemoval.items[0]?.kind === "section") {
      expect(afterRemoval.items[0].links.map((entry) => entry.id)).toEqual(remaining.map((entry) => entry.id));
    }

    const earlier = Array.from({ length: 8 }, (_, index) => link(`custom:link-${index}`, `Link ${index}`, `https://example.test/link-${index}`));
    const span = { ...desk, links: children.slice(0, 3) };
    const mixed = stored({
      shared: [...earlier.map((entry) => entry.id), span.id, ...span.links.map((entry) => entry.id)],
    });
    const capped = capAdoptedShares([...earlier.map((entry) => share(entry)), share(span)], mixed, "viewer");
    expect(capped.items.map((entry) => entry.id)).toEqual([...earlier.map((entry) => entry.id), span.id]);
    expect(capped.items[8]?.kind).toBe("section");
    if (capped.items[8]?.kind === "section") expect(capped.items[8].links.map((entry) => entry.id)).toEqual(["custom:child-0"]);
    expect(capped.omissions).toEqual([{ id: "custom:desk", label: "Desk", omittedChildren: 2 }]);
    expect(sharedCapMessage(full.omissions[0], true)).toBe("Desk is over the 10 shared planks and spans on your rail. 1 extra plank stays off your rail.");

    const view = renderPanel({
      preferences: stored({ order: ["custom:desk"], shared: ["custom:desk"] }),
      shares: [share(desk)],
      principal: staff,
      viewerUid: "st",
    });
    expect(screen.getByText("Desk is over the 10 shared planks and spans on your rail. 1 extra plank stays off your rail.")).toBeInTheDocument();
    view.unmount();

    renderRail({
      principal: staff,
      user: { uid: "st", email: "account-26@example.org", displayName: "Staff Member" },
      userDoc: {
        role: null,
        preferences: { navigation: stored({ order: ["custom:desk"], shared: ["custom:desk"] }) },
      },
      signOut: vi.fn(),
      navigationShares: [share(desk)],
    });
    const rail = await screen.findByRole("navigation", { name: "Primary" });
    fireEvent.click(within(rail).getByRole("button", { name: "Show Desk actions" }));
    expect(within(rail).getAllByRole("link", { name: /Open Child / })).toHaveLength(9);
    expect(within(rail).getByRole("link", { name: "Open Child 0 in a new tab" })).toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: "Open Child 9 in a new tab" })).toBeNull();
  });

  it("lists an own plank in the reset confirmation and omits an adopted plank", () => {
    const own = link("custom:external", "Station reference", "https://example.test/station");
    const adopted = link("custom:notes", "Desk notes", "/resources");
    renderPanel({
      viewerUid: "sa",
      preferences: stored({
        custom: [own],
        order: [adopted.id, own.id],
        shared: [adopted.id],
      }),
      shares: [share(adopted)],
    });

    expect(within(orderList()).getByText("Desk notes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete Station reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    const group = screen.getByRole("group", { name: "Confirm rail reset" });
    expect(within(group).getByText(
      "Reset removes all your planks and spans, stops sharing them, and restores the built-in order.",
    )).toBeVisible();
    const listed = within(group).getByRole("list", { name: "Planks and spans this reset removes" });
    expect(Array.from(listed.querySelectorAll(":scope > li")).map((item) => item.textContent?.trim())).toEqual([
      "Station reference",
    ]);
    expect(reset).not.toHaveBeenCalled();
  });
});

function renderRail(data: ShellData) {
  const router = createMemoryRouter(
    [{
      path: "/",
      element: <ShellLayout />,
      children: [
        { index: true, element: <p>Home surface</p>, handle: { title: "Home", description: "" } satisfies RouteHandle },
        { path: "guide", element: <p>Guide surface</p>, handle: { title: "Guide", description: "" } satisfies RouteHandle },
      ],
    }],
    { initialEntries: ["/"] },
  );
  return render(<ShellProvider value={data}><RouterProvider router={router} /></ShellProvider>);
}

describe("shared navigation rail", () => {
  it("shows a permitted shared link and hides a CMS screen the staff account cannot open", async () => {
    const analytics = link("custom:analytics", "Audience analytics", "/analytics");
    const handbook = link("custom:handbook", "Newsroom handbook");
    renderRail({
      principal: staff,
      user: { uid: "st", email: "account-26@example.org", displayName: "Staff Member" },
      userDoc: {
        role: null,
        preferences: {
          navigation: stored({
            order: ["custom:handbook", "custom:analytics"],
            shared: ["custom:handbook", "custom:analytics"],
          }),
        },
      },
      signOut: vi.fn(),
      navigationShares: [share(analytics), share(handbook)],
    });

    const rail = await screen.findByRole("navigation", { name: "Primary" });
    const handbookLink = within(rail).getByRole("link", { name: "Open Newsroom handbook in a new tab" });
    expect(handbookLink).toHaveAttribute("href", "https://example.test/handbook");
    expect(handbookLink).toHaveAttribute("target", "_blank");
    expect(handbookLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(rail).queryByRole("link", { name: "Audience analytics" })).toBeNull();
    expect(within(rail).queryByRole("link", { name: "Open Audience analytics in a new tab" })).toBeNull();
    expect(within(rail).queryByRole("link", { name: "Analytics" })).toBeNull();
  });
});
