import { useEffect, useState } from "react";
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImageViewer } from "../src/components/media/ImageViewer";
import type { MediaAssetSummary } from "../src/lib/functions";

const downloads = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/functions")>(),
  cmsCreateMediaDownload: downloads.create,
}));

vi.mock("../src/components/media/MediaInspector", () => ({
  MediaInspector: ({ asset, docked, onDirtyChange, onSavingChange }: {
    asset: MediaAssetSummary;
    docked: boolean;
    onDirtyChange: (dirty: boolean) => void;
    onSavingChange: (saving: boolean) => void;
  }) => {
    useEffect(() => {
      onDirtyChange(false);
      onSavingChange(false);
      return () => {
        onDirtyChange(false);
        onSavingChange(false);
      };
    }, [asset.id, onDirtyChange, onSavingChange]);
    return (
      <aside aria-label="Asset details" data-docked={docked || undefined}>
        <label>
          Name
          <input defaultValue={asset.name} onChange={() => onDirtyChange(true)} />
        </label>
      </aside>
    );
  },
}));

function image(id: string): MediaAssetSummary {
  return {
    id,
    name: `Image ${id}`,
    originalName: `${id}.jpg`,
    category: "news",
    categories: ["news"],
    tags: [],
    description: null,
    altText: `Description ${id}`,
    license: null,
    credit: null,
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 2_048,
    width: 1_600,
    height: 900,
    url: `https://media.example.test/${id}.jpg`,
    source: "upload",
    lifecycle: "active",
    version: 1,
    etag: `"${id}.1"`,
    createdAt: null,
    createdBy: null,
    updatedAt: null,
    updatedBy: null,
  };
}

const records = [image("one"), image("two"), image("three")];

function ViewerHarness({ initial = records[0], getIdToken }: {
  initial?: MediaAssetSummary;
  getIdToken?: () => Promise<string>;
}) {
  const [asset, setAsset] = useState(initial);
  return (
    <ImageViewer
      asset={asset}
      getIdToken={getIdToken}
      steppingOrder={records}
      categories={[]}
      canEdit
      deleteMedia={vi.fn()}
      onClose={vi.fn()}
      onDeleted={vi.fn()}
      onDirtyChange={vi.fn()}
      onReload={vi.fn()}
      onSaved={vi.fn()}
      onSavingChange={vi.fn()}
      onStep={setAsset}
      saveMetadata={vi.fn()}
    />
  );
}

describe("ImageViewer", () => {
  it("keeps one dialog mounted while it steps through original images", async () => {
    render(<ViewerHarness />);
    const dialog = screen.getByRole("dialog", { name: "Image one" });
    expect(screen.getByText("1 of 3")).toHaveAttribute("role", "status");
    expect(screen.getByRole("img", { name: "Description one" })).toHaveAttribute(
      "src",
      records[0].url,
    );
    expect(screen.getAllByRole("img")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Next file" }));

    expect(screen.getByRole("dialog", { name: "Image two" })).toBe(dialog);
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Description two" })).toHaveAttribute(
      "src",
      records[1].url,
    );
    expect(screen.getAllByRole("img")).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next file" })).toHaveFocus());
  });

  it("blocks a dirty step until changes are discarded", async () => {
    render(<ViewerHarness />);
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));

    expect(screen.getByText("Unsaved image changes")).toBeInTheDocument();
    expect(screen.getByText("Open the next item without saving your changes?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Image two");
  });

  it("shows an honest PDF placeholder and original link", () => {
    const pdf = {
      ...image("pdf"),
      name: "Board packet",
      originalName: "board-packet.pdf",
      mimeType: "application/pdf",
      kind: "document" as const,
      width: null,
      height: null,
      url: "https://media.example.test/board-packet.pdf",
    };
    render(<ViewerHarness initial={pdf} />);

    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open original" })).toHaveAttribute("href", pdf.url);
  });
});

it("puts file facts and the original download in the image header", () => {
  render(<ViewerHarness />);
  const header = screen.getByRole("dialog", { name: "Image one" }).querySelector("header")!;
  expect(within(header).getByRole("heading", { name: "Image one" })).toBeInTheDocument();
  expect(within(header).queryByText("Image preview")).not.toBeInTheDocument();
  expect(header).toHaveTextContent("JPEG · 1600 × 900 · 2.0 KB");
  expect(within(header).getByRole("button", { name: "Download" })).toBeInTheDocument();
  expect(header).not.toHaveTextContent("Delete");
});

it("saves the original through a signed attachment read without fetching the file into memory", async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const signed = "https://r2.example.test/one.jpg?response-content-disposition=attachment";
  downloads.create.mockReset().mockResolvedValue({
    success: true, url: signed, fileName: "one.jpg", expiresAt: "2026-10-06T12:05:00.000Z",
  });
  vi.stubGlobal("fetch", vi.fn());
  try {
    render(<ViewerHarness getIdToken={async () => "staff-token"} />);
    const title = screen.getByRole("heading", { name: "Image one" });
    expect(title).toHaveFocus();
    expect(title).toHaveClass("programmatic-focus-target");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Original/ }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(downloads.create).toHaveBeenCalledWith("staff-token", "one");
    expect(fetch).not.toHaveBeenCalled();
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.href).toBe(signed);
    expect(anchor.download).toBe("one.jpg");
    expect(anchor.target).toBe("");
    expect(anchor.rel).toBe("noreferrer");
  } finally {
    click.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("reports a refused download and does not open the public file", async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  downloads.create.mockReset().mockRejectedValue(new Error("Media asset is unavailable"));
  try {
    render(<ViewerHarness getIdToken={async () => "staff-token"} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Original/ }));
    expect(await screen.findByText("The file could not be downloaded")).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
  } finally {
    click.mockRestore();
  }
});

it("opens a built-in site image directly because it has no stored object to sign", () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  downloads.create.mockReset();
  const seed = { ...records[0], source: "site_seed" as const, url: "https://njpbs.org/images/one.jpg" };
  try {
    render(<ViewerHarness initial={seed} getIdToken={async () => "staff-token"} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Original/ }));
    expect(click).toHaveBeenCalledOnce();
    expect(downloads.create).not.toHaveBeenCalled();
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.href).toBe(seed.url);
    expect(anchor.target).toBe("_blank");
  } finally {
    click.mockRestore();
  }
});
