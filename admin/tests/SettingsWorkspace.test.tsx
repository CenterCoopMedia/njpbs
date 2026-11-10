import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { SettingsWorkspace } from "../src/components/SettingsWorkspace";
import { PublicHomepageBannerSettings, type PublicHomepageBannerValues } from "../src/components/PublicHomepageBannerSettings";
import { PublicSiteChromeSettings } from "../src/components/PublicSiteChromeSettings";
import { NjDecidesSettings, type NjDecidesSettingsTransport } from "../src/components/NjDecidesSettings";
import { DEFAULT_NJ_DECIDES_SETTINGS, DEFAULT_PUBLIC_SITE_CHROME_SETTINGS } from "../../packages/content-core/src/cms-settings";
import type { MutateSettingsResponse } from "../src/lib/functions";

const standard: PublicHomepageBannerValues = { enabled: true, message: "Support public television.", linkLabel: "Make a gift", linkHref: "/support/", njDecides: false };
function bannerDocument(values = standard) {
  return { success: true as const, found: true as const, id: "public-homepage-banner", settings: { schemaVersion: 2, version: 4, values,
    published: { schemaVersion: 2, sourceVersion: 3, publishedAt: "2026-10-28T12:00:00.000Z", values: standard } } };
}
function setup({ save = vi.fn(async request => ({ success: true as const, changed: true, id: request.id, settings: { schemaVersion: 2, version: 5, values: request.values } })), initial = "/admin/settings", values = standard, brandProps = {} as Partial<NjDecidesSettingsTransport> } = {}) {
  const loadBanner = vi.fn(async () => bannerDocument(values));
  const loadBrand = vi.fn(async () => ({ success: true as const, found: true as const, id: "nj-decides-brand", settings: { schemaVersion: 1, version: 6, values: DEFAULT_NJ_DECIDES_SETTINGS } }));
  const loadChrome = vi.fn(async () => ({ success: true as const, found: true as const, id: "public-site-chrome", settings: { schemaVersion: 1, version: 2, values: DEFAULT_PUBLIC_SITE_CHROME_SETTINGS } }));
  const publish = vi.fn(async () => { throw new Error("Publication must be explicit."); });
  const sections = [
    { id: "public-homepage-banner", label: "Homepage banner", group: "Public website" as const, content: <PublicHomepageBannerSettings load={loadBanner} save={save} publish={publish} /> },
    { id: "nj-decides-brand", label: "NJ Decides brand", headingId: "nj-decides-settings-heading", group: "Public website" as const, content: <NjDecidesSettings load={loadBrand} save={save} publish={publish} {...brandProps} /> },
    { id: "public-site-chrome", label: "Header newsletter", group: "Public website" as const, content: <PublicSiteChromeSettings load={loadChrome} save={save} publish={publish} /> },
  ];
  const router = createMemoryRouter([
    { path: "/admin/settings", element: <SettingsWorkspace sections={sections} /> },
    { path: "/admin/settings/costs", element: <p>Costs destination</p> },
  ], { initialEntries: [initial] });
  const view = render(<RouterProvider router={router} />);
  return { ...view, router, save, publish, loadBanner, loadBrand, loadChrome };
}
function choose(name: string | RegExp) { fireEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name })); }

