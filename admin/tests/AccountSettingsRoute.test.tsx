import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSettingsRoute } from "../src/routes/AccountSettingsRoute";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";

const storeMocks = vi.hoisted(() => ({
  saveControlPresentation: vi.fn(),
}));

const navigationMocks = vi.hoisted(() => ({
  saveNavigationPreferences: vi.fn(),
  resetNavigationPreferences: vi.fn(),
  shareNavigationItem: vi.fn(),
  shareGate: null as null | { shares: readonly unknown[]; ready: boolean },
}));

vi.mock("../src/lib/control-presentation-store", () => ({
  saveControlPresentation: storeMocks.saveControlPresentation,
}));

vi.mock("../src/lib/navigation-preferences-store", () => ({
  saveNavigationPreferences: navigationMocks.saveNavigationPreferences,
  resetNavigationPreferences: navigationMocks.resetNavigationPreferences,
  shareNavigationItem: navigationMocks.shareNavigationItem,
}));

vi.mock("../src/lib/navigation-shares-store", () => ({
  useNavigationShares: (injected: readonly unknown[] | undefined, live: boolean) => {
    if (navigationMocks.shareGate) return navigationMocks.shareGate;
    if (injected) return { shares: injected, ready: true };
    return { shares: [], ready: !live };
  },
}));

function shellWithPreference(value: unknown): ShellData {
  return {
    principal: { id: "editor-1", grants: [{ role: "contributor" }] },
    user: {
      uid: "editor-1",
      email: "account-8@example.org",
      displayName: "Editor One",
    },
    userDoc: {
      role: null,
      preferences: {
        display: { controlPresentation: value },
      },
    },
    signOut: vi.fn(),
  } as ShellData;
}

function renderRoute(value: unknown = "text") {
  return render(
    <ShellProvider value={shellWithPreference(value)}>
      <AccountSettingsRoute />
    </ShellProvider>,
  );
}

