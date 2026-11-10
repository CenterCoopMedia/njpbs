import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CoverageLabelsSettings, DEFAULT_COVERAGE_LABELS, type CoverageLabelsSettingsTransport } from "../src/components/CoverageLabelsSettings";
import { COVERAGE_LABELS_SETTINGS_ID as id, validateCoverageLabels, type CoverageLabelsSettingsValues } from "../../packages/content-core/src/cms-settings";
import { HttpError, type GetSettingsResponse, type MutateSettingsResponse } from "../src/lib/functions";
import { settingsPublicationFixture } from "./settings-publication-fixture";
import { SettingsWorkspace } from "../src/components/SettingsWorkspace";

const values = () => structuredClone(DEFAULT_COVERAGE_LABELS);
function response(labels = values(), version = 4, published = false): GetSettingsResponse<CoverageLabelsSettingsValues> {
  return { success: true, found: true, id, settings: { schemaVersion: 1, version, values: labels,
    ...(published ? { published: { schemaVersion: 1, sourceVersion: version - 1, publishedAt: "2026-10-29T12:00:00.000Z", values: labels } } : {}) } };
}
function mutation(labels: CoverageLabelsSettingsValues, version: number, published = false): MutateSettingsResponse<CoverageLabelsSettingsValues> {
  const result = response(labels, version, published);
  if (!result.found) throw new Error("Expected document");
  return { success: true, changed: true, id, settings: result.settings,
    ...(published ? { publication: settingsPublicationFixture(version - 1, { status: "success", missingConsumers: [] }) } : {}) };
}
function transport(overrides: Partial<CoverageLabelsSettingsTransport> = {}): CoverageLabelsSettingsTransport {
  return { load: vi.fn(async () => response()), save: vi.fn(async request => mutation(request.values, 5)),
    publish: vi.fn(async () => mutation(values(), 5, true)), ...overrides };
}

describe("Coverage labels settings", () => {
  it("retains a draft across workspace sections and guards route departure until saved", async () => {
    const api = transport();
    const router = createMemoryRouter([
      { path: "/admin/settings", element: <SettingsWorkspace sections={[
        { id: "coverage-labels", label: "Coverage labels", group: "Public website", content: <CoverageLabelsSettings {...api} /> },
        { id: "other", label: "Another section", group: "Workspace", content: <p>Other settings</p> },
      ]} /> },
      { path: "/admin/settings/costs", element: <p>Costs destination</p> },
    ], { initialEntries: ["/admin/settings"] });
    render(<RouterProvider router={router} />);
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Keep this coverage draft" } });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Another section" }));
    expect(screen.getByText("Other settings")).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "Costs" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: /Coverage labels/ }));
    expect(screen.getByLabelText("Name")).toBe(input);
    expect(input).toHaveValue("Keep this coverage draft");
    expect(api.load).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Coverage labels draft saved.");
    fireEvent.click(screen.getByRole("link", { name: "Costs" }));
    expect(await screen.findByText("Costs destination")).toBeVisible();
    expect(api.publish).not.toHaveBeenCalled();
  });
  it("offers an unsaved election seed without writing, then saves and explicitly publishes", async () => {
    const api = transport({ load: vi.fn(async (): Promise<GetSettingsResponse<CoverageLabelsSettingsValues>> => ({ success: true, found: false, id })) });
    render(<CoverageLabelsSettings {...api} />);
    expect(await screen.findByLabelText("Name")).toHaveValue("NJ Decides 2026");
    expect(screen.queryByLabelText("Bar color")).not.toBeInTheDocument();
    expect(screen.getByText(/shared red, white and blue election bar/)).toBeVisible();
    expect(api.save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ id, createOnly: true, values: values() }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith({ id, baseVersion: 5 }));
    expect(await screen.findByText(/site update is complete/i)).toBeVisible();
  });
  it("adds a stable label, previews it and keeps save separate from publication", async () => {
    const api = transport(); render(<CoverageLabelsSettings {...api} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Add coverage label" }));
    const name = screen.getByLabelText("Name");
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "Statehouse Watch" } });
    fireEvent.change(screen.getByLabelText("Coverage page link (optional)"), { target: { value: "/statehouse/" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    const request = vi.mocked(api.save).mock.calls[0]![0];
    expect(request).toMatchObject({ id, baseVersion: 4, values: { labels: [values().labels[0], {
      id: expect.stringMatching(/^label-[a-f0-9-]+$/), name: "Statehouse Watch", href: "/statehouse/", retired: false,
    }] } });
    expect(api.publish).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Coverage label previews").querySelectorAll(".post-coverage")).toHaveLength(2);
  });
  it("refuses malformed bar colors and unsafe links before a save", async () => {
    const api = transport(); render(<CoverageLabelsSettings {...api} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Add coverage label" }));
    expect(screen.queryByLabelText("Text color")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Bar color"), { target: { value: "invalid" } });
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Bar color"), { target: { value: "#011375" } });
    fireEvent.change(screen.getByLabelText("Coverage page link (optional)"), { target: { value: "javascript:alert(1)" } });
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(api.save).not.toHaveBeenCalled();
  });
  it.each(["#ffffff", "#000000"])("saves bar color %s through the unchanged deployed contract", async backgroundColor => {
    const api = transport(); render(<CoverageLabelsSettings {...api} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Add coverage label" }));
    fireEvent.change(screen.getByLabelText("Bar color"), { target: { value: backgroundColor } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    const labels = vi.mocked(api.save).mock.calls[0]![0].values.labels;
    expect(labels[1]?.backgroundColor).toBe(backgroundColor);
    expect(validateCoverageLabels(labels)).toBeNull();
  });
  it("retires and restores without changing identity or removing history", async () => {
    const api = transport(); render(<CoverageLabelsSettings {...api} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Retire label" }));
    expect(screen.getByRole("button", { name: "NJ Decides 2026 (retired)" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    expect(vi.mocked(api.save).mock.calls[0]![0].values.labels[0]).toMatchObject({ id: "nj-decides-2026", retired: true });
    fireEvent.click(screen.getByRole("button", { name: "Restore label" }));
    expect(screen.getByRole("button", { name: "NJ Decides 2026" })).toBeVisible();
  });
  it("retains a conflicting draft until the editor explicitly reloads", async () => {
    const api = transport({ save: vi.fn(async () => { throw new HttpError(409, "Another editor saved first."); }) });
    render(<CoverageLabelsSettings {...api} />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Another editor saved first.");
    expect(screen.getByLabelText("Name")).toHaveValue("Keep my draft");
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload saved labels" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("NJ Decides 2026"));
  });
  it("bounds creation and makes an unavailable publication retryable without discarding a draft", async () => {
    const many = { labels: Array.from({ length: 100 }, (_, index) => ({ ...values().labels[0]!, id: `label-${index}` })) };
    const api = transport({ load: vi.fn(async () => response(many)), publish: vi.fn(async () => {
      throw new HttpError(409, "Publication is temporarily unavailable.", { code: "settings_publication_unavailable" });
    }) });
    render(<CoverageLabelsSettings {...api} />); await screen.findByLabelText("Name");
    expect(screen.getByRole("button", { name: "Add coverage label" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await screen.findByText("Publication is temporarily unavailable.");
    expect(screen.getByRole("alert")).toHaveTextContent("Publication is temporarily unavailable.");
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Reload saved labels" })).not.toBeInTheDocument();
  });
});
