import { settingsPublicationFixture } from "./settings-publication-fixture";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  PublicSiteChromeSettings,
  type PublicSiteChromeSettingsTransport,
  type PublicSiteChromeValues,
} from "../src/components/PublicSiteChromeSettings";
import { DEFAULT_PUBLIC_SITE_CHROME_SETTINGS } from "../../packages/content-core/src/cms-settings";
import { HttpError, type GetSettingsResponse, type MutateSettingsResponse } from "../src/lib/functions";

function values(
  overrides: Partial<PublicSiteChromeValues> = {},
): PublicSiteChromeValues {
  return {
    ...DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
    newsletterLabel: "Newsletter",
    ...overrides,
  };
}

function documentResponse(
  settingValues: PublicSiteChromeValues,
  version = 4,
  published?: {
    values: PublicSiteChromeValues;
    sourceVersion: number;
    publishedAt: string;
  },
): GetSettingsResponse<PublicSiteChromeValues> {
  return {
    success: true,
    found: true,
    id: PUBLIC_SITE_CHROME_SETTINGS_ID,
    settings: {
      schemaVersion: 1,
      values: settingValues,
      version,
      ...(published ? { published: { schemaVersion: 1, ...published } } : {}),
    },
  };
}

function mutationResponse(
  settingValues: PublicSiteChromeValues,
  version: number,
  published?: {
    values: PublicSiteChromeValues;
    sourceVersion: number;
    publishedAt: string;
  },
): MutateSettingsResponse<PublicSiteChromeValues> {
  const loaded = documentResponse(settingValues, version, published);
  if (!loaded.found) throw new Error("Expected settings");
  return {
    success: true,
    changed: true,
    id: PUBLIC_SITE_CHROME_SETTINGS_ID,
    settings: loaded.settings,
    ...(published ? { publication: settingsPublicationFixture(published.sourceVersion) } : {}),
  };
}

function transport(
  overrides: Partial<PublicSiteChromeSettingsTransport> = {},
): PublicSiteChromeSettingsTransport {
  return {
    load: vi.fn(async () => documentResponse(values())),
    save: vi.fn(async (request) =>
      mutationResponse(request.values as PublicSiteChromeValues, 5)),
    publish: vi.fn(async () => mutationResponse(values(), 5, {
      values: values(),
      sourceVersion: 4,
      publishedAt: "2026-09-21T19:00:00.000Z",
    })),
    ...overrides,
  };
}