describe("account settings route", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    navigationMocks.shareGate = null;
    navigationMocks.saveNavigationPreferences.mockResolvedValue(undefined);
    navigationMocks.resetNavigationPreferences.mockResolvedValue(undefined);
  });

  it("uses native radio choices and the icon-first baseline", () => {
    renderRoute("unexpected");

    const group = screen.getByRole("group", { name: "Control presentation" });
    expect(within(group).getByRole("radio", { name: "Icons" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Text labels" })).not.toBeChecked();
    expect(screen.getByLabelText("Control presentation preview")).toHaveAttribute(
      "data-presentation",
      "icons",
    );
  });

  it("previews and saves the selected value through the exact account boundary", async () => {
    storeMocks.saveControlPresentation.mockResolvedValue(undefined);
    renderRoute();

    fireEvent.click(screen.getByRole("radio", { name: "Icons" }));
    expect(screen.getByLabelText("Control presentation preview")).toHaveAttribute(
      "data-presentation",
      "icons",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save display preference" }));

    await waitFor(() => {
      expect(storeMocks.saveControlPresentation).toHaveBeenCalledWith(
        "editor-1",
        "icons",
      );
    });
    expect(
      (await screen.findByText("Display preference saved.")).closest(
        '[role="status"]',
      ),
    ).toHaveTextContent("Display preference saved.");
    expect(screen.getByRole("button", { name: "Save display preference" })).toBeDisabled();
  });

  it("restores the last confirmed value and shows an inline error after failure", async () => {
    storeMocks.saveControlPresentation.mockRejectedValue(
      new Error("Your display preference could not be stored. Try again."),
    );
    renderRoute();

    fireEvent.click(screen.getByRole("radio", { name: "Icons" }));
    fireEvent.click(screen.getByRole("button", { name: "Save display preference" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your display preference could not be stored. Try again.",
    );
    expect(screen.getByRole("radio", { name: "Text labels" })).toBeChecked();
    expect(screen.getByLabelText("Control presentation preview")).toHaveAttribute(
      "data-presentation",
      "text",
    );
  });

  it("keeps the confirmed value and error after an optimistic write rolls back", async () => {
    let rejectSave: (error: Error) => void = () => undefined;
    storeMocks.saveControlPresentation.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
    );
    const view = renderRoute();

    fireEvent.click(screen.getByRole("radio", { name: "Icons" }));
    fireEvent.click(screen.getByRole("button", { name: "Save display preference" }));
    const saving = screen.getByRole("button", { name: /^.+: Saving…$/ });
    expect(saving).toHaveAttribute("aria-busy", "true");
    expect(saving.querySelector(".activity-indicator")).toBeInTheDocument();
    // The route now carries a second live region for the navigation arrangement (#1045), so name
    // the one this assertion is about instead of assuming the page has only one.
    expect(
      screen.getAllByRole("status").map((region) => region.textContent),
    ).toContain("Saving display preference.");
    expect(screen.getByRole("radio", { name: "Text labels" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Icons" })).toBeDisabled();

    fireEvent.submit(saving.closest("form")!);
    expect(storeMocks.saveControlPresentation).toHaveBeenCalledTimes(1);

    view.rerender(
      <ShellProvider value={shellWithPreference("icons")}>
        <AccountSettingsRoute />
      </ShellProvider>,
    );
    rejectSave(new Error("write rejected"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your display preference could not be stored. Try again.",
    );

    view.rerender(
      <ShellProvider value={shellWithPreference("text")}>
        <AccountSettingsRoute />
      </ShellProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Text labels" })).toBeChecked();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your display preference could not be stored. Try again.",
      );
    });
  });

  it("honors a competing save that restores the previous value", async () => {
    let resolveSave: () => void = () => undefined;
    storeMocks.saveControlPresentation.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );
    const view = renderRoute();

    fireEvent.click(screen.getByRole("radio", { name: "Icons" }));
    fireEvent.click(screen.getByRole("button", { name: "Save display preference" }));

    view.rerender(
      <ShellProvider value={shellWithPreference("text")}>
        <AccountSettingsRoute />
      </ShellProvider>,
    );
    resolveSave();

    expect(
      (await screen.findByText("Display preference saved.")).closest(
        '[role="status"]',
      ),
    ).toHaveTextContent("Display preference saved.");
    expect(screen.getByRole("radio", { name: "Text labels" })).toBeChecked();
  });

  it("adopts the last listener value when another save wins", async () => {
    storeMocks.saveControlPresentation.mockResolvedValue(undefined);
    const view = renderRoute();

    fireEvent.click(screen.getByRole("radio", { name: "Icons" }));
    fireEvent.click(screen.getByRole("button", { name: "Save display preference" }));
    await screen.findByText("Display preference saved.");
    expect(screen.getByRole("radio", { name: "Icons" })).toBeChecked();

    view.rerender(
      <ShellProvider value={shellWithPreference("text")}>
        <AccountSettingsRoute />
      </ShellProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Text labels" })).toBeChecked();
    });
  });
  it("reuses page results while paging, refreshes explicit searches, and refuses searches after a role change", async () => {
    const pages = Array.from({ length: 50 }, (_, index) => ({
      id: `page-${(index + 1).toString(16).padStart(32, "0")}`,
      title: `Page ${String(index + 1).padStart(2, "0")}`,
      path: `/page-${index + 1}/`,
      section: "support",
    }));
    const requests = vi.fn(async (_url: string, options: RequestInit) => {
      expect(JSON.parse(String(options.body))).toEqual({ view: "pages" });
      return new Response(JSON.stringify({ success: true, pages }), { status: 200 });
    });
    vi.stubGlobal("fetch", requests);
    const shell = { ...shellWithPreference("text"), getIdToken: async () => "fixture-session-token" };
    const view = render(<ShellProvider value={shell}><AccountSettingsRoute /></ShellProvider>);
    expect(requests).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add to your rail" }));
    fireEvent.change(screen.getByLabelText("Links to"), { target: { value: "page" } });
    fireEvent.change(screen.getByLabelText("Search pages"), { target: { value: "Page" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("25 results. Page 1 of 2.");
    expect(requests).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("25 results. Page 2 of 2.");
    expect(screen.getByRole("button", { name: "Page 26" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await screen.findByText("25 results. Page 1 of 2.");
    expect(requests).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(requests).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Search" })).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.change(screen.getByLabelText("Search pages"), { target: { value: "Missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("No matching content found.");
    expect(requests).toHaveBeenCalledTimes(3);
    view.rerender(<ShellProvider value={{ ...shell, principal: { id: "editor-1", grants: [{ role: "staff" }] } }}><AccountSettingsRoute /></ShellProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Add to your rail" }));
    fireEvent.change(screen.getByLabelText("Links to"), { target: { value: "page" } });
    fireEvent.change(screen.getByLabelText("Search pages"), { target: { value: "Missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Content could not be loaded. Try the search again.");
    expect(requests).toHaveBeenCalledTimes(3);
  });

  it("sends a share toggle without navigation or an owner name", async () => {
    const desk = { id: "custom:desk", kind: "link" as const, label: "Desk link", icon: "link" as const, destination: { kind: "url" as const, url: "https://example.test/desk" } };
    const other = { id: "custom:other", kind: "link" as const, label: "Other link", icon: "link" as const, destination: { kind: "url" as const, url: "https://example.test/other" } };
    const foreign = { id: "custom:foreign", kind: "link" as const, label: "Foreign link", icon: "link" as const, destination: { kind: "url" as const, url: "https://example.test/foreign" } };
    const navigation = { version: 4, order: ["home", desk.id, other.id], hidden: [], custom: [desk, other] };
    const owned = (item: typeof desk) => ({ id: item.id, ownerUid: "editor-1", ownerName: "Editor One", status: "active" as const, item });
    const shares = [
      { id: foreign.id, ownerUid: "other-user", ownerName: "Someone Else", status: "active" as const, item: foreign },
      owned(other),
    ];
    const shell = {
      ...shellWithPreference("text"),
      getIdToken: async () => "fixture-session-token",
      navigationShares: shares,
      userDoc: {
        role: null,
        preferences: { display: { controlPresentation: "text" }, navigation },
      },
    } as ShellData;
    const view = render(<ShellProvider value={shell}><AccountSettingsRoute /></ShellProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Share Desk link" }));
    await waitFor(() => expect(navigationMocks.shareNavigationItem).toHaveBeenCalledTimes(1));
    expect(navigationMocks.shareNavigationItem).toHaveBeenCalledWith(expect.any(Function), "custom:desk", true);
    expect(navigationMocks.saveNavigationPreferences).not.toHaveBeenCalled();

    view.rerender(<ShellProvider value={{ ...shell, navigationShares: [...shares, owned(desk)] }}><AccountSettingsRoute /></ShellProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing Desk link" }));
    await waitFor(() => expect(navigationMocks.shareNavigationItem).toHaveBeenCalledTimes(2));
    expect(navigationMocks.shareNavigationItem).toHaveBeenLastCalledWith(expect.any(Function), "custom:desk", false);
    const sent = JSON.stringify(navigationMocks.shareNavigationItem.mock.calls);
    expect(sent).not.toContain("navigation");
    expect(sent).not.toContain("order");
    expect(sent).not.toContain("ownerName");
    expect(sent).not.toContain("Sam");
  });

  it("does not send a share intent on an ordinary save, and refuses to share while the list is loading", async () => {
    const desk = { id: "custom:desk", kind: "link" as const, label: "Desk link", icon: "link" as const, destination: { kind: "url" as const, url: "https://example.test/desk" } };
    const navigation = { version: 4, order: ["home", desk.id], hidden: [], custom: [desk] };
    const shell = {
      ...shellWithPreference("text"),
      getIdToken: async () => "fixture-session-token",
      navigationShares: [],
      userDoc: {
        role: null,
        preferences: { display: { controlPresentation: "text" }, navigation },
      },
    } as ShellData;
    const view = render(<ShellProvider value={shell}><AccountSettingsRoute /></ShellProvider>);
    fireEvent.keyDown(screen.getByRole("button", { name: "Move: Home" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await waitFor(() => expect(navigationMocks.saveNavigationPreferences).toHaveBeenCalledTimes(1));
    expect(navigationMocks.saveNavigationPreferences.mock.calls[0]).toHaveLength(2);

    navigationMocks.shareGate = { shares: [], ready: false };
    view.rerender(<ShellProvider value={shell}><AccountSettingsRoute /></ShellProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Share Desk link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This plank could not be shared. Try again.");
    expect(navigationMocks.saveNavigationPreferences).toHaveBeenCalledTimes(1);
    expect(navigationMocks.shareNavigationItem).not.toHaveBeenCalled();
  });

});
