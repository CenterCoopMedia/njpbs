import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContentShelfPicker,
  ContentShelfSources,
  postShelfCard,
} from "../src/components/ContentShelfPicker";
import type { LoadedRecord } from "../src/components/EditorWorkspace";
import type { LibrarySelection } from "../src/lib/content-library";

afterEach(cleanup);

function postRecord(): Record<string, unknown> {
  return {
    id: "post-1",
    status: "published",
    title: "Working headline",
    summary: "Working summary",
    slug: "working-destination",
    heroImage: "working-image",
    heroImageAlt: "Working image alt",
    heroImageDecorative: false,
    publiclyVisible: true,
    publicSourceVersion: 3,
    published: {
      sourceVersion: 3,
      metadata: {
        title: "Published headline",
        summary: "Published summary",
        slug: "published-destination",
        heroImage: "published-image",
        heroImageAlt: "",
        heroImageDecorative: true,
      },
    },
  };
}

function readyPost(): LoadedRecord {
  return { status: "ready", record: postRecord() };
}

function selection(): LibrarySelection {
  return {
    records: [{
      id: "post-1",
      kind: "post",
      liveSourceVersion: 3,
      status: "published",
      title: "Published headline",
    }],
    total: 1,
    allCount: 1,
    mineCount: 0,
    assignedCount: 0,
    page: 1,
    pageCount: 1,
    statusCounts: {
      draft: 0,
      in_review: 0,
      approved: 0,
      scheduled: 0,
      published: 1,
      archived: 0,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("Content shelf picker", () => {
  it("loads published pages on open and uses only their live destinations", async () => {
    const loadPages = vi.fn(async () => [
      {
        id: "watch",
        title: "Stored Watch page",
        path: "/watch-draft/",
        published: true,
        livePath: "/watch-live/",
      },
      {
        id: "about",
        title: "Unpublished About draft",
        path: "/about-draft/",
        published: false,
      },
      {
        id: "page-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        title: "Published custom page",
        path: "/custom-draft/",
        published: true,
        livePath: "/custom-live/",
      },
      {
        id: "page-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        title: "Never-published custom draft",
        path: "/private-draft/",
        published: false,
      },
    ]);
    const onAdd = vi.fn();
    render(
      <ContentShelfSources.Provider value={{ loadPages }}>
        <ContentShelfPicker disabled={false} onAdd={onAdd} />
      </ContentShelfSources.Provider>,
    );

    expect(loadPages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Add existing content"));

    fireEvent.click(await screen.findByRole("button", { name: "Add Stored Watch page" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Published custom page" }));
    fireEvent.click(screen.getByRole("button", { name: "Add About NJ PBS" }));

    expect(loadPages).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Add Never-published custom draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Unpublished About draft" })).not.toBeInTheDocument();
    expect(onAdd).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: "Stored Watch page",
      href: "/watch-live/",
    }));
    expect(onAdd).toHaveBeenNthCalledWith(2, expect.objectContaining({
      title: "Published custom page",
      href: "/custom-live/",
    }));
    expect(onAdd).toHaveBeenNthCalledWith(3, expect.objectContaining({
      title: "About NJ PBS",
      href: "/about/",
    }));
  });

  it("keeps built-in pages when no page loader is available", () => {
    render(<ContentShelfPicker disabled={false} onAdd={vi.fn()} />);

    fireEvent.click(screen.getByText("Add existing content"));

    expect(screen.getByRole("button", { name: "Add Home" })).toBeEnabled();
  });

  it("copies only published post metadata and requires a safe published destination", () => {
    expect(postShelfCard(postRecord())).toEqual({
      itemId: expect.any(String),
      title: "Published headline",
      summary: "Published summary",
      imageAssetId: "published-image",
      alt: "",
      altDecorative: true,
      href: "/posts/published-destination/",
    });

    for (const metadata of [
      { title: "No slug" },
      { title: "Unsafe slug", slug: "../../private" },
    ]) {
      expect(() => postShelfCard({ ...postRecord(), published: { sourceVersion: 3, metadata } })).toThrow(
        "This post has no published destination.",
      );
    }
  });

  it("uses a live reopened snapshot and rejects unsettled publications", () => {
    expect(postShelfCard({ ...postRecord(), status: "draft" }).title).toBe("Published headline");
    for (const state of [
      { publiclyVisible: false },
      { publishBuildPending: true },
      { publicSourceVersion: 2 },
      { deleted: true },
    ]) expect(() => postShelfCard({ ...postRecord(), ...state })).toThrow("settled public snapshot");
  });

  it.each([
    [null, "", ""],
    [{ kind: "future", data: {} }, "", ""],
    [{ kind: "image", data: { assetId: "new-image", alt: "Current lead" } }, "new-image", "Current lead"],
    [{ kind: "embed", data: { url: "https://youtu.be/abcdefghijk", title: "Current video" }, posterAssetId: "new-poster" }, "new-poster", "Current video"],
    [{ kind: "linked-video", data: { url: "https://example.org/video", title: "Current video" } }, "", "Current video"],
    [{ kind: "library-video", data: { sourceId: "video-library", assetId: "video-one", title: "", caption: "Current caption" }, posterAssetId: "library-poster" }, "library-poster", "Current caption"],
  ])("copies the selected lead into shelf and Home cards without reviving the legacy image (%j)", (leadMedia, imageAssetId, alt) => {
    const record = postRecord();
    const published = record.published as { sourceVersion: number; metadata: Record<string, unknown> };
    const selected = { ...record, published: { ...published, metadata: { ...published.metadata, leadMedia } } };
    expect(postShelfCard(selected)).toMatchObject({ imageAssetId, alt });
    expect(postShelfCard(selected)).not.toHaveProperty("altDecorative");
  });

  it("searches across working statuses for live posts and adds the selected published card", async () => {
    const loadLibrarySelection = vi.fn(async () => selection());
    const loadRecord = vi.fn(async () => readyPost());
    const onAdd = vi.fn();
    render(
      <ContentShelfSources.Provider value={{ loadLibrarySelection, loadRecord }}>
        <ContentShelfPicker disabled={false} onAdd={onAdd} />
      </ContentShelfSources.Provider>,
    );

    fireEvent.click(screen.getByText("Add existing content"));
    fireEvent.change(screen.getByRole("combobox", { name: "Content type" }), {
      target: { value: "post" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Find content" }), {
      target: { value: "headline" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search posts" }));

    await waitFor(() => expect(loadLibrarySelection).toHaveBeenCalledWith(
      expect.objectContaining({
        types: ["post"],
        statuses: [],
        q: "headline",
        page: 1,
      }),
    ));
    fireEvent.click(await screen.findByRole("button", { name: "Add Published headline" }));

    await waitFor(() => expect(loadRecord).toHaveBeenCalledWith("post", "post-1"));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Published headline",
        href: "/posts/published-destination/",
      }),
    ));
  });

  it("does not add a delayed post after the shelf reaches its cap", async () => {
    const delayed = deferred<LoadedRecord>();
    const loadLibrarySelection = vi.fn(async () => selection());
    const loadRecord = vi.fn(() => delayed.promise);
    const onAdd = vi.fn();
    const picker = (disabled: boolean) => (
      <ContentShelfSources.Provider value={{ loadLibrarySelection, loadRecord }}>
        <ContentShelfPicker disabled={disabled} onAdd={onAdd} />
      </ContentShelfSources.Provider>
    );
    const view = render(picker(false));

    fireEvent.click(screen.getByText("Add existing content"));
    fireEvent.change(screen.getByRole("combobox", { name: "Content type" }), {
      target: { value: "post" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search posts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Published headline" }));
    await waitFor(() => expect(loadRecord).toHaveBeenCalledWith("post", "post-1"));

    view.rerender(picker(true));
    await act(async () => delayed.resolve(readyPost()));
    await waitFor(() => {
      expect(screen.getByRole("status")).not.toHaveTextContent("Loading content");
    });
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("library-video copy guidance (#3613)", () => {
  it.each([
    ["generated only", { kind: "library-video", data: { sourceId: "video-library", assetId: "video-one", title: "Current video" } }, true],
    ["explicit poster", { kind: "library-video", data: { sourceId: "video-library", assetId: "video-one", title: "Current video" }, posterAssetId: "poster-image" }, false],
    ["cleared", null, false],
    ["replaced image", { kind: "image", data: { assetId: "replacement-image", alt: "Replacement" } }, false],
  ])("copies %s without an unchecked image URL and gives the relevant repair", async (_name, leadMedia, needsPoster) => {
    const record = postRecord();
    const published = record.published as { sourceVersion: number; metadata: Record<string, unknown> };
    const onAdd = vi.fn();
    render(<ContentShelfSources.Provider value={{
      loadLibrarySelection: async () => selection(),
      loadRecord: async () => ({ status: "ready", record: { ...record, published: { ...published, metadata: { ...published.metadata, leadMedia } } } }),
    }}><ContentShelfPicker disabled={false} onAdd={onAdd} /></ContentShelfSources.Provider>);
    fireEvent.click(screen.getByText("Add existing content"));
    fireEvent.change(screen.getByLabelText("Content type"), { target: { value: "post" } });
    fireEvent.click(screen.getByRole("button", { name: "Search posts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Published headline" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
    const copied = onAdd.mock.calls[0][0];
    expect(copied.imageAssetId).toBe(needsPoster || leadMedia === null ? "" : leadMedia.kind === "image" ? "replacement-image" : "poster-image");
    expect(copied).not.toHaveProperty("imageUrl");
    expect(screen.getByRole("status").textContent?.includes("Generated video posters are not copied.")).toBe(needsPoster);
  });
});

it("preserves the bound Home notice for a generated-only video instead of asking staff to copy it again", async () => {
  const record = postRecord();
  const published = record.published as { sourceVersion: number; metadata: Record<string, unknown> };
  const onAddPost = vi.fn();
  render(<ContentShelfSources.Provider value={{loadLibrarySelection:async()=>selection(), loadRecord:async()=>({status:"ready",record:{...record,published:{...published,metadata:{...published.metadata,leadMedia:{kind:"library-video",data:{sourceId:"video-library",assetId:"video-one",title:"Video"}}}}}})}}>
    <ContentShelfPicker disabled={false} onAdd={vi.fn()} onAddPost={onAddPost}/>
  </ContentShelfSources.Provider>);
  fireEvent.click(screen.getByText("Add existing content"));
  fireEvent.change(screen.getByLabelText("Content type"),{target:{value:"post"}});
  fireEvent.click(screen.getByRole("button",{name:"Search posts"}));
  fireEvent.click(await screen.findByRole("button",{name:"Add Published headline"}));
  await waitFor(()=>expect(onAddPost).toHaveBeenCalledOnce());
  expect(screen.getByRole("status")).toHaveTextContent("Blank hero fields follow its published story.");
  expect(screen.getByRole("status")).not.toHaveTextContent("Generated video posters are not copied");
});