describe("Public-site chrome settings", () => {
  it("refuses a malformed stored document", async () => {
    render(<PublicSiteChromeSettings {...transport({
      load: vi.fn(async () => ({
        ...documentResponse(values()),
        settings: {
          ...mutationResponse(values(), 4).settings,
          version: 0,
        },
      } as GetSettingsResponse<PublicSiteChromeValues>)),
    })} />);

    expect(await screen.findByText("Public header settings could not be loaded"))
      .toBeVisible();
  });

  it("seeds a missing document with the current public header behavior", async () => {
    render(<PublicSiteChromeSettings {...transport({
      load: vi.fn(async () => ({
        success: true as const,
        found: false as const,
        id: PUBLIC_SITE_CHROME_SETTINGS_ID,
      })),
    })} />);

    expect(await screen.findByRole("heading", {
      name: "Public header newsletter action",
    })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Show newsletter action" }))
      .toBeChecked();
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue(
      DEFAULT_PUBLIC_SITE_CHROME_SETTINGS.newsletterLabel,
    );
    expect(screen.getByRole("textbox", { name: "Destination URL" })).toHaveValue(
      DEFAULT_PUBLIC_SITE_CHROME_SETTINGS.newsletterHref,
    );
    expect(screen.getByRole("checkbox", { name: "Open newsletter action in a new tab" }))
      .not.toBeChecked();
    expect(screen.getByText("Draft not saved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("saves the exact source-default document without publishing", async () => {
    const save = vi.fn(async (request) =>
      mutationResponse(request.values as PublicSiteChromeValues, 1));
    const publish = vi.fn();
    render(<PublicSiteChromeSettings {...transport({
      load: vi.fn(async () => ({
        success: true as const,
        found: false as const,
        id: PUBLIC_SITE_CHROME_SETTINGS_ID,
      })),
      save,
      publish,
    })} />);

    fireEvent.change(await screen.findByRole("textbox", { name: "Label" }), {
      target: { value: "Newsletter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      id: PUBLIC_SITE_CHROME_SETTINGS_ID,
      createOnly: true,
      values: {
        ...DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
        newsletterLabel: "Newsletter",
      },
    }));
    expect(await screen.findByText("Public header draft saved.")).toBeVisible();
    expect(publish).not.toHaveBeenCalled();
  });

  it("blocks unsafe destinations and previews explicit new-tab behavior", async () => {
    render(<PublicSiteChromeSettings {...transport()} />);
    const href = await screen.findByRole("textbox", { name: "Destination URL" });
    fireEvent.change(href, { target: { value: "javascript:alert(1)" } });
    expect(screen.getByText("Enter a safe newsletter URL.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();

    fireEvent.change(href, { target: { value: "newsletter" } });
    expect(screen.getByText("Enter a full web address, or a site path that starts with /."))
      .toBeVisible();
    expect(href).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();

    fireEvent.change(href, { target: { value: "/newsletter/" } });
    expect(within(screen.getByLabelText("Proposed public header preview"))
      .getByRole("link")).toHaveAttribute("href", "https://njpbs.org/newsletter/");

    fireEvent.change(href, { target: { value: "https://example.org/newsletter" } });
    fireEvent.click(screen.getByRole("checkbox", {
      name: "Open newsletter action in a new tab",
    }));
    const preview = screen.getByLabelText("Proposed public header preview");
    expect(within(preview).getByRole("link", { name: /Newsletter/ }))
      .toHaveAttribute("target", "_blank");
    expect(within(preview).getByText("(opens in new tab)")).toBeVisible();
  });

  it("publishes the saved version and queues its exact source version", async () => {
    const publish = vi.fn(async () => mutationResponse(values(), 5, {
      values: values(),
      sourceVersion: 4,
      publishedAt: "2026-09-21T19:00:00.000Z",
    }));
    render(<PublicSiteChromeSettings {...transport({ publish })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith({
      id: PUBLIC_SITE_CHROME_SETTINGS_ID,
      baseVersion: 4,
    }));
    expect(await screen.findByText(/Updating the site/)).toBeVisible();
  });
});

describe("addressed settings receipt status", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for all consumers and keeps local edits while status is refreshed", async () => {
    vi.useFakeTimers();
    const published = { values: values(), sourceVersion: 4, publishedAt: "2026-09-21T19:00:00.000Z" };
    const loaded = documentResponse(values({ newsletterLabel: "A remote private draft" }), 6, published);
    const load = vi.fn().mockResolvedValueOnce(documentResponse(values()))
      .mockResolvedValueOnce({ ...loaded, publication: settingsPublicationFixture(4, { missingConsumers: ["pages"] }) })
      .mockResolvedValueOnce({ ...loaded, publication: settingsPublicationFixture(4, { status: "success", missingConsumers: [] }) });
    const props = transport({ load });
    await act(async () => { render(<PublicSiteChromeSettings {...props} />); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Publish" })); });
    expect(screen.getByText(/Updating the site/)).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Label" }), { target: { value: "Local unsaved label" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.queryByText("The site update is complete.")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue("Local unsaved label");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText("The site update is complete.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue("Local unsaved label");
    expect(props.publish).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("stops polling an overdue receipt and retries its accepted version without saving local edits", async () => {
    vi.useFakeTimers();
    const pub = { values: values(), sourceVersion: 4, publishedAt: "2026-09-21T19:00:00.000Z" };
    const loaded = documentResponse(values(), 5, pub);
    const load = vi.fn(async () => ({ ...loaded, publication: settingsPublicationFixture(4, {
      warning: "The site update is taking longer than expected. Retry publication.",
    }) }));
    const props = transport({ load });
    await act(async () => { render(<PublicSiteChromeSettings {...props} />); });
    fireEvent.change(screen.getByRole("textbox", { name: "Label" }), { target: { value: "Local unsaved label" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry site update" })); });
    expect(props.publish).toHaveBeenCalledWith({ id: PUBLIC_SITE_CHROME_SETTINGS_ID, baseVersion: 4 });
    expect(props.save).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue("Local unsaved label");
    expect(screen.getByText(/Updating the site/)).toBeVisible();
  });

  it("refreshes a changed publication without replacing the saved or unsaved draft", async () => {
    vi.useFakeTimers();
    const pub = { values: values(), sourceVersion: 4, publishedAt: "2026-09-21T19:00:00.000Z" };
    const loaded = documentResponse(values(), 5, pub);
    const newer = documentResponse(values({ newsletterLabel: "Remote private draft" }), 8, {
      ...pub, sourceVersion: 6,
    });
    const load = vi.fn().mockResolvedValueOnce({ ...loaded, publication: settingsPublicationFixture(4) })
      .mockResolvedValue({ ...newer, publication: settingsPublicationFixture(6, {
        originalOperationId: "newer-settings", status: "success", missingConsumers: [],
      }) });
    const props = transport({ load });
    await act(async () => { render(<PublicSiteChromeSettings {...props} />); });
    fireEvent.change(screen.getByRole("textbox", { name: "Label" }), { target: { value: "Local unsaved label" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText(/This publication changed/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry site update" })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh site update" })); });
    expect(screen.getByText("The site update is complete.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue("Local unsaved label");
    expect(screen.getByText("Saved draft version 5")).toBeVisible();
    expect(props.publish).not.toHaveBeenCalled();
    expect(props.save).not.toHaveBeenCalled();
  });

  it.each([
    "A public code release is in progress. Try this publication again shortly.",
    "Public publication is paused by the billing control.",
  ])("preserves the retry refusal: %s", async (message) => {
    const pub = { values: values(), sourceVersion: 4, publishedAt: "2026-09-21T19:00:00.000Z" };
    const loaded = documentResponse(values(), 5, pub);
    const props = transport({
      load: vi.fn(async () => ({ ...loaded, publication: settingsPublicationFixture(4, {
        warning: "The site update is taking longer than expected. Retry publication.",
      }) })),
      publish: vi.fn(async () => { throw new HttpError(409, message); }),
    });
    render(<PublicSiteChromeSettings {...props} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Label" }), { target: { value: "Unsaved label" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry site update" }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry site update" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Refresh site update" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue("Unsaved label");
    expect(props.save).not.toHaveBeenCalled();
  });
});
