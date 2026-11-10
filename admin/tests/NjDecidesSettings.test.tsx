import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { settingsPublicationFixture } from "./settings-publication-fixture";
import {
  DEFAULT_NJ_DECIDES_SETTINGS,
  NJ_DECIDES_SETTINGS_ID,
} from "../../packages/content-core/src/cms-settings";
import {
  NjDecidesSettings,
  type NjDecidesSettingsTransport,
  type NjDecidesValues,
} from "../src/components/NjDecidesSettings";
import {
  HttpError,
  type GetSettingsResponse,
  type MediaAssetSummary,
  type MutateSettingsResponse,
} from "../src/lib/functions";

function values(overrides: Partial<NjDecidesValues> = {}): NjDecidesValues {
  return { ...DEFAULT_NJ_DECIDES_SETTINGS, ...overrides };
}

function documentResponse(
  settingValues: NjDecidesValues,
  version = 4,
  published?: {
    values: NjDecidesValues;
    sourceVersion: number;
    publishedAt: string;
  },
): GetSettingsResponse<NjDecidesValues> {
  return {
    success: true,
    found: true,
    id: NJ_DECIDES_SETTINGS_ID,
    settings: {
      schemaVersion: 1,
      values: settingValues,
      version,
      ...(published ? { published: { schemaVersion: 1, ...published } } : {}),
    },
  };
}

function mutationResponse(
  settingValues: NjDecidesValues,
  version: number,
  published?: {
    values: NjDecidesValues;
    sourceVersion: number;
    publishedAt: string;
  },
): MutateSettingsResponse<NjDecidesValues> {
  const loaded = documentResponse(settingValues, version, published);
  if (!loaded.found) throw new Error("Expected settings");
  return {
    success: true,
    changed: true,
    id: NJ_DECIDES_SETTINGS_ID,
    settings: loaded.settings,
    ...(published
      ? { publication: settingsPublicationFixture(published.sourceVersion) }
      : {}),
  };
}

function transport(
  overrides: Partial<NjDecidesSettingsTransport> = {},
): NjDecidesSettingsTransport {
  return {
    load: vi.fn(async () => documentResponse(values())),
    save: vi.fn(async (request) =>
      mutationResponse(request.values as NjDecidesValues, 5)),
    publish: vi.fn(async () => mutationResponse(values(), 5, {
      values: values(),
      sourceVersion: 4,
      publishedAt: "2026-10-26T16:00:00.000Z",
    })),
    ...overrides,
  };
}

