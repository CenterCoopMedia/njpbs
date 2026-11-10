import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";
import { RecordList, type RecordListPage } from "../src/components/RecordList";
import type { RecordKind } from "../../packages/content-core/src/editor-admin";

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  );
}

function OriginProbe() {
  const location = useLocation();
  const state = location.state as { from?: string } | null;
  return <output data-testid="origin">{state?.from ?? "none"}</output>;
}

// The routed shape the shell mounts: the record kind comes from the path, so switching kinds is
// a navigation, not a prop change.
function KindList({
  loadRecords,
}: {
  loadRecords: (kind: RecordKind, page: number) => Promise<RecordListPage>;
}) {
  const kind = (useParams().type ?? "sponsor") as RecordKind;
  return (
    <RecordList
      key={kind}
      canCreate
      kind={kind}
      label={kind === "post" ? "Post" : "Sponsor"}
      loadRecords={loadRecords}
    />
  );
}

function pageOf(
  page: number,
  pageCount: number,
  titles: string[],
): RecordListPage {
  return {
    records: titles.map((title, index) => ({
      id: `spo-${page}-${index}`,
      title,
      status: "draft",
      updatedAt: "2026-07-20T12:00:00.000Z",
    })),
    page,
    pageCount,
    total: pageCount * 25,
  };
}

