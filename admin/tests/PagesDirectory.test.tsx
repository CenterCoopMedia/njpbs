import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  PagesDirectory,
  type PageDirectoryApi,
} from "../src/components/PagesDirectory";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";

const sections = [
  { id: "station", label: "Station" },
  { id: "news", label: "News" },
] as const;

function CurrentPath() {
  const location = useLocation();
  return <output data-testid="current-path">{location.pathname}{location.search}</output>;
}

describe("PagesDirectory", () => {
  it.each([
    { clear: "input", address: "/content?keep=1&page_section=Support" },
    { clear: "all filters", address: "/content?keep=1" },
  ])("keeps a type-then-clear edit from $clear while the older URL write is pending", async ({ clear, address }) => {
    let finishSearch!: () => void;
    const pendingSearch = new Promise<void>(resolve => { finishSearch = resolve; });
    const router = createMemoryRouter([{
      path: "/content",
      loader: ({ request }) => new URL(request.url).searchParams.has("page_q") ? pendingSearch : null,
      hydrateFallbackElement: <p>Loading directory</p>,
      element: <><PagesDirectory /><CurrentPath /></>,
    }], { initialEntries: ["/content?keep=1&page_section=Support"] });
    render(<RouterProvider router={router} />);
    const search = await screen.findByRole("searchbox", { name: "Search pages" });
    fireEvent.change(search, { target: { value: "donate" } });
    expect(search).toHaveValue("donate");
    expect(screen.getByRole("link", { name: "Edit page draft: Support NJ PBS" })).toBeVisible();
    if (clear === "input") fireEvent.change(search, { target: { value: "" } });
    else fireEvent.click(screen.getByRole("button", { name: "Clear page filters" }));
    expect(search).toHaveValue("");
    await act(async () => { finishSearch(); });
    await waitFor(() => expect(screen.getByTestId("current-path").textContent).toBe(address));
    expect(search).toHaveValue("");
    expect(screen.getByRole("row", { name: /Give to NJ PBS/ })).toBeVisible();
  });

  it("restores the URL query after back and forward navigation", async () => {
    const router = createMemoryRouter([{
      path: "/content",
      element: <><PagesDirectory /><CurrentPath /></>,
    }], { initialEntries: ["/content?keep=1", "/content?keep=1&page_q=watch"] });
    render(<RouterProvider router={router} />);
    const search = screen.getByRole("searchbox", { name: "Search pages" });
    expect(search).toHaveValue("watch");
    fireEvent.change(search, { target: { value: "donate" } });
    await waitFor(() => expect(screen.getByTestId("current-path")).toHaveTextContent(/^\/content\?keep=1&page_q=donate$/));
    await act(async () => { await router.navigate(-1); });
    expect(search).toHaveValue("");
    await act(async () => { await router.navigate(1); });
    expect(search).toHaveValue("donate");
    fireEvent.click(screen.getByRole("button", { name: "Clear page filters" }));
    await waitFor(() => expect(search).toHaveValue(""));
    expect(screen.getByTestId("current-path")).toHaveTextContent(/^\/content\?keep=1$/);
    await act(async () => { await router.navigate(-1); });
    expect(search).toHaveValue("donate");
    expect(screen.getByTestId("current-path")).toHaveTextContent(/^\/content\?keep=1&page_q=donate$/);
    await act(async () => { await router.navigate(1); });
    expect(search).toHaveValue("");
  });

  it("keeps a confirmed Page receipt through the directory projection", async () => {
    const load = vi.fn(async () => [{ id: "contact", title: "Confirmed contact", path: "/contact/", section: "station",
      published: true, publishedSourceVersion: 10, liveSourceVersion: 10, version: 12,
      publicationTransport: "page-no-build-v1" as const,
      pageReceipt: { operationId: "A".repeat(20), sourceVersion: 10, visible: true } }]);
    render(<MemoryRouter><PagesDirectory api={{ load, create: vi.fn(), sections, canCreate: false }} /></MemoryRouter>);
    const row = await screen.findByRole("row", { name: /Confirmed contact/ });
    expect(within(row).getByText("Published copy live")).toBeVisible();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it.each(["pending", "ready"])("updates labels without replacing a %s read", async (status) => {
    let resolve!: (entries: { id: string; title: string; path: string; section: string }[]) => void;
    const load = vi.fn(() => new Promise<{ id: string; title: string; path: string; section: string }[]>(done => { resolve = done; }));
    const api: PageDirectoryApi = { load, create: vi.fn(), sections, canCreate: false };
    const entries = [{ id: "custom", title: "Private page", path: "/custom/", section: "news" }];
    const view = render(<MemoryRouter><PagesDirectory api={api} /></MemoryRouter>);
    if (status === "ready") await act(async () => { resolve(entries); });
    view.rerender(<MemoryRouter><PagesDirectory api={{ ...api, sections: [{ id: "news", label: "New desk" }] }} /></MemoryRouter>);
    expect(load).toHaveBeenCalledTimes(1);
    if (status === "pending") await act(async () => { resolve(entries); });
    expect(await screen.findByRole("row", { name: /Private page/ })).toHaveTextContent("New desk");
  });

  it.each(["pending", "ready"])("discards a previous %s reader when authority changes", async (status) => {
    let resolve!: (entries: { id: string; title: string; path: string }[]) => void;
    const load = vi.fn(() => new Promise<{ id: string; title: string; path: string }[]>(done => { resolve = done; }));
    const api: PageDirectoryApi = { load, create: vi.fn(), sections, canCreate: false };
    const entries = [{ id: "private", title: "Previous private page", path: "/private/" }];
    const view = render(<MemoryRouter><PagesDirectory api={api} /></MemoryRouter>);
    if (status === "ready") await act(async () => { resolve(entries); });
    const nextLoad = vi.fn(async () => []);
    view.rerender(<MemoryRouter><PagesDirectory api={{ ...api, load: nextLoad }} /></MemoryRouter>);
    expect(screen.queryByRole("row", { name: /Previous private page/ })).toBeNull();
    await act(async () => { resolve(entries); });
    expect(nextLoad).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("row", { name: /Previous private page/ })).toBeNull();
  });

  it("keeps deleted built-in and custom pages in the collapsed recycle bin", async () => {
    const api: PageDirectoryApi = {
      canCreate: false, sections, create: vi.fn(),
      load: vi.fn(async () => [
        { id: "home", title: "Home", path: "/", status: "archived" },
        { id: "page-deleted", title: "Deleted custom page", path: "/deleted/", status: "archived" },
      ]),
    };
    render(<MemoryRouter><PagesDirectory api={api} /></MemoryRouter>);
    const table = screen.getByRole("table", { name: "Live site pages" });
    await waitFor(() => expect(within(table).queryByText("Home")).toBeNull());
    expect(within(table).queryByText("Deleted custom page")).toBeNull();
    const bin = screen.getByText("Recycle bin", { selector: "summary" }).closest("details")!;
    expect(bin).not.toHaveAttribute("open");
    expect(bin).toHaveTextContent("(2)");
    bin.setAttribute("open", "");
    fireEvent(bin, new Event("toggle", { bubbles: true }));
    const deleted = await screen.findByRole("table", { name: "Deleted content" });
    expect(within(deleted).getByText("Home")).toBeInTheDocument();
    expect(within(deleted).getByText("Deleted custom page")).toBeInTheDocument();
  });

  it("keeps opened details mounted while searching page aliases", () => {
    render(<MemoryRouter initialEntries={["/content"]}><PagesDirectory /><CurrentPath /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Show details for Home" }));
    const details = screen.getByRole("region", { name: "Home details" });
    const search = screen.getByRole("searchbox", { name: "Search pages" });
    fireEvent.change(search, { target: { value: "donate" } });
    expect(screen.getByTestId("current-path")).toHaveTextContent("/content?page_q=donate");
    expect(screen.getByRole("row", { name: /Give to NJ PBS/ })).toBeInTheDocument();
    expect(details).toBeInTheDocument();
    expect(details).not.toBeVisible();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByTestId("current-path")).toHaveTextContent("/content");
    expect(screen.getByRole("region", { name: "Home details" })).toBe(details);
    expect(details).toBeVisible();
  });

  it("starts from the canonical pages viewers can visit, not record types", () => {
    render(
      <MemoryRouter>
        <PagesDirectory />
      </MemoryRouter>,
    );

    const table = screen.getByRole("table", { name: "Live site pages" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Page",
      "Area",
      "Status",
      "Actions",
    ]);
    expect(within(table).queryByRole("columnheader", { name: "Editor" })).not.toBeInTheDocument();

    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(PUBLIC_PAGES.length);
    for (const [index, page] of PUBLIC_PAGES.entries()) {
      const row = rows[index];
      expect(row).toHaveTextContent(page.title);
      expect(
        within(row).getByRole("link", {
          name: new RegExp(
            `^${page.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(opens in a new tab\\)$`,
          ),
        }),
      ).toHaveAttribute("href", `https://njpbs.org${page.path}`);
    }
    expect(within(table).queryByText("Articles")).not.toBeInTheDocument();
    expect(within(table).queryByText("Programs")).not.toBeInTheDocument();
    expect(within(table).queryByText("Sponsors")).not.toBeInTheDocument();
  });

  it("keeps each page identity and its common actions in separate cells", () => {
    render(
      <MemoryRouter initialEntries={["/content/pages?from=site-pages"]}>
        <PagesDirectory />
      </MemoryRouter>,
    );

    const table = screen.getByRole("table", { name: "Live site pages" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(PUBLIC_PAGES.length);

    for (const [index, page] of PUBLIC_PAGES.entries()) {
      const row = rows[index];
      const pageCell = row.querySelector<HTMLTableCellElement>('td[data-label="Page"]');
      const actionsCell = row.querySelector<HTMLTableCellElement>('td[data-label="Actions"]');
      if (!pageCell) throw new Error(`Expected the Page cell for ${page.title}.`);
      if (!actionsCell) throw new Error(`Expected the Actions cell for ${page.title}.`);

      expect(
        within(pageCell).getByRole("link", {
          name: `Edit page draft: ${page.title}`,
        }),
      ).toHaveAttribute("href", `/content/pages/${page.id}/edit`);
      expect(within(actionsCell).getByRole("link", { name: "Edit draft" })).toHaveAttribute(
        "href",
        `/content/pages/${page.id}/edit`,
      );
      expect(
        within(actionsCell).getByRole("link", {
          name: `View live: ${page.title} (opens in a new tab)`,
        }),
      ).toHaveAttribute("href", `https://njpbs.org${page.path}`);
      expect(within(actionsCell).getByRole("button", {
        name: `Show details for ${page.title}`,
      })).toHaveAttribute("aria-expanded", "false");
    }

    const liveRow = screen.getByRole("row", { name: /PBS Livestream/ });
    expect(within(liveRow).getByText("Service page")).toBeInTheDocument();
    expect(within(liveRow).getByText("Watch")).toBeInTheDocument();

    const staffRow = screen.getByRole("row", { name: /Staff/ });
    expect(within(staffRow).getByText("Staff directory")).toBeInTheDocument();
    expect(within(staffRow).getByText("Station")).toBeInTheDocument();
  });

  it("folds the donate alias into Give instead of presenting a duplicate page to edit", () => {
    render(
      <MemoryRouter>
        <PagesDirectory />
      </MemoryRouter>,
    );

    const giveRow = screen.getByRole("row", { name: /Give to NJ PBS/ });
    expect(giveRow).toHaveTextContent("Also served at /donate/");
    expect(screen.queryByRole("row", { name: /^Donate to NJ PBS/ })).not.toBeInTheDocument();
  });

  it("merges authorized entries by id and keeps draft and live paths separate", async () => {
    const api: PageDirectoryApi = {
      canCreate: false,
      sections,
      create: vi.fn(),
      load: vi.fn(async () => [
        {
          id: "watch",
          title: "Watch current draft",
          path: "/watch-next/",
          livePath: "/watch/",
          thumbnailUrl: "https://media.example.org/watch.jpg",
          published: true,
          section: "news",
        },
        {
          id: "page-11111111111111111111111111111111",
          title: "Community calendar",
          path: "/community-calendar/",
          published: false,
          section: "news",
          status: "draft",
        },
        {
          id: "page-22222222222222222222222222222222",
          title: "Unassigned page",
          path: "/unassigned/",
          published: false,
        },
      ]),
    };

    render(
      <MemoryRouter>
        <PagesDirectory api={api} />
      </MemoryRouter>,
    );

    const watchRow = await screen.findByRole("row", { name: /Watch current draft/ });
    expect(within(watchRow).getByText("/watch-next/")).toBeInTheDocument();
    expect(within(watchRow).getByText("News")).toBeInTheDocument();
    expect(watchRow.querySelector("img")).toHaveAttribute(
      "src",
      "https://media.example.org/watch.jpg",
    );
    expect(
      within(watchRow).getByRole("link", { name: "View live: Watch current draft (opens in a new tab)" }),
    ).toHaveAttribute("href", "https://njpbs.org/watch/");

    const draftRow = screen.getByRole("row", { name: /Community calendar/ });
    expect(within(draftRow).getByText("Article page")).toBeInTheDocument();
    expect(within(draftRow).getByText("News")).toBeInTheDocument();
    expect(within(draftRow).queryByRole("link", { name: /View live/ })).not.toBeInTheDocument();

    const unassignedRow = screen.getByRole("row", { name: /Unassigned page/ });
    expect(within(unassignedRow).getByText("No area")).toBeInTheDocument();
    expect(within(unassignedRow).queryByText("Station")).not.toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Live site pages" })).getAllByRole("row"))
      .toHaveLength(PUBLIC_PAGES.length + 2 + 1);
    expect(api.load).toHaveBeenCalledTimes(1);
  });

  it("labels compact row controls on keyboard focus and respects text presentation", async () => {
    const directory = (presentation: "icons" | "text") => (
      <ControlPresentationProvider value={presentation}>
        <MemoryRouter><PagesDirectory /></MemoryRouter>
      </ControlPresentationProvider>
    );
    const view = render(directory("icons"));
    const live = screen.getByRole("link", { name: "View live: Home (opens in a new tab)" });
    act(() => live.focus());
    expect(await screen.findByRole("tooltip", { hidden: true })).toHaveTextContent("View live: Home (opens in a new tab)");
    act(() => screen.getByRole("button", { name: "Show details for Home" }).focus());
    expect(await screen.findByRole("tooltip", { hidden: true })).toHaveTextContent("Show details for Home");
    view.rerender(directory("text"));
    expect(screen.getByRole("link", { name: "View live: Home (opens in a new tab)" })).toHaveTextContent("View live");
  });

  it("opens page facts while keeping quick edit collapsed until requested", () => {
    render(<MemoryRouter><PagesDirectory /></MemoryRouter>);
    const detailsButton = screen.getByRole("button", { name: "Show details for Home" });
    detailsButton.focus();
    expect(detailsButton).toHaveFocus();
    fireEvent.click(detailsButton);
    expect(screen.getByRole("button", { name: "Hide details for Home" })).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByRole("region", { name: "Home details" });
    expect(within(details).getByText("Canonical path")).toBeVisible();
    const quickEdit = within(details).getByText("Quick edit and lifecycle", { selector: "summary" }).closest("details")!;
    expect(quickEdit).not.toHaveAttribute("open");
    const summary = within(quickEdit).getByText("Quick edit and lifecycle", { selector: "summary" });
    summary.focus();
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    expect(quickEdit).toHaveAttribute("open");
  });

  it("keeps built-in pages available and retries a failed authorized load", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("Directory service unavailable."))
      .mockResolvedValueOnce([]);
    const api: PageDirectoryApi = {
      canCreate: false,
      sections,
      create: vi.fn(),
      load,
    };

    render(
      <MemoryRouter>
        <PagesDirectory api={api} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("row", { name: /Home/ })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Directory service unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("creates a draft with one retry key and opens its minted editor address", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("That URL is already in use."))
      .mockResolvedValueOnce({ id: "page-33333333333333333333333333333333" });
    const api: PageDirectoryApi = {
      canCreate: true,
      sections,
      create,
      load: vi.fn(async () => []),
    };

    render(
      <MemoryRouter initialEntries={["/content/pages"]}>
        <PagesDirectory api={api} />
        <CurrentPath />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add page" }));
    const title = screen.getByRole("textbox", { name: "Page title" });
    const slug = screen.getByRole("textbox", { name: "URL slug" });
    fireEvent.change(title, { target: { value: "Community Connections" } });
    expect(slug).toHaveValue("community-connections");
    expect(screen.getByText("https://njpbs.org/community-connections/")).toBeInTheDocument();

    fireEvent.change(slug, { target: { value: "community" } });
    fireEvent.change(title, { target: { value: "Community Connections calendar" } });
    expect(slug).toHaveValue("community");
    fireEvent.change(screen.getByRole("combobox", { name: "Area" }), {
      target: { value: "news" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create page" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That URL is already in use.");
    fireEvent.click(screen.getByRole("button", { name: "Create page" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0][0]).toEqual({
      title: "Community Connections calendar",
      slug: "community",
      section: "news",
      idempotencyKey: expect.any(String),
    });
    expect(create.mock.calls[1][0].idempotencyKey).toBe(
      create.mock.calls[0][0].idempotencyKey,
    );
    await waitFor(() => {
      expect(screen.getByTestId("current-path")).toHaveTextContent(
        "/content/pages/page-33333333333333333333333333333333/edit",
      );
    });
  });

  it("blocks duplicate create requests and explains when another editor draft disables creation", async () => {
    let finishCreate: ((value: { id: string }) => void) | undefined;
    const create = vi.fn(() => new Promise<{ id: string }>((resolve) => {
      finishCreate = resolve;
    }));
    const api: PageDirectoryApi = {
      canCreate: true,
      sections,
      create,
      load: vi.fn(async () => []),
    };
    const { rerender } = render(
      <MemoryRouter>
        <PagesDirectory api={api} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add page" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Page title" }), {
      target: { value: "Station events" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Area" }), {
      target: { value: "station" },
    });
    const form = screen.getByRole("button", { name: "Create page" }).closest("form");
    if (!form) throw new Error("Expected the page creation form.");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(create).toHaveBeenCalledTimes(1);

    finishCreate?.({ id: "page-44444444444444444444444444444444" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    rerender(
      <MemoryRouter>
        <PagesDirectory api={api} persistentEditorDirty />
      </MemoryRouter>,
    );
    const add = screen.getByRole("button", { name: "Add page" });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(
      "Save or discard the open editor draft before adding a page.",
    );
  });
});