function mediaAsset(
  id: string,
  overrides: Partial<MediaAssetSummary> = {},
): MediaAssetSummary {
  return {
    id,
    name: id === "custom-logo" ? "Custom logo" : "Background artwork",
    originalName: `${id}.png`,
    category: "general",
    categories: ["general"],
    tags: [],
    description: null,
    altText: null,
    license: null,
    credit: null,
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 2_000,
    width: 800,
    height: 400,
    url: `/media/${id}.png`,
    lifecycle: "active",
    version: 1,
    etag: `${id}-etag`,
    createdAt: null,
    createdBy: null,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

describe("NJ Decides brand settings", () => {
  it("loads the source defaults and keeps an unsaved document unpublished", async () => {
    render(<NjDecidesSettings {...transport({
      load: vi.fn(async (): Promise<GetSettingsResponse<NjDecidesValues>> => ({
        success: true,
        found: false,
        id: NJ_DECIDES_SETTINGS_ID,
      })),
    })} />);

    expect(await screen.findByRole("heading", { name: "NJ Decides brand" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Background color" }))
      .toHaveValue(DEFAULT_NJ_DECIDES_SETTINGS.backgroundColor);
    expect(screen.getByRole("checkbox", { name: "Show the diagonal flag" })).toBeChecked();
    expect(screen.getByText("Draft not saved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeDisabled();
  });

  it("validates color format and both AA contrast pairs in plain language", async () => {
    render(<NjDecidesSettings {...transport()} />);
    const background = await screen.findByRole("textbox", { name: "Background color" });
    fireEvent.change(background, { target: { value: "#fff" } });
    expect(screen.getByText("Background color must use the #RRGGBB format.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();

    fireEvent.change(background, { target: { value: "#011375" } });
    expect(screen.getByText(
      "Text color must have at least 4.5:1 contrast against the background color.",
    )).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Text color" }), {
      target: { value: "#FFFFFF" },
    });
    expect(screen.getByText(
      "Link color must have at least 4.5:1 contrast against the background color.",
    )).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("resets colors, flag and custom images only in the local draft", async () => {
    const custom = values({
      backgroundColor: "#011375",
      textColor: "#FFFFFF",
      linkColor: "#FFFFFF",
      accentColor: "#FFFFFF",
      flagEnabled: false,
      logoAssetId: "custom-logo",
      logoAlt: "Custom election logo",
      backgroundAssetId: "custom-background",
    });
    const save = vi.fn();
    const publish = vi.fn();
    const loadMedia = vi.fn(async () => ({
      success: true as const,
      records: [mediaAsset("custom-logo"), mediaAsset("custom-background")],
      total: 2,
      allCount: 2,
      page: 1,
      pageCount: 1,
      categoryCounts: {},
      kindCounts: { image: 2 },
    }));
    render(<NjDecidesSettings {...transport({
      load: vi.fn(async () => documentResponse(custom)),
      loadMedia,
      save,
      publish,
    })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Reset to defaults" }));
    expect(screen.getByRole("textbox", { name: "Background color" }))
      .toHaveValue(DEFAULT_NJ_DECIDES_SETTINGS.backgroundColor);
    expect(screen.getByRole("checkbox", { name: "Show the diagonal flag" })).toBeChecked();
    expect(screen.queryByRole("textbox", { name: "Custom logo alternative text" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("saves a draft without publishing and then publishes its exact saved version", async () => {
    const saved = values({ accentColor: "#001A8A" });
    const save = vi.fn(async () => mutationResponse(saved, 1));
    const publish = vi.fn(async () => mutationResponse(saved, 2, {
      values: saved,
      sourceVersion: 1,
      publishedAt: "2026-10-26T16:00:00.000Z",
    }));
    render(<NjDecidesSettings {...transport({
      load: vi.fn(async (): Promise<GetSettingsResponse<NjDecidesValues>> => ({
        success: true,
        found: false,
        id: NJ_DECIDES_SETTINGS_ID,
      })),
      save,
      publish,
    })} />);

    fireEvent.change(await screen.findByRole("textbox", { name: "Accent color" }), {
      target: { value: "#001A8A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      id: NJ_DECIDES_SETTINGS_ID,
      createOnly: true,
      values: saved,
    }));
    expect(publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith({
      id: NJ_DECIDES_SETTINGS_ID,
      baseVersion: 1,
    }));
    expect(await screen.findByText(/Updating the site|site update is complete/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("keeps local values through a conflict and refreshes only the save precondition", async () => {
    const local = values({ accentColor: "#001A8A" });
    const load = vi.fn()
      .mockResolvedValueOnce(documentResponse(values(), 4))
      .mockResolvedValueOnce(documentResponse(values({ ruleColor: "#990000" }), 8));
    const save = vi.fn()
      .mockRejectedValueOnce(new HttpError(409, "This setting changed."))
      .mockResolvedValueOnce(mutationResponse(local, 9));
    render(<NjDecidesSettings {...transport({ load, save })} />);

    const accent = await screen.findByRole("textbox", { name: "Accent color" });
    fireEvent.change(accent, { target: { value: "#001A8A" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/Your local changes are still here/)).toBeVisible();
    expect(accent).toHaveValue("#001A8A");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", {
      name: "Check saved version and keep my changes",
    }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(accent).toHaveValue("#001A8A");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({
      id: NJ_DECIDES_SETTINGS_ID,
      baseVersion: 8,
      values: local,
    }));
  });

  it("rejects malformed stored values and shows a plain save validation error", async () => {
    const view = render(<NjDecidesSettings {...transport({
      load: vi.fn(async () => ({
        ...documentResponse(values()),
        settings: {
          ...mutationResponse(values(), 4).settings,
          values: { ...values(), unexpected: true },
        },
      } as unknown as GetSettingsResponse<NjDecidesValues>)),
    })} />);
    expect(await screen.findByText("NJ Decides brand settings could not be loaded"))
      .toBeVisible();
    view.unmount();

    const save = vi.fn(async () => {
      throw new HttpError(400, "Text color must have at least 4.5:1 contrast against the background color.");
    });
    render(<NjDecidesSettings {...transport({ save })} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Accent color" }), {
      target: { value: "#001A8A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(
      "Text color must have at least 4.5:1 contrast against the background color.",
    )).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Check saved version and keep my changes" })).not.toBeInTheDocument();
  });

  it("shows Media validation errors without entering the version conflict recovery", async () => {
    const save = vi.fn(async () => {
      throw new HttpError(400, "Media asset election-art must be a PNG, JPEG or WebP image.");
    });
    render(<NjDecidesSettings {...transport({ save })} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Accent color" }), {
      target: { value: "#001A8A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Media asset election-art must be a PNG, JPEG or WebP image.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Check saved version and keep my changes" })).not.toBeInTheDocument();
  });

  it("loads both saved images once and uses them in the preview asset map", async () => {
    const custom = values({
      logoAssetId: "custom-logo",
      logoAlt: "Custom election logo",
      backgroundAssetId: "custom-background",
    });
    const assets = [mediaAsset("custom-logo"), mediaAsset("custom-background")];
    const loadMedia = vi.fn(async () => ({
      success: true as const,
      records: assets,
      total: 2,
      allCount: 2,
      page: 1,
      pageCount: 1,
      categoryCounts: {},
      kindCounts: { image: 2 },
    }));
    render(<NjDecidesSettings {...transport({
      load: vi.fn(async () => documentResponse(custom)),
      loadMedia,
    })} />);

    await waitFor(() => expect(loadMedia).toHaveBeenCalledTimes(1));
    expect(loadMedia).toHaveBeenCalledWith(expect.objectContaining({
      assetIds: ["custom-logo", "custom-background"],
      kinds: ["image"],
    }));
    const preview = await screen.findByLabelText("Proposed NJ Decides band preview");
    await waitFor(() => expect(within(preview).getByRole("img", {
      name: "Custom election logo",
    })).toHaveAttribute("src", "/media/custom-logo.png"));
    expect(preview.querySelector("img.nj-decides-band__background[src='/media/custom-background.png']"))
      .not.toBeNull();
    expect(loadMedia).toHaveBeenCalledTimes(1);
  });

  it("keeps a missing saved image explicit without adding media reads", async () => {
    const loadMedia = vi.fn(async () => ({
      success: true as const,
      records: [],
      total: 0,
      allCount: 0,
      page: 1,
      pageCount: 1,
      categoryCounts: {},
      kindCounts: { image: 0 },
    }));
    render(<NjDecidesSettings {...transport({
      load: vi.fn(async () => documentResponse(values({
        backgroundAssetId: "missing-background",
      }))),
      loadMedia,
    })} />);

    expect(await screen.findByText(/saved images are unavailable/)).toBeVisible();
    expect(loadMedia).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("retries failed saved artwork and restores controls (reset: %s)", async (reset) => {
    const background = mediaAsset("custom-background");
    const loadMedia = vi.fn()
      .mockRejectedValueOnce(new Error("Temporary read failure"))
      .mockResolvedValueOnce({
        success: true as const,
        records: [background],
        total: 1,
        allCount: 1,
        page: 1,
        pageCount: 1,
        categoryCounts: {},
        kindCounts: { image: 1 },
      });
    render(<NjDecidesSettings {...transport({
      load: vi.fn(async () => documentResponse(values({
        backgroundAssetId: background.id,
      }))),
      loadMedia,
    })} />);

    const retry = await screen.findByRole("button", { name: "Retry artwork load" });
    if (reset) {
      fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
      expect(retry).toBeVisible();
    }
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("button", {
      name: reset ? "Choose background artwork" : "Change background artwork",
    })).toBeEnabled());
    expect(loadMedia).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry artwork load" }))
      .not.toBeInTheDocument();
  });

  it("clears the previous alt text when a different custom logo is selected", async () => {
    const original = mediaAsset("custom-logo");
    const replacement = mediaAsset("replacement-logo", { name: "Replacement logo" });
    const loadMedia = vi.fn(async (query) => {
      const records = [original, replacement].filter(
        (asset) => !query.assetIds || query.assetIds.includes(asset.id),
      );
      return {
        success: true as const,
        records,
        total: records.length,
        allCount: records.length,
        page: 1,
        pageCount: 1,
        categoryCounts: {},
        kindCounts: { image: records.length },
      };
    });
    render(<NjDecidesSettings {...transport({
      load: vi.fn(async () => documentResponse(values({
        logoAssetId: original.id,
        logoAlt: "Old logo description",
      }))),
      loadMedia,
    })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Change custom logo" }));
    const picker = await screen.findByRole("dialog", { name: "Choose an image" });
    fireEvent.click(within(picker).getByRole("button", { name: /^Replacement logoCategory/ }));
    const alt = await screen.findByRole("textbox", {
      name: /^Custom logo alternative text/,
    });
    expect(alt).toHaveValue("");
    expect(screen.getByText("Add alternative text for the custom logo.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  });

  it("explains the logo alt text byte limit and allows a valid correction", async () => {
    const logo = mediaAsset("custom-logo");
    const loadMedia = vi.fn(async () => ({
      success: true as const,
      records: [logo],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: {},
      kindCounts: { image: 1 },
    }));
    render(<NjDecidesSettings {...transport({
      load: vi.fn(async () => documentResponse(values({
        logoAssetId: logo.id,
        logoAlt: "Custom election logo",
      }))),
      loadMedia,
    })} />);
    const alt = await screen.findByRole("textbox", {
      name: /^Custom logo alternative text/,
    });
    fireEvent.change(alt, { target: { value: "é".repeat(251) } });
    expect(screen.getByText("Logo alternative text can be at most 500 bytes."))
      .toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    fireEvent.change(alt, { target: { value: "é".repeat(250) } });
    expect(await screen.findByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("adds a selected image to the preview and prevents preview navigation", async () => {
    const logo = mediaAsset("custom-logo");
    const loadMedia = vi.fn(async () => ({
      success: true as const,
      records: [logo],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: {},
      kindCounts: { image: 1 },
    }));
    render(<NjDecidesSettings {...transport({ loadMedia })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose custom logo" }));
    const picker = await screen.findByRole("dialog", { name: "Choose an image" });
    fireEvent.click(within(picker).getByRole("button", { name: /^Custom logoCategory/ }));
    const alt = await screen.findByRole("textbox", {
      name: /^Custom logo alternative text/,
    });
    expect(screen.getByText("Add alternative text for the custom logo.")).toBeVisible();
    fireEvent.change(alt, { target: { value: "Custom election logo" } });
    const preview = screen.getByLabelText("Proposed NJ Decides band preview");
    expect(within(preview).getByRole("img", { name: "Custom election logo" }))
      .toHaveAttribute("src", "/media/custom-logo.png");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    within(preview).getByRole("link", { name: "Check registration" }).dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });
});