function renderList(
  loadRecords: (kind: RecordKind, page: number) => Promise<RecordListPage>,
  initialEntry = "/content/sponsor",
  kind: RecordKind = "sponsor",
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route
          path="/content/:type"
          element={
            <RecordList
              canCreate
              kind={kind}
              label="Sponsor"
              loadRecords={loadRecords}
            />
          }
        />
        <Route path="/content/:type/new" element={<OriginProbe />} />
        <Route path="/content/:type/:id/edit" element={<OriginProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RecordList paging", () => {
  it("requests one bounded page rather than every matching record", async () => {
    const loadRecords = vi.fn(async () =>
      pageOf(1, 3, ["First sponsor", "Second sponsor"]),
    );

    renderList(loadRecords);

    expect(
      await screen.findByRole("link", { name: "First sponsor" }),
    ).toBeTruthy();
    expect(loadRecords).toHaveBeenCalledTimes(1);
    expect(loadRecords).toHaveBeenCalledWith("sponsor", 1);
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();
  });

  it("reads the addressed page out of the URL so a refresh or a shared link restores it", async () => {
    const loadRecords = vi.fn(async (_kind: RecordKind, page: number) =>
      pageOf(page, 3, [`Sponsor on page ${page}`]),
    );

    renderList(loadRecords, "/content/sponsor?page=2&v=1");

    expect(
      await screen.findByRole("link", { name: "Sponsor on page 2" }),
    ).toBeTruthy();
    expect(loadRecords).toHaveBeenCalledWith("sponsor", 2);
    expect(screen.getByText("Page 2 of 3")).toBeTruthy();
  });

  it("continues to the next page by writing that page into the URL", async () => {
    const loadRecords = vi.fn(async (_kind: RecordKind, page: number) =>
      pageOf(page, 3, [`Sponsor on page ${page}`]),
    );

    renderList(loadRecords);
    await screen.findByRole("link", { name: "Sponsor on page 1" });

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(
      await screen.findByRole("link", { name: "Sponsor on page 2" }),
    ).toBeTruthy();
    expect(loadRecords).toHaveBeenLastCalledWith("sponsor", 2);
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/content/sponsor?page=2&v=1",
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));

    expect(
      await screen.findByRole("link", { name: "Sponsor on page 1" }),
    ).toBeTruthy();
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/content/sponsor?v=1",
    );
  });

  it("keeps the current rows readable while the next page is in flight", async () => {
    let release: (value: RecordListPage) => void = () => {};
    const loadRecords = vi
      .fn(
        async (_kind: RecordKind, page: number) =>
          new Promise<RecordListPage>((resolve) => {
            release = resolve;
            if (page === 1) resolve(pageOf(1, 3, ["Sponsor on page 1"]));
          }),
      );

    renderList(loadRecords);
    await screen.findByRole("link", { name: "Sponsor on page 1" });

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // The first page stays on screen instead of collapsing to a loading line, and the paging
    // controls are held so a second click cannot outrun the request already running.
    expect(screen.getByRole("link", { name: "Sponsor on page 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.queryByText("Loading sponsors…")).toBeNull();

    release(pageOf(2, 3, ["Sponsor on page 2"]));

    expect(
      await screen.findByRole("link", { name: "Sponsor on page 2" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("keeps a retained row's Back origin on the page that row belongs to", async () => {
    let release: (value: RecordListPage) => void = () => {};
    const loadRecords = vi.fn(
      async (_kind: RecordKind, page: number) =>
        new Promise<RecordListPage>((resolve) => {
          release = resolve;
          if (page === 2) resolve(pageOf(2, 3, ["Sponsor on page 2"]));
        }),
    );

    renderList(loadRecords, "/content/sponsor?page=2&v=1");
    const retained = await screen.findByRole("link", {
      name: "Sponsor on page 2",
    });

    // Page 3 is requested and the address changes first. The rows on screen are still page 2's,
    // so opening one must return to page 2, not to the page its records are not on.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(retained);

    expect(await screen.findByTestId("origin")).toHaveTextContent(
      "/content/sponsor?page=2&v=1",
    );
    release(pageOf(3, 3, ["Sponsor on page 3"]));
  });

  it("carries the paged address onto the editor it opens so Back returns to that page", async () => {
    const loadRecords = vi.fn(async (_kind: RecordKind, page: number) =>
      pageOf(page, 3, [`Sponsor on page ${page}`]),
    );

    renderList(loadRecords, "/content/sponsor?page=2&v=1");
    const link = await screen.findByRole("link", {
      name: "Sponsor on page 2",
    });

    fireEvent.click(link);

    expect(await screen.findByTestId("origin")).toHaveTextContent(
      "/content/sponsor?page=2&v=1",
    );
  });

  it("ends the list honestly on its last page", async () => {
    const loadRecords = vi.fn(async () => pageOf(3, 3, ["Last sponsor"]));

    renderList(loadRecords, "/content/sponsor?page=3&v=1");
    await screen.findByRole("link", { name: "Last sponsor" });

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByText("Page 3 of 3")).toBeTruthy();
    expect(screen.getByText(/end of the sponsor list/i)).toBeTruthy();
  });

  it("offers no paging controls when the whole list fits on one page", async () => {
    const loadRecords = vi.fn(async () => pageOf(1, 1, ["Only sponsor"]));

    renderList(loadRecords);
    await screen.findByRole("link", { name: "Only sponsor" });

    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByText(/Page 1 of 1/)).toBeNull();
  });

  it("canonicalizes an addressed page beyond the current result", async () => {
    const loadRecords = vi.fn(async () => pageOf(2, 2, ["Sponsor on page 2"]));

    renderList(loadRecords, "/content/sponsor?page=9&v=1");
    await screen.findByRole("link", { name: "Sponsor on page 2" });

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/content/sponsor?page=2&v=1",
      );
    });
  });

  it("keeps an empty result an empty state rather than a paging dead end", async () => {
    const loadRecords = vi.fn(async () => pageOf(1, 1, []));

    renderList(loadRecords);

    expect(await screen.findByText("No sponsors yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("renders exactly the rows the server authorized, without a client-side refilter", async () => {
    const loadRecords = vi.fn(async () => ({
      records: [
        {
          id: "spo-1",
          title: "Authorized sponsor",
          status: "draft",
          updatedAt: "2026-07-20T12:00:00.000Z",
        },
      ],
      page: 2,
      pageCount: 4,
      total: 87,
    }));

    renderList(loadRecords, "/content/sponsor?page=2&v=1");
    await screen.findByRole("link", { name: "Authorized sponsor" });

    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(loadRecords).toHaveBeenCalledWith("sponsor", 2);
  });

  it("retries the page it failed on rather than dropping back to the first", async () => {
    const loadRecords = vi
      .fn(async (_kind: RecordKind, page: number) =>
        pageOf(page, 3, [`Sponsor on page ${page}`]),
      )
      .mockRejectedValueOnce(new Error("offline"));

    renderList(loadRecords, "/content/sponsor?page=2&v=1");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The sponsor list could not be loaded",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Try loading sponsors again" }),
    );

    expect(
      await screen.findByRole("link", { name: "Sponsor on page 2" }),
    ).toBeTruthy();
    expect(loadRecords).toHaveBeenLastCalledWith("sponsor", 2);
  });

  it("starts a different record kind at its own first page", async () => {
    const loadRecords = vi.fn(async (kind: RecordKind, page: number) =>
      pageOf(page, 2, [`${kind} on page ${page}`]),
    );

    render(
      <MemoryRouter initialEntries={["/content/sponsor?page=2&v=1"]}>
        <LocationProbe />
        <Link to="/content/post">Posts</Link>
        <Routes>
          <Route path="/content/:type" element={<KindList loadRecords={loadRecords} />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: "sponsor on page 2" });

    fireEvent.click(screen.getByRole("link", { name: "Posts" }));

    expect(
      await screen.findByRole("link", { name: "post on page 1" }),
    ).toBeTruthy();
    expect(loadRecords).toHaveBeenLastCalledWith("post", 1);
  });
});
