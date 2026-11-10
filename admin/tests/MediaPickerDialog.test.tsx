import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { MediaPickerDialog } from "../src/components/MediaPickerDialog";
import { RecordForm } from "../src/components/RecordForm";
import type {
  ListMediaResponse,
  MediaAssetSummary,
  MediaCategoryDefinition,
} from "../src/lib/functions";

afterEach(cleanup);

const image: MediaAssetSummary = {
  id: "asset-news-desk",
  name: "News desk",
  originalName: "news-desk.png",
  category: "news",
  categories: ["news"],
  tags: ["studio"],
  description: null,
  altText: "A presenter at the news desk",
  license: "NJ PBS owned",
  credit: "NJ PBS",
  mimeType: "image/png",
  kind: "image",
  sizeBytes: 2_048,
  width: 1_600,
  height: 900,
  url: "https://media.njpbs.org/news-desk.png",
  lifecycle: "active",
  version: 1,
  etag: '"media.YXNzZXQtbmV3cy1kZXNr.1"',
  createdAt: "2026-08-13T12:00:00.000Z",
  createdBy: "editor-1",
  updatedAt: "2026-08-13T12:00:00.000Z",
  updatedBy: "editor-1",
};

const uploadedImage: MediaAssetSummary = {
  ...image,
  id: "asset-field-report",
  name: "Field report",
  originalName: "field-report.png",
  altText: "A reporter interviewing a guest outdoors",
  url: "https://media.njpbs.org/field-report.png",
  etag: '"media.YXNzZXQtZmllbGQtcmVwb3J0.1"',
};

const mediaCategories: MediaCategoryDefinition[] = [
  {
    id: "news",
    label: "News",
    description: "Newsroom media",
    order: 10,
    active: true,
    reserved: false,
    version: 1,
    etag: '"media-category.bmV3cw.1"',
    canUpload: true,
    canManage: false,
    createdAt: null,
    createdBy: null,
    updatedAt: null,
    updatedBy: null,
  },
];

function selection() {
  return {
    success: true as const,
    records: [image],
    total: 1,
    allCount: 1,
    page: 1,
    pageCount: 1,
    categoryCounts: { news: 1 },
    kindCounts: { image: 1, document: 0 },
  };
}

