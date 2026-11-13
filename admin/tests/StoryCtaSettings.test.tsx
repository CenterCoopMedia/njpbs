import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SUPPORT_APPEAL_DEFAULTS } from "../../packages/content-core/src/content-model";
import { STORY_CTAS_SETTINGS_ID as id } from "../../packages/content-core/src/cms-settings";
import type { StoryCtasSettingsValues } from "../../packages/content-core/src/story-cta-rules";
import {
  StoryCtaSettings,
  type StoryCtaSettingsTransport,
} from "../src/components/StoryCtaSettings";
import {
  HttpError,
  type GetSettingsResponse,
  type MutateSettingsResponse,
} from "../src/lib/functions";
import { settingsPublicationFixture } from "./settings-publication-fixture";

vi.mock("../src/components/HomePreviewFrame", () => ({
  HomePreviewFrame: ({ html, title }: { html: string; title: string }) =>
    <section aria-label={title} data-testid="story-preview" dangerouslySetInnerHTML={{ __html: html }} />,
}));

const appealRule = () => ({
  id: "reader-support",
  label: "End-of-story support appeal",
  enabled: true,
  target: { contentTypes: ["post" as const] },
  position: { kind: "end" as const },
  content: { type: "support_appeal" as const, data: structuredClone(SUPPORT_APPEAL_DEFAULTS) },
});
const values = (): StoryCtasSettingsValues => ({ rules: [appealRule()] });

function response(
  rules = values(),
  version = 4,
  schemaVersion = 2,
  published = false,
): GetSettingsResponse<StoryCtasSettingsValues> {
  return {
    success: true,
    found: true,
    id,
    settings: {
      schemaVersion,
      version,
      values: rules,
      ...(published ? { published: {
        schemaVersion: 2,
        sourceVersion: version - 1,
        publishedAt: "2026-11-13T15:00:00.000Z",
        values: rules,
      } } : {}),
    },
  };
}

function mutation(
  rules: StoryCtasSettingsValues,
  version: number,
  published = false,
): MutateSettingsResponse<StoryCtasSettingsValues> {
  const result = response(rules, version, 2, published);
  if (!result.found) throw new Error("Expected settings document");
  return {
    success: true,
    changed: true,
    id,
    settings: result.settings,
    ...(published ? { publication: settingsPublicationFixture(version - 1, { status: "success", missingConsumers: [] }) } : {}),
  };
}

function transport(overrides: Partial<StoryCtaSettingsTransport> = {}): StoryCtaSettingsTransport {
  let stored = values();
  return {
    load: vi.fn(async () => response(stored)),
    save: vi.fn(async request => {
      stored = request.values;
      return mutation(stored, 5);
    }),
    publish: vi.fn(async () => mutation(stored, 6, true)),
    ...overrides,
  };
}

const newsletter = {
  id: "garden-state-weekly",
  type: "newsletter",
  title: "Garden State Weekly",
  status: "approved",
  signupUrl: "https://example.org/newsletters/garden-state-weekly",
  frequency: "Every Friday",
  summary: "Reporting from across New Jersey.",
  body: { type: "doc", content: [] },
};
const newsletterSources = {
  loadLibrarySelection: vi.fn(async () => ({
    records: [{ id: newsletter.id, kind: "newsletter" as const, status: newsletter.status, title: newsletter.title }],
    total: 1,
    allCount: 1,
    mineCount: 0,
    assignedCount: 0,
    page: 1,
    pageCount: 1,
    statusCounts: { draft: 0, in_review: 0, approved: 1, scheduled: 0, published: 0, archived: 0 },
  })),
  loadRecord: vi.fn(async (kind: string, recordId: string) => kind === "newsletter" && recordId === newsletter.id
    ? { status: "ready" as const, record: newsletter }
    : { status: "missing" as const }),
};

