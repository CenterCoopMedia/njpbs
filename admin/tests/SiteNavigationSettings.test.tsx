import { settingsPublicationFixture } from "./settings-publication-fixture";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SITE_NAVIGATION_SETTINGS_ID,
  SiteNavigationSettings,
  describeNavigationError,
  type SiteNavigationSettingsTransport,
  type SiteNavigationValues,
} from "../src/components/SiteNavigationSettings";
import type {
  GetSettingsResponse,
  MutateSettingsResponse,
} from "../src/lib/functions";
import { DEFAULT_SITE_NAVIGATION } from "../../packages/content-core/src/cms-settings";

function documentResponse(
  values: SiteNavigationValues = DEFAULT_SITE_NAVIGATION,
  version = 4,
): GetSettingsResponse<SiteNavigationValues> {
  return {
    success: true,
    found: true,
    id: SITE_NAVIGATION_SETTINGS_ID,
    settings: { schemaVersion: 1, values, version },
  };
}

function mutationResponse(
  values: SiteNavigationValues,
  version: number,
  publishedSourceVersion?: number,
): MutateSettingsResponse<SiteNavigationValues> {
  return {
    success: true,
    changed: true,
    ...(publishedSourceVersion ? { publication: settingsPublicationFixture(publishedSourceVersion) } : {}),
    id: SITE_NAVIGATION_SETTINGS_ID,
    settings: {
      schemaVersion: 1,
      values,
      version,
      ...(publishedSourceVersion
        ? {
            published: {
              schemaVersion: 1,
              values,
              sourceVersion: publishedSourceVersion,
              publishedAt: "2026-09-25T14:00:00.000Z",
            },
          }
        : {}),
    },
  };
}

function transport(
  overrides: Partial<SiteNavigationSettingsTransport> = {},
): SiteNavigationSettingsTransport {
  return {
    load: vi.fn(async () => documentResponse()),
    save: vi.fn(async (request) =>
      mutationResponse(request.values as SiteNavigationValues, 5),
    ),
    publish: vi.fn(async () => mutationResponse(DEFAULT_SITE_NAVIGATION, 5, 4)),
    loadPages: vi.fn(async () => [
      { id: `page-${"a".repeat(32)}`, title: "Election guide", path: "/election-guide/", published: true },
      { id: `page-${"b".repeat(32)}`, title: "Draft only", path: "/draft-only/", published: false },
    ]),
    ...overrides,
  };
}

async function renderPanel(overrides: Partial<SiteNavigationSettingsTransport> = {}) {
  const props = transport(overrides);
  render(<SiteNavigationSettings {...props} />);
  await screen.findByRole("heading", { name: "Site navigation" });
  await waitFor(() => expect(props.loadPages).toHaveBeenCalled());
  return props;
}

function headerArea() {
  return screen.getByRole("group", { name: "Header links" });
}

function footerArea() {
  const summary = screen.getByText(/^Footer columns ·/);
  if (!summary.closest("details")?.open) fireEvent.click(summary);
  return screen.getByRole("group", { name: "Footer columns" });
}

function headerLabels() {
  return Array.from(headerArea().querySelectorAll(".site-nav-item-summary strong")).map(
    (label) => label.textContent,
  );
}

function linkInspector() {
  return within(screen.getByRole("complementary", { name: "Selected link and publication" }));
}

function openHeaderLink(name: string) {
  fireEvent.click(within(headerArea()).getByRole("button", { name: `Edit ${name}` }));
  return linkInspector().getByRole("textbox", { name: "Label" });
}

