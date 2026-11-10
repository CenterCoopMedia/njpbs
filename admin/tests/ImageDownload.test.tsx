import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageDownload, ImageViewerHeaderActions } from "../src/components/media/ImageViewer";
import type { MediaAssetSummary } from "../src/lib/functions";

const asset: MediaAssetSummary = {
  id: "photo-1", name: "Boardwalk", originalName: "Boardwalk.jpg", category: "news", categories: ["news"],
  tags: [], description: null, altText: null, license: "Check rights", credit: null,
  mimeType: "image/webp", kind: "image", sizeBytes: 2048, width: 1600, height: 900,
  url: "https://media.example.test/photo.webp", source: "upload", lifecycle: "active", originalAvailable: true, originalFormat: "JPG",
  version: 1, etag: '"photo-1.1"', createdAt: null, createdBy: null, updatedAt: null, updatedBy: null,
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("ImageDownload choices and transport", () => {
  it("names the original without a format when an older summary has none", () => {
    render(<ImageDownload asset={{ ...asset, originalFormat: undefined }} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getByRole("menuitem", { name: /^Original \(full quality\)/ })).toBeEnabled();
  });
  it.each(["original", "web"] as const)("sends the shared header's chosen %s variant and saves only its signed attachment", async variant => {
    const fileName = variant === "original" ? "Boardwalk.jpg" : "Boardwalk.webp";
    const url = `https://r2.example.test/${fileName}?signed=fixture`;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ success: true, url, fileName, expiresAt: "2026-10-06T12:05:00Z" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ImageViewerHeaderActions asset={asset} getIdToken={async () => "fixture-token"} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: /Original \(JPG, full quality\)/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("menuitem", { name: variant === "original" ? /Original/ : /Web copy \(WebP\)/ }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ assetId: "photo-1", variant });
    const link = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(link.href).toBe(url);
    expect(link.download).toBe(fileName);
    expect(link.target).toBe("");
  });

  it("keeps a failed original visible and allows an explicit web retry without a silent fallback", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Media asset is unavailable" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, url: "https://r2.example.test/web", fileName: "Boardwalk.webp" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ImageDownload asset={asset} getIdToken={async () => "fixture-token"} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Original/ }));
    expect(await screen.findByText("The file could not be downloaded")).toBeVisible();
    expect(fetch).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Web copy/ }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ assetId: "photo-1", variant: "web" });
  });

  it("shows one choice without a retained original", () => {
    render(<ImageDownload asset={{ ...asset, originalAvailable: undefined }} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  });

  it("keeps site images on one direct download even if a stale availability flag arrives", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ImageDownload asset={{ ...asset, source: "site_seed" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("menuitem", { name: /Original/ }));
    expect(click).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