describe("Settings workspace state release gate", () => {
  it("shares the preview width across sections without saving or marking a draft dirty", async () => {
    const api = setup({ values: { ...standard, njDecides: true } });
    const desktop = await screen.findByRole("button", { name: "Desktop preview" });
    expect(desktop).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Mobile preview" }));
    expect(desktop).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Unsaved changes/ })).not.toBeInTheDocument();
    choose("NJ Decides brand");
    expect(await screen.findByRole("button", { name: "Mobile preview" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Desktop preview" }));
    choose("Homepage banner");
    expect(screen.getByRole("button", { name: "Desktop preview" })).toHaveAttribute("aria-pressed", "true");
    expect(api.save).not.toHaveBeenCalled();
    expect(api.publish).not.toHaveBeenCalled();
  });

  it("loads on first visit and preserves dirty fields, conflict and input identity across sections", async () => {
    const save = vi.fn(async () => { throw { status: 409 }; });
    const api = setup({ save });
    const message = await screen.findByRole("textbox", { name: "Message" });
    expect(api.loadBrand).not.toHaveBeenCalled();
    expect(api.loadChrome).not.toHaveBeenCalled();
    fireEvent.change(message, { target: { value: "Keep my election draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByRole("button", { name: "Reload saved banner" })).toBeVisible();
    choose("NJ Decides brand");
    await screen.findByRole("heading", { name: "NJ Decides brand" });
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    const hidden = api.container.querySelector('[data-settings-section="public-homepage-banner"]');
    expect(hidden).toHaveAttribute("hidden");
    expect(hidden).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: /Homepage banner.*Unsaved changes/ })).toBeInTheDocument();
    choose(/Homepage banner/);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(message);
    expect(message).toHaveValue("Keep my election draft");
    expect(screen.getByRole("button", { name: "Reload saved banner" })).toBeVisible();
    expect(api.loadBanner).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "public-homepage-banner", baseVersion: 4 }));
  });

  it("retains a pending save and its saved version while another section is active", async () => {
    let complete!: (value: MutateSettingsResponse<PublicHomepageBannerValues>) => void;
    const save = vi.fn(() => new Promise<MutateSettingsResponse<PublicHomepageBannerValues>>(resolve => { complete = resolve; }));
    setup({ save });
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), { target: { value: "Pending draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    choose("Header newsletter");
    await screen.findByRole("heading", { name: "Public header newsletter action" });
    await act(async () => { complete({ success: true, changed: true, id: "public-homepage-banner", settings: { schemaVersion: 2, version: 5, values: { ...standard, message: "Pending draft" } } }); });
    choose(/Homepage banner/);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Pending draft");
    expect(screen.getByText("Saved draft version 5")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Homepage banner" })).getByText("Not published")).toBeVisible();
  });

  it("keeps each public save independent and never publishes as part of saving", async () => {
    const api = setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), { target: { value: "Banner only" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Saved draft version 5");
    choose("Header newsletter");
    fireEvent.change(await screen.findByRole("textbox", { name: "Label" }), { target: { value: "News from NJ PBS" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
    expect(api.save.mock.calls.map(([request]) => request.id)).toEqual(["public-homepage-banner", "public-site-chrome"]);
    expect(api.save.mock.calls[1][0]).toEqual(expect.objectContaining({ baseVersion: 2, values: expect.objectContaining({ newsletterLabel: "News from NJ PBS" }) }));
    expect(api.publish).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Save draft" })).toHaveLength(1);
  });

  it("restores text selection and draft through section queries and Back", async () => {
    const api = setup();
    const input = await screen.findByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Local selection stays" } });
    input.focus(); input.setSelectionRange(2, 8); fireEvent.blur(input);
    choose("NJ Decides brand");
    await screen.findByRole("heading", { name: "NJ Decides brand" });
    await act(async () => { await api.router.navigate(-1); });
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
    expect(input).toHaveValue("Local selection stays");
    expect(api.router.state.location.pathname).toBe("/admin/settings");
  });

  it("supports a direct section query and safely falls back from unknown IDs", async () => {
    const api = setup({ initial: "/admin/settings?section=public-site-chrome&keep=yes" });
    await screen.findByRole("textbox", { name: "Label" });
    expect(api.loadBanner).not.toHaveBeenCalled();
    choose("NJ Decides brand");
    expect(api.router.state.location.search).toContain("keep=yes");
    await act(async () => { await api.router.navigate("/admin/settings?section=unknown"); });
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeVisible();
  });

  it("opens the existing Page brand heading link and restores it through Back", async () => {
    const api = setup({ initial: "/admin/settings#nj-decides-settings-heading" });
    const heading = await screen.findByRole("heading", { name: "NJ Decides brand" });
    expect(api.loadBanner).not.toHaveBeenCalled();
    choose("Header newsletter");
    await screen.findByRole("textbox", { name: "Label" });
    await act(async () => { await api.router.navigate(-1); });
    expect(screen.getByRole("heading", { name: "NJ Decides brand" })).toBe(heading);
    expect(api.loadBrand).toHaveBeenCalledTimes(1);
    expect(api.router.state.location.hash).toBe("#nj-decides-settings-heading");
    expect(api.router.state.location.search).toBe("");
  });

  it("prefers an explicit section query over a different heading fragment", async () => {
    const api = setup({ initial: "/admin/settings?section=public-site-chrome#nj-decides-settings-heading" });
    expect(await screen.findByRole("textbox", { name: "Label" })).toBeVisible();
    expect(api.loadBrand).not.toHaveBeenCalled();
    expect(api.loadBanner).not.toHaveBeenCalled();
  });

  it("guards actual route departure while allowing section changes with unsaved work", async () => {
    setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), { target: { value: "Do not discard" } });
    choose("NJ Decides brand");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Costs" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    choose(/Homepage banner/);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Do not discard");
  });

  it("explains mode fields and fills only the suggested local draft", async () => {
    const api = setup({ values: { ...standard, njDecides: true } });
    await screen.findByRole("textbox", { name: "Message" });
    expect(screen.getByText(/The band shows the NJ Decides logo/)).toBeVisible();
    expect(screen.getByText(/This is still the standard banner text/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use suggested election text" }));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Find voting information for New Jersey.");
    expect(screen.getByRole("textbox", { name: "Link label" })).toHaveValue("NJ Decides 2026");
    expect(screen.getByRole("textbox", { name: "Link URL" })).toHaveValue("/nj-decides-2026/");
    expect(screen.queryByText(/This is still the standard banner text/)).not.toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled();
    choose("NJ Decides brand");
    expect(await screen.findByText("Sample text")).toBeVisible();
  });
  it.each([true, false])("holds route departure for a pending save, then handles success=%s", async success => {
    let finish!: (value: MutateSettingsResponse<PublicHomepageBannerValues>) => void;
    let fail!: (reason: Error) => void;
    const save = vi.fn(() => new Promise<MutateSettingsResponse<PublicHomepageBannerValues>>((resolve, reject) => { finish = resolve; fail = reject; }));
    setup({ save });
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), { target: { value: "Finish before leaving" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    fireEvent.click(screen.getByRole("link", { name: "Costs" }));
    expect(await screen.findByText(/Finishing the settings action/)).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      if (success) finish({ success: true, changed: true, id: "public-homepage-banner", settings: { schemaVersion: 2, version: 5, values: { ...standard, message: "Finish before leaving" } } });
      else fail(new Error("Network unavailable"));
    });
    if (success) expect(await screen.findByText("Costs destination")).toBeVisible();
    else {
      expect(await screen.findByRole("dialog")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Finish before leaving");
    }
  });

  it("keeps dirty image upload work within the retained brand host and exit guard", async () => {
    const upload = vi.fn(async () => { throw new Error("An upload must be explicit."); });
    const api = setup({ initial: "/admin/settings?section=nj-decides-brand", brandProps: {
      loadMedia: async () => ({ success: true, records: [], total: 0, allCount: 0, page: 1, pageCount: 1, categoryCounts: {}, kindCounts: {} }),
      uploadMedia: upload, defaultUploadCategory: "general", canUploadCategory: () => true,
      mediaCategories: [{ id: "general", label: "General", description: "", order: 1, active: true, reserved: true, version: 1, etag: "fixture", canUpload: true, canManage: false, createdAt: null, createdBy: null, updatedAt: null, updatedBy: null }],
    } });
    fireEvent.click(await screen.findByRole("button", { name: "Choose custom logo" }));
    const picker = await screen.findByRole("dialog", { name: "Choose an image" });
    fireEvent.click(within(picker).getByRole("button", { name: "Upload image" }));
    fireEvent.change(picker.querySelector('input[type="file"]')!, { target: { files: [new File(["fixture"], "election.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByRole("button", { name: /NJ Decides brand.*Unsaved changes/ })).toBeInTheDocument());
    await act(async () => { await api.router.navigate("/admin/settings?section=public-homepage-banner"); });
    expect(picker.closest('[data-settings-section="nj-decides-brand"]')).toHaveAttribute("hidden");
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { await api.router.navigate("/admin/settings/costs"); });
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(upload).not.toHaveBeenCalled();
  });

  it("restores focus to a collapsed schedule summary when returning to the banner", async () => {
    setup();
    await screen.findByRole("textbox", { name: "Message" });
    const summary = screen.getByText(/^Schedule ·/);
    summary.focus(); fireEvent.blur(summary);
    choose("NJ Decides brand");
    await screen.findByRole("heading", { name: "NJ Decides brand" });
    choose("Homepage banner");
    expect(summary).toHaveFocus();
  });

});