describe("Site navigation settings", () => {
  it("announces the skeleton wait and replaces it with the loaded editor", async () => {
    let finishLoad!: (response: GetSettingsResponse<SiteNavigationValues>) => void;
    const load = vi.fn(() => new Promise<GetSettingsResponse<SiteNavigationValues>>((resolve) => {
      finishLoad = resolve;
    }));
    const { container } = render(<SiteNavigationSettings {...transport({ load })} />);

    expect(screen.getByRole("status", { name: "Loading site navigation" })).toBeInTheDocument();
    const skeleton = container.querySelector("[data-skeleton]");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton?.querySelector(".skeleton-region-shapes")).toHaveAttribute("aria-hidden", "true");
    expect(skeleton?.querySelectorAll(".site-nav-area:first-child .site-nav-item")).toHaveLength(7);
    expect(skeleton?.querySelectorAll(".site-nav-column")).toHaveLength(4);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    finishLoad(documentResponse());
    await screen.findByRole("button", { name: "Add header link" });
    expect(screen.queryByRole("status", { name: "Loading site navigation" })).not.toBeInTheDocument();
    expect(container.querySelector("[data-skeleton]")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Site navigation" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("opens duplicate stored headings for correction while preserving the published copy", async () => {
    const values = {
      ...DEFAULT_SITE_NAVIGATION,
      footer: DEFAULT_SITE_NAVIGATION.footer.map((column, index) => ({
        ...column, heading: index === 1 ? "watch" : column.heading,
      })),
    };
    const published = {
      schemaVersion: 1, values, sourceVersion: 3, publishedAt: "2026-09-25T14:00:00.000Z",
    };
    const props = await renderPanel({
      load: async () => ({ ...documentResponse(values), settings: {
        schemaVersion: 1, values, version: 4, published,
      } }),
      save: async (request) => ({ ...mutationResponse(request.values, 5), settings: {
        schemaVersion: 1, values: request.values, version: 5, published,
      } }),
    });
    const headings = within(footerArea()).getAllByRole("textbox", { name: "Column heading" });
    expect(headings[1]).toHaveValue("watch");
    expect(headings[1]).toHaveAccessibleDescription(/Use a different heading/);
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    fireEvent.change(headings[1], { target: { value: "Passport" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled());
    expect(screen.queryByText("The site navigation setting is invalid.")).not.toBeInTheDocument();
    expect(props.publish).not.toHaveBeenCalled();
  });

  it("locks the Contact link and the column that holds it, and explains why", async () => {
    await renderPanel();

    const remove = within(footerArea()).getByRole("button", { name: "Remove Contact" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription(
      /Contact is required on every page for captioning and accessibility complaints/,
    );
    const removeColumn = within(footerArea()).getByRole("button", { name: "Remove column, About" });
    expect(removeColumn).toBeDisabled();
    expect(removeColumn).toHaveAccessibleDescription(
      "This column holds the Contact link. Move Contact to another column before you remove it.",
    );
    expect(within(footerArea()).getByRole("button", { name: "Remove column, Watch" })).toBeEnabled();
  });

  it("lists the required FCC and legal links as read-only", async () => {
    await renderPanel();

    const required = screen.getByRole("region", { name: "Required links" });
    expect(required).toHaveTextContent("FCC rules require the public inspection file links on every page");
    expect(required).toHaveTextContent("Public file, WNJS, WNJN, WNJT, WNJB");
    expect(required).toHaveTextContent(
      "Closed captioning, Accessibility, Privacy policy, Your privacy choices, EEO report",
    );
    expect(within(required).queryByRole("textbox")).toBeNull();
    expect(within(required).queryByRole("button")).toBeNull();
  });

  it("warns without blocking when a web address is an unknown internal path", async () => {
    await renderPanel();

    openHeaderLink("Schedule");
    const schedule = linkInspector().getByRole("combobox", { name: "Links to" });
    fireEvent.change(schedule, { target: { value: "href" } });
    const address = linkInspector().getByRole("textbox", { name: "Web address" });
    fireEvent.change(address, { target: { value: "/not-a-real-page/" } });

    expect(address).toHaveAccessibleDescription(
      "This address is not a known page on the public site. Check it before you publish.",
    );
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();

    fireEvent.change(address, { target: { value: "/election-guide/" } });
    expect(address).toHaveAccessibleDescription(/This address is the Election guide page/);
    fireEvent.change(address, { target: { value: "/posts/a-story/" } });
    expect(address).not.toHaveAccessibleDescription();
    // A relative address resolves differently on each page, so the field rejects it.
    for (const relative of ["schedule", "../contact", "?ref=1", "#hours"]) {
      fireEvent.change(address, { target: { value: relative } });
      expect(address, relative).toHaveAccessibleDescription(/Enter a safe address/);
    }
  });

  it("offers published custom pages and not unpublished ones", async () => {
    await renderPanel();

    openHeaderLink("Live");
    const live = linkInspector().getByRole("combobox", { name: "Page" });
    await within(live).findByRole("option", { name: "Election guide (/election-guide/)" });
    const options = within(live).getAllByRole("option").map((option) => option.textContent);
    expect(options).toContain("Election guide (/election-guide/)");
    expect(options.some((text) => text?.startsWith("Draft only"))).toBe(false);
  });

  it("moves a header link with focus on the moved item and announces the move", async () => {
    await renderPanel();
    expect(headerLabels().slice(0, 3)).toEqual(["Live", "Watch on demand", "Schedule"]);

    const down = within(headerArea()).getByRole("button", { name: "Move down, Live" });
    down.focus();
    fireEvent.click(down);

    expect(headerLabels().slice(0, 3)).toEqual(["Watch on demand", "Live", "Schedule"]);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(headerArea()).getByRole("button", { name: "Move down, Live" }),
      ),
    );
    expect(screen.getByText("Moved Live to position 2 of 7 in the header.")).toBeInTheDocument();

    const up = within(headerArea()).getByRole("button", { name: "Move up, Watch on demand" });
    expect(up).toBeDisabled();
    const firstUp = within(headerArea()).getByRole("button", { name: "Move up, Live" });
    firstUp.focus();
    fireEvent.click(firstUp);
    expect(headerLabels()[0]).toBe("Live");
    // Move up is now disabled at the top, so focus falls to Move down.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(headerArea()).getByRole("button", { name: "Move down, Live" }),
      ),
    );
  });

  it("moves Contact to another column and then allows the empty-of-Contact column to be removed", async () => {
    await renderPanel();

    const column = within(footerArea()).getByRole("combobox", { name: "Column for Contact" });
    fireEvent.change(column, { target: { value: "support" } });

    expect(screen.getByText("Moved Contact to the end of the Support column.")).toBeInTheDocument();
    expect(within(footerArea()).getByRole("button", { name: "Remove column, About" })).toBeEnabled();
    expect(within(footerArea()).getByRole("button", { name: "Remove column, Support" })).toBeDisabled();
  });

  it("blocks saving an invalid draft with a plain-language reason", async () => {
    await renderPanel();

    const first = openHeaderLink("Live");
    fireEvent.change(first, { target: { value: " " } });

    expect(screen.getByRole("alert")).toHaveTextContent("Header link 1 needs a label.");
    expect(within(headerArea()).getByRole("button", { name: "Close link" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByText("Fix the problem above to update the preview.")).toBeInTheDocument();
  });

  it("shows duplicate heading errors beside each affected column and blocks save", async () => {
    await renderPanel();
    const headings = within(footerArea()).getAllByRole("textbox", { name: "Column heading" });
    fireEvent.change(headings[0], { target: { value: "" } });
    fireEvent.change(headings[0], { target: { value: "Watch more" } });
    expect(headings[0]).toBeVisible();
    fireEvent.change(headings[1], { target: { value: "  WATCH   more  " } });
    for (const heading of headings.slice(0, 2)) {
      expect(heading).toHaveAttribute("aria-invalid", "true");
      expect(heading).toHaveAccessibleDescription(/Use a different heading for each footer column/);
    }
    const footer = headings[0].closest("details")!;
    fireEvent.click(footer.querySelector("summary")!);
    await waitFor(() => expect(footer).toHaveAttribute("open"));
    expect(headings[0]).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    fireEvent.change(headings[1], { target: { value: "Other links" } });
    expect(headings[0]).not.toHaveAttribute("aria-invalid");
    expect(headings[1]).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    fireEvent.click(footer.querySelector("summary")!);
    await waitFor(() => expect(footer).not.toHaveAttribute("open"));
  });

  it("preserves the new-tab flag when retyping a web address", async () => {
    const values: SiteNavigationValues = {
      ...DEFAULT_SITE_NAVIGATION,
      header: DEFAULT_SITE_NAVIGATION.header.map((link, index) => index === 1 ? {
        ...link,
        target: { type: "href", href: "https://example.org/" },
        external: true,
      } : link),
    };
    await renderPanel({ load: vi.fn(async () => documentResponse(values)) });
    openHeaderLink("Watch on demand");
    const checkbox = linkInspector().getByRole("checkbox");
    const address = linkInspector().getByRole("textbox", { name: "Web address" });
    expect(checkbox).toBeChecked();
    fireEvent.change(address, { target: { value: "" } });
    const replacement = "https://example.com/";
    for (let length = 1; length <= replacement.length; length += 1) {
      fireEvent.change(address, { target: { value: replacement.slice(0, length) } });
    }
    expect(address).toHaveValue(replacement);
    expect(checkbox).toBeEnabled();
    expect(checkbox).toBeChecked();
  });

  it.each(["page", "route:postsIndex", "route:inTheNews"])(
    "clears and disables the new-tab flag when switching to %s",
    async (choice) => {
      const props = await renderPanel();
      openHeaderLink("Watch on demand");
        const checkbox = linkInspector().getByRole("checkbox");
      expect(checkbox).toBeChecked();
      expect(checkbox).toBeEnabled();
      const target = linkInspector().getByRole("combobox", { name: "Links to" });
      fireEvent.change(target, { target: { value: choice } });
      expect(checkbox).not.toBeChecked();
      expect(checkbox).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
      await waitFor(() => expect(props.save).toHaveBeenCalledTimes(1));
      expect(vi.mocked(props.save).mock.calls[0][0].values.header[1].external).toBe(false);
      fireEvent.change(target, { target: { value: "href" } });
      const address = linkInspector().getByRole("textbox", { name: "Web address" });
      fireEvent.change(address, { target: { value: "https://example.org/" } });
      expect(checkbox).toBeEnabled();
      expect(checkbox).not.toBeChecked();
      fireEvent.click(checkbox);
      fireEvent.change(address, { target: { value: "mailto:test@example.org" } });
      expect(checkbox).toBeDisabled();
      expect(checkbox).not.toBeChecked();
    },
  );

  it("saves stale internal new-tab flags as false in both areas", async () => {
    const values: SiteNavigationValues = {
      header: DEFAULT_SITE_NAVIGATION.header.map((link, index) =>
        index === 0 ? { ...link, external: true } : link),
      footer: DEFAULT_SITE_NAVIGATION.footer.map((column, index) => index === 0 ? {
        ...column,
        links: column.links.map((link, linkIndex) =>
          linkIndex === 0 ? { ...link, external: true } : link),
      } : column),
    };
    const props = await renderPanel({ load: vi.fn(async () => documentResponse(values)) });
    const label = openHeaderLink("Live");
    expect(linkInspector().getByRole("checkbox")).toBeDisabled();
    expect(linkInspector().getByRole("checkbox")).not.toBeChecked();
    fireEvent.change(label, { target: { value: "Watch live" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(props.save).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(props.save).mock.calls[0][0].values;
    expect(saved.header[0].external).toBe(false);
    expect(saved.footer[0].links[0].external).toBe(false);
  });

  it("counts label bytes", async () => {
    await renderPanel();

    const first = openHeaderLink("Live");
    expect(first).toHaveAccessibleDescription("4 of 80 bytes used.");
    fireEvent.change(first, { target: { value: "Él" } });
    expect(first).toHaveAccessibleDescription("3 of 80 bytes used.");
  });

  it("saves a draft, then accepts its public settings operation", async () => {
    const props = await renderPanel();

    const first = openHeaderLink("Live");
    fireEvent.change(first, { target: { value: "Watch live" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(props.save).toHaveBeenCalledTimes(1));
    const request = vi.mocked(props.save).mock.calls[0][0];
    expect(request).toMatchObject({ id: SITE_NAVIGATION_SETTINGS_ID, baseVersion: 4 });
    expect(request.values.header[0]).toEqual({
      id: "live",
      label: "Watch live",
      target: { type: "page", pageId: "live" },
      external: false,
    });
    expect(await screen.findByText("Saved draft version 5")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(props.publish).toHaveBeenCalledWith({ id: SITE_NAVIGATION_SETTINGS_ID, baseVersion: 5 }),
    );
    expect(await screen.findByText(/Updating the site/)).toBeInTheDocument();
  });

  it("disables Publish during a retry of an older accepted version", async () => {
    const saved = { ...DEFAULT_SITE_NAVIGATION, header: DEFAULT_SITE_NAVIGATION.header.map((link, index) =>
      index === 0 ? { ...link, label: "Saved live link" } : link) };
    let finish!: (response: MutateSettingsResponse<SiteNavigationValues>) => void;
    const publish = vi.fn(() => new Promise<MutateSettingsResponse<SiteNavigationValues>>(resolve => { finish = resolve; }));
    const response = mutationResponse(saved, 5, 3);
    response.settings.published!.values = DEFAULT_SITE_NAVIGATION;
    response.publication = settingsPublicationFixture(3, { warning: "The site update is taking longer than expected. Retry publication." });
    const props = await renderPanel({ load: vi.fn(async () => ({ ...response, found: true as const })), publish });
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry site update" }));
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(publish).toHaveBeenCalledWith({ id: SITE_NAVIGATION_SETTINGS_ID, baseVersion: 3 });
    await act(async () => { finish({ ...response, publication: settingsPublicationFixture(3) }); });
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(screen.getByText("Saved draft version 5")).toBeVisible();
    expect(within(headerArea()).getByText("Saved live link")).toBeVisible();
    expect(props.save).not.toHaveBeenCalled();
  });

  it("creates the first document from the seed with createOnly", async () => {
    const props = await renderPanel({
      load: vi.fn(async () => ({
        success: true as const,
        found: false as const,
        id: SITE_NAVIGATION_SETTINGS_ID,
      })),
    });

    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    const first = openHeaderLink("Live");
    fireEvent.change(first, { target: { value: "Live TV" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(props.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(props.save).mock.calls[0][0]).toMatchObject({
      id: SITE_NAVIGATION_SETTINGS_ID,
      createOnly: true,
    });
  });

  it("previews the header and footer at desktop and phone widths", async () => {
    await renderPanel();

    const header = screen.getByRole("list", { name: "Header preview" });
    expect(within(header).getAllByRole("listitem")[0]).toHaveTextContent("Live");
    expect(screen.getByRole("list", { name: "About preview" })).toHaveTextContent("Contact");
    const phone = screen.getByRole("button", { name: "Phone" });
    fireEvent.click(phone);
    expect(phone).toHaveAttribute("aria-pressed", "true");
    expect(header.closest(".site-nav-preview")).toHaveAttribute("data-width", "phone");
  });

  it("explains that saving keeps a draft and publishing updates the public site", async () => {
    await renderPanel();

    expect(
      screen.getByText(
        "Save draft keeps your changes as a draft. The public site does not change. Publish updates the public site from the saved draft.",
      ),
    ).toBeInTheDocument();
  });

  it("maps validator paths to readable messages", () => {
    expect(describeNavigationError("header[2].label can be at most 80 bytes")).toBe(
      "Header link 3 label can be at most 80 bytes.",
    );
    expect(describeNavigationError("footer[1].links[0].target must contain a safe link")).toBe(
      "Footer column 2, link 1 needs a safe web address.",
    );
    expect(describeNavigationError("footer[0].links must contain at least one link")).toBe(
      "Footer column 1 needs at least one link. Add a link or remove the column.",
    );
    expect(describeNavigationError("footer must keep the contact link")).toBe(
      "The footer must keep the Contact link.",
    );
  });
});