describe("Story CTA settings", () => {
  it("keeps focus on a remaining rule or Add after keyboard removal", async () => {
    render(<StoryCtaSettings {...transport({ load: vi.fn(async () => response({ rules: [appealRule(), { ...appealRule(), id: "second", label: "Second appeal" }] })) })} />);
    await screen.findByRole("checkbox", { name: "Enabled on stories" });
    fireEvent.click(screen.getByRole("button", { name: "Second appeal Enabled" }));
    const moveUp = screen.getByRole("button", { name: "Move up, Second appeal" });
    moveUp.focus();
    fireEvent.click(moveUp);
    expect(screen.getByRole("button", { name: "Second appeal Enabled" })).toHaveFocus();
    expect(screen.getByText("Second appeal moved to position 1 of 2.")).toBeInTheDocument();
    const removeFirst = screen.getByRole("button", { name: "Remove End-of-story support appeal" });
    removeFirst.focus();
    fireEvent.click(removeFirst);
    expect(screen.getByRole("button", { name: "Second appeal Enabled" })).toHaveFocus();
    const removeLast = screen.getByRole("button", { name: "Remove Second appeal" });
    removeLast.focus();
    fireEvent.click(removeLast);
    expect(screen.getByRole("button", { name: "Add story CTA rule" })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Sample New Jersey story" })).not.toBeInTheDocument();
  });
  it("loads a valid version 1 end rule, toggles its preview, saves through version 2, and publishes", async () => {
    const versionOne = values();
    const api = transport({ load: vi.fn(async () => response(versionOne, 4, 1)) });
    render(<StoryCtaSettings {...api} />);

    const enabled = await screen.findByRole("checkbox", { name: "Enabled on stories" });
    expect(enabled).toBeChecked();
    expect(screen.getByText("Stories (posts)")).toBeVisible();
    expect(screen.queryByLabelText("Decorative image")).not.toBeInTheDocument();
    expect(screen.getByTestId("story-preview").querySelector(".support-appeal")).not.toBeNull();

    fireEvent.click(enabled);
    expect(screen.getByTestId("story-preview").querySelector(".support-appeal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(api.save).toHaveBeenCalledWith({
      id,
      baseVersion: 4,
      values: { rules: [{ ...appealRule(), enabled: false }] },
    }));
    expect(await screen.findByText("Story CTA draft saved.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith({ id, baseVersion: 5 }));
  });

  it("adds, selects, resolves, previews, and reorders an actual newsletter record", async () => {
    const api = transport({ contentSources: newsletterSources });
    render(<StoryCtaSettings {...api} />);
    await screen.findByRole("checkbox", { name: "Enabled on stories" });

    fireEvent.click(screen.getByRole("button", { name: "Add story CTA rule" }));
    const name = screen.getByRole("textbox", { name: "Rule name" });
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "Mid-story newsletter" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Position" }), { target: { value: "after-paragraph" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Paragraph number" }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("combobox", { name: "CTA type" }), { target: { value: "newsletter_signup" } });
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Search newsletters" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Garden State Weekly" }));
    await screen.findByText(/Approved projection shown/);
    const preview = screen.getByTestId("story-preview");
    expect(within(preview).getByRole("heading", { name: "Garden State Weekly" })).toBeVisible();
    expect(within(preview).getByRole("link", { name: "Sign up for Garden State Weekly" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Move up, Mid-story newsletter" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    const saved = vi.mocked(api.save).mock.calls[0]![0].values;
    expect(saved.rules.map(rule => rule.label)).toEqual(["Mid-story newsletter", "End-of-story support appeal"]);
    expect(saved.rules[0]?.position).toEqual({ kind: "after-paragraph", count: 3 });
    expect(saved.rules[0]?.content).toMatchObject({ type: "newsletter_signup", data: { newsletterIds: [newsletter.id] } });
  });

  it("keeps an edited rule after a save conflict and shows newsletter load errors", async () => {
    const api = transport({
      save: vi.fn(async () => { throw new HttpError(409, "Another editor saved these rules first."); }),
      contentSources: {
        ...newsletterSources,
        loadRecord: vi.fn(async () => { throw new Error("fixture failure"); }),
      },
      load: vi.fn(async () => response({ rules: [{
        id: "weekly-newsletter",
        label: "Weekly newsletter",
        enabled: true,
        target: { contentTypes: ["post"] },
        position: { kind: "end" },
        content: { type: "newsletter_signup", data: { newsletterIds: [newsletter.id] } },
      }] })),
    });
    render(<StoryCtaSettings {...api} />);

    const name = await screen.findByRole("textbox", { name: "Rule name" });
    fireEvent.change(name, { target: { value: "Keep this newsletter draft" } });
    expect(await screen.findByText("This newsletter could not be loaded for the preview.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Another editor saved these rules first.")).toBeVisible();
    expect(name).toHaveValue("Keep this newsletter draft");
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload saved story CTA rules" })).toBeVisible();
  });
});