describe("MediaPickerDialog", () => {
  it("searches from the Post picker portal without making a Post save request", async () => {
    const onSave = vi.fn(async (record) => ({ ...record, version: 2 }));
    const loadMedia = vi.fn().mockResolvedValue(selection());
    render(<RecordForm kind="post" initial={{ title: "A Garden State update", date: "2026-08-13", tags: [] }}
      loadMedia={loadMedia} onSave={onSave} canSave allowIncomplete />);
    fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: "image" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Hero image" })).getByRole("button", { name: "Choose lead image" }));
    const search = await screen.findByRole("searchbox", { name: "Search images" }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "desk" } });
    fireEvent.submit(search.form!);
    await waitFor(() => expect(loadMedia).toHaveBeenLastCalledWith(expect.objectContaining({ q: "desk", page: 1 })));
    expect(onSave).not.toHaveBeenCalled();
    // Submitting an unchanged query takes the handler's early return too.
    fireEvent.submit(search.form!);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /^News desk/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      leadMedia: expect.objectContaining({ kind: "image", data: expect.objectContaining({ assetId: image.id }) }),
    }));
  });

  it("keeps upload metadata isolated from the surrounding record's native form", async () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form id="record-editor" onSubmit={submit}>
      <button type="submit">Save record</button>
      <MediaPickerDialog currentAssetId="" loadMedia={vi.fn().mockResolvedValue(selection())}
        uploadMedia={vi.fn()} defaultUploadCategory="news" canUploadCategory={() => true}
        categories={mediaCategories} onClose={() => {}} onSelect={() => {}} />
    </form>);
    const search = await screen.findByRole("searchbox", { name: "Search images" });
    expect((search as HTMLInputElement).form).not.toBe(screen.getByRole("button", { name: "Save record" }).closest("form"));
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    const license = screen.getByRole("textbox", { name: /^Batch license default$/ }) as HTMLInputElement;
    expect(license.form).toBeNull();
    expect(license).not.toHaveAttribute("form");
    fireEvent.change(license, { target: { value: "NJ PBS owned" } });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["document", "image"] as const)("labels %s pagination correctly in both paging modes", async (kind) => {
    const asset = kind === "document"
      ? { ...image, mimeType: "application/pdf", kind, name: "Meeting notice", originalName: "notice.pdf" }
      : image;
    for (const paging of ["cursor", "numbered"] as const) {
      const loadMedia = vi.fn().mockResolvedValue({
        ...selection(), records: [asset], total: 2, allCount: 2,
        ...(paging === "cursor"
          ? { paging, pageCount: null, nextCursor: "cursor_page_2_token_1234567890ab" }
          : { pageCount: 2 }),
      });
      const view = render(<MediaPickerDialog kind={kind} currentAssetId="" loadMedia={loadMedia}
        onClose={() => {}} onSelect={() => {}} />);
      const label = kind === "document" ? "PDF pages" : "Image pages";
      expect(await screen.findByRole("navigation", { name: label })).toBeVisible();
      expect(screen.queryByRole("navigation", { name: kind === "document" ? "Image pages" : "PDF pages" })).toBeNull();
      expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
      view.unmount();
    }
  });

  it.each(["choose", "drop"])("queues and uploads a PDF locally when staff %s a file", async (intake) => {
    const pdf = { ...uploadedImage, id: "notice-pdf", name: "Meeting notice", originalName: "notice.pdf",
      kind: "document" as const, mimeType: "application/pdf", width: null, height: null,
      url: "https://media.njpbs.org/notice.pdf" };
    const empty = { ...selection(), records: [], total: 0, allCount: 0 };
    const loadMedia = vi.fn().mockResolvedValueOnce(empty).mockResolvedValue({ ...empty, records: [pdf], total: 1, allCount: 1 });
    const uploadMedia = vi.fn().mockResolvedValue({ success: true, asset: pdf });
    const onSelect = vi.fn();
    render(<MediaPickerDialog kind="document" currentAssetId="" loadMedia={loadMedia}
      uploadMedia={uploadMedia} defaultUploadCategory="news" canUploadCategory={() => true}
      categories={mediaCategories} onClose={() => {}} onSelect={onSelect} />);
    fireEvent.click(await screen.findByRole("button", { name: "Upload PDF" }));
    const input = screen.getByLabelText(/Files/);
    const file = new File(["%PDF-1.4"], "notice.pdf", { type: "application/pdf" });
    if (intake === "choose") fireEvent.change(input, { target: { files: [file] } });
    else fireEvent.drop(input.closest("label")!, { dataTransfer: { files: [file], types: ["Files"] } });
    expect(screen.getByRole("button", { name: /notice\.pdf/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
    expect(uploadMedia.mock.calls[0][0]).toBe(file);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(pdf));
  });

  it("renders outside transformed editor cards", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());
    const { container } = render(
      <section style={{ transform: "translateY(-1px)", overflow: "hidden" }}>
        <MediaPickerDialog
          currentAssetId=""
          loadMedia={loadMedia}
          onClose={() => {}}
          onSelect={() => {}}
        />
      </section>,
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Choose an image",
    });
    expect(container).not.toContainElement(dialog);
    expect(document.body).toContainElement(dialog);
    expect(dialog.closest('form, dialog')).toBeNull();
  });

  it("loads authorized images and returns the selected asset", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());
    const onSelect = vi.fn();
    render(
      <MediaPickerDialog
        currentAssetId="asset-news-desk"
        loadMedia={loadMedia}
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /^News desk/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(loadMedia).toHaveBeenCalledWith({
      q: "",
      categories: [],
      kinds: ["image"],
      sort: "updatedAt",
      direction: "desc",
      page: 1,
    });

    fireEvent.click(screen.getByRole("button", { name: /^News desk/ }));
    expect(onSelect).toHaveBeenCalledWith(image);
  });

  it("searches from page one and retries a failed request", async () => {
    const loadMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error("Media is offline"))
      .mockResolvedValue(selection());
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(await screen.findByText("Media is offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("button", { name: /^News desk/ }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search images" }), {
      target: { value: "desk" },
    });
    const callsBeforeSearch = loadMedia.mock.calls.length;
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.submit(screen.getByRole("search"));
      });
      expect(loadMedia).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "desk", page: 1, kinds: ["image"] }),
      );
      expect(loadMedia).toHaveBeenCalledTimes(callsBeforeSearch + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(loadMedia).toHaveBeenCalledTimes(callsBeforeSearch + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates after a typing pause and keeps the current grid when refresh fails", async () => {
    let rejectSearch: (reason?: unknown) => void = () => {};
    const loadMedia = vi
      .fn()
      .mockResolvedValueOnce(selection())
      .mockImplementationOnce(
        () =>
          new Promise<ListMediaResponse>((_resolve, reject) => {
            rejectSearch = reject;
          }),
      )
      .mockResolvedValue(selection());
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /^News desk/ }),
    ).toBeInTheDocument();
    const grid = screen.getByRole("list", { name: "Available images" });
    const search = screen.getByRole("searchbox", { name: "Search images" });
    vi.useFakeTimers();
    try {
      fireEvent.change(search, { target: { value: "desk" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(loadMedia).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(loadMedia).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "desk", page: 1 }),
      );
      expect(grid.closest(".media-picker-results")).toHaveAttribute(
        "aria-busy",
        "true",
      );

      await act(async () => {
        rejectSearch(new Error("Search refresh failed"));
      });
      expect(screen.getByText("Search refresh failed")).toBeInTheDocument();
      expect(grid).toBeInTheDocument();
      expect(grid.closest(".media-picker-results")).not.toHaveAttribute(
        "aria-busy",
      );

      fireEvent.change(search, { target: { value: "" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(loadMedia).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "", page: 1 }),
      );
      expect(screen.queryByText("Search refresh failed")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Choose image
          </button>
          {open ? (
            <MediaPickerDialog
              currentAssetId=""
              loadMedia={loadMedia}
              onClose={() => setOpen(false)}
              onSelect={() => {}}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Choose image" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Choose an image",
    });
    expect(
      screen.getByRole("searchbox", { name: "Search images" }),
    ).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("lets Escape cancel the nested leave guard without reopening it", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        uploadMedia={vi.fn()}
        defaultUploadCategory="news"
        canUploadCategory={() => true}
        categories={mediaCategories}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    fireEvent.change(screen.getByLabelText(/File/), {
      target: {
        files: [
          new File(["image bytes"], "field-report.png", {
            type: "image/png",
          }),
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const guard = await screen.findByRole("dialog", {
      name: "Leave with unsaved changes?",
    });

    fireEvent.keyDown(guard, { key: "Escape" });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Leave with unsaved changes?" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("dialog", { name: "Choose an image" }),
    ).toBeInTheDocument();
    expect(screen.getByText("field-report.png")).toBeVisible();
  });

  it("keeps focus in the dialog after a backdrop press and wraps Tab focus", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Choose an image",
    });
    const search = screen.getByRole("searchbox", { name: "Search images" });
    expect(search).toHaveFocus();

    const overlay = dialog.parentElement;
    expect(overlay).toHaveClass("media-picker-overlay");
    fireEvent.mouseDown(overlay!);
    expect(search).toHaveFocus();

    const close = screen.getByRole("button", { name: "Close" });
    const asset = screen.getByRole("button", { name: /^News desk/ });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(asset).toHaveFocus();
    fireEvent.keyDown(asset, { key: "Tab" });
    expect(close).toHaveFocus();
  });

  it("keeps legacy numbered paging for a narrow loader", async () => {
    const loadMedia = vi.fn().mockImplementation(async (query) => ({
      ...selection(),
      page: query.page,
      pageCount: 2,
    }));
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(await screen.findByText("Page 1 of 2")).toBeVisible();
    const firstNext = screen.getByRole("button", { name: "Next page" });
    firstNext.focus();
    fireEvent.click(firstNext);
    const secondPage = await screen.findByText("Page 2 of 2");
    expect(secondPage).toBeVisible();
    const previous = screen.getByRole("button", { name: "Previous page" });
    await waitFor(() => expect(previous).toHaveFocus());
    expect(loadMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 }),
    );

    previous.focus();
    fireEvent.click(previous);
    const firstPage = await screen.findByText("Page 1 of 2");
    expect(firstPage).toBeVisible();
    const next = screen.getByRole("button", { name: "Next page" });
    await waitFor(() => expect(next).toHaveFocus());
    expect(loadMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1 }),
    );
  });

  it("keeps the current grid on screen while the next page loads", async () => {
    let finishSecondPage: (value: ListMediaResponse) => void = () => {};
    const loadMedia = vi.fn().mockImplementation(async (query) => {
      if (query.page === 1) return { ...selection(), page: 1, pageCount: 2 };
      return new Promise<ListMediaResponse>((resolve) => {
        finishSecondPage = resolve;
      });
    });
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(await screen.findByText("Page 1 of 2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    // The first page's images stay mounted and marked busy rather than being replaced by a
    // loading line, so the person keeps their place while the next page arrives.
    const grid = screen.getByRole("list", { name: "Available images" });
    expect(grid).toBeInTheDocument();
    expect(grid.closest(".media-picker-results")).toHaveAttribute("aria-busy", "true");
    const updating = screen.getByText("Updating images");
    expect(updating).toBeInTheDocument();
    // The refresh path gets the shared indicator, not only a sentence beside a dimmed grid.
    expect(updating.closest(".loading-indicator")?.querySelector(".spinner")).not.toBeNull();
    expect(screen.queryByText("Loading images…")).toBeNull();

    finishSecondPage({ ...selection(), page: 2, pageCount: 2 });
    expect(await screen.findByText("Page 2 of 2")).toBeVisible();
    expect(grid.closest(".media-picker-results")).not.toHaveAttribute("aria-busy");
  });

  it("pages forward and back with opaque cursor history", async () => {
    const loadMedia = vi.fn(async (query) => query.cursor
      ? {
          success: true as const, records: [uploadedImage], paging: "cursor" as const,
          nextCursor: null, total: 2, allCount: 2, page: 2, pageCount: null,
          categoryCounts: null, kindCounts: null,
        }
      : {
          success: true as const, records: [image], paging: "cursor" as const,
          nextCursor: "cursor_page_2_token_1234567890ab", total: null, allCount: null,
          page: 1, pageCount: null, categoryCounts: null, kindCounts: null,
        });
    render(<MediaPickerDialog currentAssetId="" loadMedia={loadMedia} onClose={() => {}} onSelect={() => {}} />);

    expect(await screen.findByText("Page 1 · reload returns to page 1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByRole("button", { name: /^Field report/ })).toBeVisible();
    expect(loadMedia).toHaveBeenLastCalledWith(expect.objectContaining({
      cursor: "cursor_page_2_token_1234567890ab",
      page: 2,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByRole("button", { name: /^News desk/ })).toBeVisible();
    expect(loadMedia).toHaveBeenLastCalledWith(expect.not.objectContaining({ cursor: expect.anything() }));
  });

  it("offers Next when a bounded cursor page has no verified matches", async () => {
    const loadMedia = vi.fn(async (query) => query.cursor
      ? {
          success: true as const, records: [image], paging: "cursor" as const,
          nextCursor: null, total: 1, allCount: null, page: 2, pageCount: null,
          categoryCounts: null, kindCounts: null,
        }
      : {
          success: true as const, records: [], paging: "cursor" as const,
          nextCursor: "cursor_page_2_token_1234567890ab", total: null, allCount: null,
          page: 1, pageCount: null, categoryCounts: null, kindCounts: null,
        });
    render(<MediaPickerDialog currentAssetId="" loadMedia={loadMedia} onClose={() => {}} onSelect={() => {}} />);

    expect(await screen.findByText("Search continues")).toBeVisible();
    expect(screen.getByText("No matches on this page. Continue to search more items.")).toBeVisible();
    expect(screen.queryByText("No images found")).toBeNull();
    const countStatus = document.querySelector(".media-picker-count[role=status]");
    expect(countStatus?.querySelector("[role=status]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByRole("button", { name: /^News desk/ })).toBeVisible();
    expect(document.querySelector(".media-picker-count[role=status]")).toBe(countStatus);
    expect(countStatus?.querySelector("[role=status]")).toBeNull();
  });

  it("keeps Previous on an empty terminal cursor page after earlier matches", async () => {
    const loadMedia = vi.fn(async (query) => query.cursor
      ? {
          success: true as const, records: [], paging: "cursor" as const,
          nextCursor: null, total: 1, allCount: null, page: 2, pageCount: null,
          categoryCounts: null, kindCounts: null,
        }
      : {
          success: true as const, records: [image], paging: "cursor" as const,
          nextCursor: "cursor_page_2_token_1234567890ab", total: null, allCount: null,
          page: 1, pageCount: null, categoryCounts: null, kindCounts: null,
        });
    render(<MediaPickerDialog currentAssetId="" loadMedia={loadMedia} onClose={() => {}} onSelect={() => {}} />);

    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("No matches on this page", { selector: ".empty-state-title" })).toBeVisible();
    expect(screen.getByText("No matches on this page. Return to a previous page.")).toBeVisible();
    expect(screen.queryByText("No images found")).toBeNull();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("keeps the picker choose-only when upload permission is absent", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /^News desk/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upload image" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the picker choose-only when managed categories are unavailable", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        uploadMedia={vi.fn()}
        defaultUploadCategory="news"
        canUploadCategory={() => true}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /^News desk/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upload image" }),
    ).not.toBeInTheDocument();
  });

  it("uses another active managed category when the preferred one is archived", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());
    const categories: MediaCategoryDefinition[] = [
      { ...mediaCategories[0], active: false, canUpload: false },
      {
        ...mediaCategories[0],
        id: "local-news",
        label: "Local news",
        active: true,
        canUpload: true,
      },
    ];
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        uploadMedia={vi.fn()}
        defaultUploadCategory="news"
        canUploadCategory={() => true}
        categories={categories}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue(
      "local-news",
    );
    expect(
      screen.getByRole("combobox", { name: "Category" }).querySelector('option[value="news"]'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Local news — Newsroom media" })).toBeVisible();
  });

  it("reports dirty upload metadata to its host and protects browser unload", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());
    const onDirtyChange = vi.fn();
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        uploadMedia={vi.fn()}
        defaultUploadCategory="news"
        canUploadCategory={() => true}
        categories={mediaCategories}
        onDirtyChange={onDirtyChange}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    fireEvent.change(screen.getByLabelText(/File/), {
      target: {
        files: [
          new File(["image bytes"], "field-report.png", {
            type: "image/png",
          }),
        ],
      },
    });
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith(true),
    );
    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Remove file" }));
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith(false),
    );
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it("uploads, reloads, and selects a committed image", async () => {
    const loadMedia = vi
      .fn()
      .mockResolvedValueOnce(selection())
      .mockResolvedValueOnce({
        ...selection(),
        records: [uploadedImage, image],
        total: 2,
        allCount: 2,
      });
    const uploadMedia = vi.fn().mockResolvedValue({
      success: true as const,
      asset: uploadedImage,
    });
    const onSelect = vi.fn();
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        uploadMedia={uploadMedia}
        defaultUploadCategory="news"
        canUploadCategory={(category) => category === "news"}
        categories={mediaCategories}
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );

    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    const fileInput = screen.getByLabelText(/File/);
    expect(fileInput).toHaveFocus();
    const file = new File(["image bytes"], "field-report.png", {
      type: "image/png",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );

    await waitFor(() => {
      expect(uploadMedia).toHaveBeenCalledWith(
        file,
        expect.objectContaining({
          category: "news",
          license: "NJ PBS owned",
        }),
        expect.any(AbortSignal),
      );
      expect(loadMedia).toHaveBeenLastCalledWith({
        q: "",
        categories: [],
        kinds: ["image"],
        sort: "updatedAt",
        direction: "desc",
        page: 1,
      });
      expect(onSelect).toHaveBeenCalledWith(uploadedImage);
    });
  });

  it("rejects a document before the image-only uploader is called", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());
    const uploadMedia = vi.fn();
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        uploadMedia={uploadMedia}
        defaultUploadCategory="news"
        canUploadCategory={() => true}
        categories={mediaCategories}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    fireEvent.change(screen.getByLabelText(/File/), {
      target: {
        files: [
          new File(["document bytes"], "notes.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Batch license default" }),
      { target: { value: "NJ PBS owned" } },
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );

    expect(
      await screen.findByText("Choose a JPEG, PNG, WebP, GIF, or AVIF file."),
    ).toBeVisible();
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it("keeps a committed upload selectable when the list reload fails", async () => {
    const loadMedia = vi
      .fn()
      .mockResolvedValueOnce(selection())
      .mockRejectedValueOnce(new Error("The image list is unavailable."));
    const uploadMedia = vi.fn().mockResolvedValue({
      success: true as const,
      asset: uploadedImage,
    });
    const onSelect = vi.fn();
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        uploadMedia={uploadMedia}
        defaultUploadCategory="news"
        canUploadCategory={() => true}
        categories={mediaCategories}
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );

    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    fireEvent.change(screen.getByLabelText(/File/), {
      target: {
        files: [
          new File(["image bytes"], "field-report.png", {
            type: "image/png",
          }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );

    expect(
      await screen.findByText(/was uploaded, but the image list did not refresh/),
    ).toBeVisible();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Use uploaded image" }),
    );
    expect(onSelect).toHaveBeenCalledWith(uploadedImage);
  });

  it("reloads once after an image batch and requires one explicit insertion choice", async () => {
    const secondUploadedImage = {
      ...uploadedImage,
      id: "asset-uploaded-two",
      name: "Capitol exterior",
      originalName: "capitol.png",
      url: "https://media.njpbs.org/capitol.png",
      etag: '"media.YXNzZXQtdXBsb2FkZWQtdHdv.1"',
    };
    const loadMedia = vi
      .fn()
      .mockResolvedValueOnce(selection())
      .mockResolvedValueOnce({
        ...selection(),
        records: [secondUploadedImage, uploadedImage, image],
        total: 3,
        allCount: 3,
      });
    const uploadMedia = vi
      .fn()
      .mockResolvedValueOnce({ success: true as const, asset: uploadedImage })
      .mockResolvedValueOnce({
        success: true as const,
        asset: secondUploadedImage,
      });
    const onSelect = vi.fn();
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        uploadMedia={uploadMedia}
        defaultUploadCategory="news"
        canUploadCategory={() => true}
        categories={mediaCategories}
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );

    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "field-report.png", { type: "image/png" }),
          new File(["two"], "capitol.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("File 2 of 2")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    expect(await screen.findByText("Images uploaded")).toBeInTheDocument();
    await waitFor(() => expect(loadMedia).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("region", { name: "Upload batch receipt" }),
    ).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Use Capitol exterior" }),
    );
    expect(onSelect).toHaveBeenCalledWith(secondUploadedImage);
  });

  it("reloads and focuses a receipt after leaving a partially uploaded batch", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());
    const uploadMedia = vi
      .fn()
      .mockResolvedValueOnce({ success: true as const, asset: uploadedImage });
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        uploadMedia={uploadMedia}
        defaultUploadCategory="news"
        canUploadCategory={() => true}
        categories={mediaCategories}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "field-report.png", { type: "image/png" }),
          new File(["two"], "pending.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("File 2 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Discard and leave" }),
    );

    const receipt = await screen.findByRole("region", {
      name: "Upload batch receipt",
    });
    await waitFor(() => expect(loadMedia).toHaveBeenCalledTimes(2));
    expect(receipt).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Use Field report" }),
    ).toBeVisible();
  });

  it("keeps a duplicate failure retryable and aborts an active upload", async () => {
    const loadMedia = vi.fn().mockResolvedValue(selection());
    let activeSignal: AbortSignal | null = null;
    const uploadMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error("This file is already in station media."))
      .mockImplementationOnce(
        async (_file, _metadata, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            activeSignal = signal;
            signal.addEventListener(
              "abort",
              () => reject(new Error("The upload was canceled.")),
              { once: true },
            );
          }),
      );
    render(
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={loadMedia}
        uploadMedia={uploadMedia}
        defaultUploadCategory="news"
        canUploadCategory={() => true}
        categories={mediaCategories}
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );

    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    fireEvent.change(screen.getByLabelText(/File/), {
      target: {
        files: [
          new File(["image bytes"], "field-report.png", {
            type: "image/png",
          }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );

    expect(
      await screen.findByText("This file is already in station media."),
    ).toBeInTheDocument();
    fireEvent.submit(
      screen.getByRole("button", { name: "Retry upload" }).closest("form")!,
    );
    await waitFor(() => expect(activeSignal).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Stop upload" }));

    expect(
      await screen.findByText("The upload was canceled."),
    ).toBeInTheDocument();
    expect((activeSignal as AbortSignal | null)?.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(
      screen.getByRole("button", { name: "Upload image" }),
    ).toHaveFocus();
  });
});
