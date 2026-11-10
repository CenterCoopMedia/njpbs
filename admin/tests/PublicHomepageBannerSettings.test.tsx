import { settingsPublicationFixture } from "./settings-publication-fixture";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  PublicHomepageBannerSettings,
  type PublicHomepageBannerSettingsTransport,
  type PublicHomepageBannerValues,
} from "../src/components/PublicHomepageBannerSettings";
import type {
  GetSettingsResponse,
  MutateSettingsResponse,
} from "../src/lib/functions";
import {
  DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
  DEFAULT_NJ_DECIDES_SETTINGS,
} from "../../packages/content-core/src/cms-settings";

function values(
  overrides: Partial<PublicHomepageBannerValues> = {},
): PublicHomepageBannerValues {
  return {
    enabled: true,
    message: "Weather may affect tonight's schedule.",
    linkLabel: "View schedule",
    linkHref: "/schedule/",
    ...overrides,
  };
}

function documentResponse(
  bannerValues: PublicHomepageBannerValues,
  version = 4,
  published?: {
    values: PublicHomepageBannerValues;
    sourceVersion: number;
    publishedAt: string;
  },
  schemaVersion = 2,
): GetSettingsResponse<PublicHomepageBannerValues> {
  return {
    success: true,
    found: true,
    id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
    settings: {
      schemaVersion,
      values: bannerValues,
      version,
      ...(published
        ? { published: { schemaVersion, ...published } }
        : {}),
    },
  };
}

function mutationResponse(
  bannerValues: PublicHomepageBannerValues,
  version: number,
  published?: {
    values: PublicHomepageBannerValues;
    sourceVersion: number;
    publishedAt: string;
  },
  schemaVersion = 2,
): MutateSettingsResponse<PublicHomepageBannerValues> {
  const loaded = documentResponse(bannerValues, version, published, schemaVersion);
  if (!loaded.found) throw new Error("Expected a settings document");
  return {
    success: true,
    changed: true,
    id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
    settings: loaded.settings,
    ...(published ? { publication: settingsPublicationFixture(published.sourceVersion) } : {}),
  };
}

function transport(
  overrides: Partial<PublicHomepageBannerSettingsTransport> = {},
): PublicHomepageBannerSettingsTransport {
  return {
    load: vi.fn(async () => documentResponse(values())),
    save: vi.fn(async (request) =>
      mutationResponse(request.values as PublicHomepageBannerValues, 5),
    ),
    publish: vi.fn(async () =>
      mutationResponse(values(), 5, {
        values: values(),
        sourceVersion: 4,
        publishedAt: "2026-08-31T14:00:00.000Z",
      }),
    ),
    ...overrides,
  };
}

describe("Public homepage banner settings", () => {
  it("requires a removal before choosing more than 50 excluded pages", async () => {
    const paths = Array.from({ length: 50 }, (_, index) => `/page-${index}/`);
    render(<PublicHomepageBannerSettings {...transport({ load: async () =>
      documentResponse(values({ njDecides: true, excludedPaths: paths }), 4, undefined, 3) })} />);
    expect(await screen.findByText("50 of 50 pages selected.")).toBeVisible();
    expect(screen.queryByText("Choose pages", { selector: "summary" })).not.toBeInTheDocument();
    const remove = screen.getByRole("button", { name: "Show the NJ Decides band on /page-0/" });
    remove.focus();
    fireEvent.click(remove);
    expect(screen.getByText("49 of 50 pages selected.")).toBeVisible();
    expect(screen.getByText("Choose pages", { selector: "summary" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Show the NJ Decides band on /page-1/" })).toHaveFocus();
    fireEvent.click(screen.getByText("Choose pages", { selector: "summary" }));
    const add = await screen.findByRole("button", { name: "Add Home" });
    add.focus();
    fireEvent.click(add);
    expect(screen.getByText("50 of 50 pages selected.")).toBeVisible();
    expect(screen.getByRole("group", { name: "Hide the NJ Decides band on these pages" })).toHaveFocus();
  });
  it("selects published destinations and saves exclusions with the banner", async () => {
    const save = vi.fn<PublicHomepageBannerSettingsTransport["save"]>(async request =>
      mutationResponse(request.values as PublicHomepageBannerValues, 5, undefined, 3));
    render(<PublicHomepageBannerSettings {...transport({
      load: async () => documentResponse(values({ njDecides: true }), 4, undefined, 3),
      save,
      contentSources: {
        loadPages: async () => [
          { id: "page-guide", title: "Election guide", path: "/draft-guide/", published: true, livePath: "/voting-guide/" },
          { id: "page-draft", title: "Unpublished guide", path: "/unpublished/", published: false },
        ],
        loadLibrarySelection: async () => ({ records: [
          { id: "story", kind: "post", title: "Election story", status: "published", liveSourceVersion: 2 },
          { id: "draft", kind: "post", title: "Draft story", status: "draft" },
        ], page: 1, pageCount: 1, total: 2, allCount: 2, mineCount: 0, assignedCount: 0,
          statusCounts: { scheduled: 0, draft: 1, in_review: 0, approved: 0, published: 1, archived: 0 } }),
        loadRecord: async () => ({ status: "ready", record: { type: "post", title: "Working story", slug: "draft-story", publiclyVisible: true,
          publicSourceVersion: 2, published: { sourceVersion: 2, metadata: { title: "Election story", slug: "election-story" } } } }),
      },
    })} />);
    const chooser = await screen.findByText("Choose pages", { selector: "summary" });
    fireEvent.click(chooser);
    fireEvent.click(await screen.findByRole("button", { name: "Add Home" }));
    expect(screen.queryByRole("button", { name: "Add Shows" })).not.toBeInTheDocument();
    expect(screen.getByText("The band is hidden on Home.", { exact: false })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add Home" }));
    expect(screen.getByText("1 of 50 pages selected.")).toBeVisible();
    expect(screen.getByText("That page is already selected.")).toBeVisible();
    expect(screen.queryByText(/^Selected /)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Add Election guide" }));
    expect(screen.queryByRole("button", { name: "Add Unpublished guide" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Content type"), { target: { value: "post" } });
    fireEvent.click(screen.getByRole("button", { name: "Search posts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Election story" }));
    expect(await screen.findByText("/posts/election-story/", { selector: "code" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add Draft story" })).not.toBeInTheDocument();
    const removeHome = screen.getByRole("button", { name: "Show the NJ Decides band on /" });
    removeHome.focus();
    fireEvent.click(removeHome);
    expect(screen.getByRole("button", { name: "Show the NJ Decides band on /voting-guide/" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      values: expect.objectContaining({ excludedPaths: ["/voting-guide/", "/posts/election-story/"] }),
    })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Show the NJ Decides band on /voting-guide/" }));
    const removePost = screen.getByRole("button", { name: "Show the NJ Decides band on /posts/election-story/" });
    removePost.focus();
    fireEvent.click(removePost);
    expect(screen.getByText("Choose pages", { selector: "summary" })).toHaveFocus();
  });
  it("seeds a missing document from the source-locked announcement and keeps it hidden", async () => {
    render(
      <PublicHomepageBannerSettings
        {...transport({
          load: vi.fn(async () => ({
            success: true as const,
            found: false as const,
            id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
          })),
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Public homepage banner" }),
    ).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Show banner on the homepage" }))
      .not.toBeChecked();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS.message,
    );
    expect(screen.getByRole("textbox", { name: "Link label" })).toHaveValue(
      DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS.linkLabel,
    );
    expect(screen.getByRole("textbox", { name: "Link URL" })).toHaveValue(
      DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS.linkHref,
    );
    expect(screen.getByText("Hidden from the homepage")).toBeVisible();
    expect(screen.getByText("Draft not saved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("loads a historical v1 document without changing standard homepage behavior", async () => {
    render(
      <PublicHomepageBannerSettings
        {...transport({
          load: vi.fn(async () => documentResponse(values(), 4, undefined, 1)),
        })}
      />,
    );

    expect(await screen.findByRole("checkbox", {
      name: "Show banner on the homepage",
    })).toBeChecked();
    expect(screen.getByRole("checkbox", {
      name: "Use NJ Decides sitewide mode",
    })).not.toBeChecked();
    expect(screen.getByRole("group", { name: /^Presentation/ })).toHaveClass(
      "record-field-group",
    );
    expect(screen.getByRole("group", { name: /^Content/ })).toHaveClass(
      "record-field-group",
    );
    expect(screen.getByRole("group", { name: /^NJ Decides details/ })).toHaveClass(
      "record-field-group",
    );
    expect(screen.getByRole("button", { name: "About Presentation" })).toBeVisible();
    expect(screen.getByLabelText("Proposed homepage banner preview")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeRequired();
  });

  it("saves a draft without publishing and then enables publication", async () => {
    const save = vi.fn(async (request) =>
      mutationResponse(request.values as PublicHomepageBannerValues, 1),
    );
    const publish = vi.fn();
    render(
      <PublicHomepageBannerSettings
        {...transport({
          load: vi.fn(async () => ({
            success: true as const,
            found: false as const,
            id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
          })),
          save,
          publish,
        })}
      />,
    );

    const enabled = await screen.findByRole("checkbox", {
      name: "Show banner on the homepage",
    });
    fireEvent.click(enabled);
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    expect(
      within(screen.getByLabelText("Proposed homepage banner preview")).getByText(
        DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS.message,
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
        createOnly: true,
        values: {
          enabled: true,
          message: DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS.message,
          linkLabel: DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS.linkLabel,
          linkHref: DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS.linkHref,
          njDecides: false,
        },
      }),
    );
    expect(await screen.findByText("Homepage banner draft saved.")).toBeVisible();
    expect(screen.getByText("Saved draft version 1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("previews the published appearance and live label with the shared production renderer", async () => {
    const loadAppearance = vi.fn(async () => ({ ...DEFAULT_NJ_DECIDES_SETTINGS,
      backgroundColor: "#011375", textColor: "#FFFFFF", linkColor: "#FFFFFF" }));
    render(<PublicHomepageBannerSettings {...transport({
      load: vi.fn(async () => documentResponse(values({ njDecides: true, liveLabel: "Results live" }))),
      loadAppearance,
    })} />);
    const preview = await screen.findByLabelText("Proposed NJ Decides sitewide banner preview");
    await waitFor(() => expect(within(preview).getByRole("img", { name: "NJ Decides 2026" }))
      .toHaveAttribute("src", "/brand/nj-decides/logo-reversed.svg"));
    expect(within(preview).getByText("Results live")).toBeVisible();
    expect(loadAppearance).toHaveBeenCalledTimes(1);
  });

  it("saves an empty election band with optional scheduling as canonical UTC", async () => {
    const electionValues: PublicHomepageBannerValues = {
      enabled: true,
      message: "",
      njDecides: true,
      liveLabel: "Live",
      startsAt: "2026-11-03T23:00:00.000Z",
      endsAt: "2026-11-04T06:00:00.000Z",
    };
    const save = vi.fn(async (request) =>
      mutationResponse(request.values as PublicHomepageBannerValues, 5));
    render(<PublicHomepageBannerSettings {...transport({
      load: vi.fn(async () => documentResponse(electionValues)),
      save,
    })} />);

    expect(await screen.findByRole("checkbox", {
      name: "Use NJ Decides sitewide mode",
    })).toBeChecked();
    expect(screen.getByRole("checkbox", {
      name: "Show NJ Decides band sitewide",
    })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Message" })).not.toBeRequired();
    const preview = screen.getByLabelText("Proposed NJ Decides sitewide banner preview");
    expect(within(preview).getByRole("img", { name: "NJ Decides 2026" })).toBeVisible();
    expect(within(preview).queryByText("Banner message")).not.toBeInTheDocument();
    expect(within(preview).getByText("Live")).toBeVisible();
    expect(preview.querySelector(".nj-decides-band__copy p")).toBeNull();
    expect(screen.getByLabelText("Start date and time")).toHaveValue("2026-11-03T18:00");
    expect(screen.getByLabelText("End date and time")).toHaveValue("2026-11-04T01:00");

    fireEvent.change(screen.getByLabelText("Live label"), {
      target: { value: "Results live" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      baseVersion: 4,
      values: {
        enabled: true,
        message: "",
        njDecides: true,
        liveLabel: "Results live",
        startsAt: "2026-11-03T23:00:00.000Z",
        endsAt: "2026-11-04T06:00:00.000Z",
      },
    }));
  });

  it("preserves untouched schedule instants through repeated Eastern time and hidden seconds", async () => {
    const electionValues: PublicHomepageBannerValues = {
      enabled: true,
      message: "",
      njDecides: true,
      startsAt: "2026-11-01T06:30:00.000Z",
      endsAt: "2026-11-01T08:45:30.000Z",
    };
    const save = vi.fn(async (request) =>
      mutationResponse(request.values as PublicHomepageBannerValues, 5));
    render(<PublicHomepageBannerSettings {...transport({
      load: vi.fn(async () => documentResponse(electionValues)),
      save,
    })} />);

    expect(await screen.findByLabelText("Start date and time")).toHaveValue(
      "2026-11-01T01:30",
    );
    expect(screen.getByLabelText("End date and time")).toHaveValue(
      "2026-11-01T03:45",
    );
    expect(screen.getByText("No unsaved changes")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Live label"), {
      target: { value: "Live" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      baseVersion: 4,
      values: {
        enabled: true,
        message: "",
        njDecides: true,
        liveLabel: "Live",
        startsAt: "2026-11-01T06:30:00.000Z",
        endsAt: "2026-11-01T08:45:30.000Z",
      },
    }));
  });

  it("validates UTF-8 limits, paired links, and unsafe URLs", async () => {
    render(<PublicHomepageBannerSettings {...transport()} />);

    const message = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(message, { target: { value: "é".repeat(121) } });
    expect(message).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a message of no more than 240 bytes.")).toBeVisible();

    fireEvent.change(message, { target: { value: "Service update" } });
    const label = screen.getByRole("textbox", { name: "Link label" });
    const href = screen.getByRole("textbox", { name: "Link URL" });
    fireEvent.change(label, { target: { value: "" } });
    expect(label).toHaveAttribute("aria-invalid", "true");
    expect(href).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter both link fields or leave both blank.")).toBeVisible();

    fireEvent.change(label, { target: { value: "Learn more" } });
    fireEvent.change(href, { target: { value: "javascript:alert(1)" } });
    expect(href).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a safe link URL.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  });

  it("validates election links, UTF-8 live labels, and schedule order", async () => {
    render(<PublicHomepageBannerSettings {...transport({
      load: vi.fn(async () => documentResponse({
        enabled: true,
        message: "",
        njDecides: true,
      })),
    })} />);

    const href = await screen.findByRole("textbox", { name: "Link URL" });
    fireEvent.change(screen.getByRole("textbox", { name: "Link label" }), {
      target: { value: "Results" },
    });
    fireEvent.change(href, { target: { value: "results" } });
    expect(screen.getByText("Enter an absolute URL or a path that starts with /.")).toBeVisible();

    fireEvent.change(href, { target: { value: "/results/" } });
    const previewLink = within(screen.getByLabelText(
      "Proposed NJ Decides sitewide banner preview",
    )).getByRole("link", { name: "Results" });
    expect(fireEvent.click(previewLink)).toBe(false);
    const liveLabel = screen.getByLabelText("Live label");
    fireEvent.change(liveLabel, { target: { value: "é".repeat(13) } });
    expect(screen.getByText("Enter a live label of no more than 24 bytes.")).toBeVisible();

    fireEvent.change(liveLabel, { target: { value: "Live" } });
    fireEvent.change(screen.getByLabelText("Start date and time"), {
      target: { value: "2026-11-04T01:00" },
    });
    fireEvent.change(screen.getByLabelText("End date and time"), {
      target: { value: "2026-11-03T18:00" },
    });
    expect(screen.getByText(
      "The start date and time must be before the end date and time.",
    )).toBeVisible();
    expect(screen.getByLabelText("Start date and time")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("End date and time")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  });

  it("shows the canonical Eastern time when daylight saving skips a local hour", async () => {
    render(<PublicHomepageBannerSettings {...transport({
      load: vi.fn(async () => documentResponse({
        enabled: true,
        message: "",
        njDecides: true,
      })),
    })} />);

    const start = await screen.findByLabelText("Start date and time");
    fireEvent.change(start, { target: { value: "2026-03-08T02:30" } });
    expect(start).toHaveValue("2026-03-08T03:30");
  });

  it("publishes the exact saved version in one settings operation", async () => {
    const publish = vi.fn(async () =>
      mutationResponse(values(), 5, {
        values: values(),
        sourceVersion: 4,
        publishedAt: "2026-08-31T14:00:00.000Z",
      }),
    );
    render(<PublicHomepageBannerSettings {...transport({ publish })} />);

    expect(await screen.findByRole("button", { name: "Publish" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith({
        id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
        baseVersion: 4,
      }),
    );
    const pendingStatus = await screen.findByText(/Updating the site/);
    expect(pendingStatus).toBeVisible();
    expect(pendingStatus.closest('[role="status"]')).not.toHaveTextContent(/live/i);
    expect(screen.getByText("Saved draft version 5")).toBeVisible();
    expect(screen.getByText(/Published version 4/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("retries the accepted source after reload without adopting a later private draft", async () => {
    const privateValues = values({ message: "A later private draft" });
    const loaded = documentResponse(privateValues, 6, {
      values: values(), sourceVersion: 4, publishedAt: "2026-08-31T14:00:00.000Z",
    });
    const publish = vi.fn(async () => mutationResponse(privateValues, 6, {
      values: values(), sourceVersion: 4, publishedAt: "2026-08-31T14:00:00.000Z",
    }));
    render(<PublicHomepageBannerSettings {...transport({
      load: vi.fn(async () => ({ ...loaded, publication: settingsPublicationFixture(4, {
        status: "failed", warning: "The site update is taking longer than expected. Retry publication.",
      }) })), publish,
    })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry site update" }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith({ id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, baseVersion: 4 }));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("A later private draft");
    expect(await screen.findByText(/Updating the site/)).toBeVisible();
  });

  it("opens relative preview links on the public site without leaving the form", async () => {
    render(<PublicHomepageBannerSettings {...transport()} />);

    const preview = await screen.findByLabelText("Proposed homepage banner preview");
    expect(within(preview).getByRole("link", { name: /View schedule/ })).toHaveAttribute(
      "href",
      "https://njpbs.org/schedule/",
    );
    expect(within(preview).getByRole("link", { name: /View schedule/ })).toHaveAttribute(
      "target",
      "_blank",
    );
  });

  it("repeats the original saved version after a lost acceptance response", async () => {
    const publish = vi.fn().mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValueOnce(mutationResponse(values(), 5, {
        values: values(), sourceVersion: 4, publishedAt: "2026-08-31T14:00:00.000Z",
      }));
    render(<PublicHomepageBannerSettings {...transport({ publish })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    expect(await screen.findByText("The homepage banner could not be published. Try again.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(publish).toHaveBeenNthCalledWith(1, { id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, baseVersion: 4 });
    expect(publish).toHaveBeenNthCalledWith(2, { id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, baseVersion: 4 });
    expect(await screen.findByText(/Updating the site/)).toBeVisible();
  });

  it("preserves local values after save and publish conflicts", async () => {
    const save = vi.fn().mockRejectedValue({ status: 409 });
    const first = transport({ save });
    const { unmount } = render(<PublicHomepageBannerSettings {...first} />);

    const message = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.click(screen.getByRole("checkbox", {
      name: "Use NJ Decides sitewide mode",
    }));
    fireEvent.change(screen.getByLabelText("Live label"), {
      target: { value: "Results live" },
    });
    fireEvent.change(screen.getByLabelText("Start date and time"), {
      target: { value: "2026-11-03T18:00" },
    });
    fireEvent.change(message, { target: { value: "A local unsaved message" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("This setting changed after you opened it.")).toBeVisible();
    expect(message).toHaveValue("A local unsaved message");
    expect(screen.getByLabelText("Live label")).toHaveValue("Results live");
    expect(screen.getByLabelText("Start date and time")).toHaveValue("2026-11-03T18:00");
    expect(screen.getByRole("button", { name: "Reload saved banner" })).toBeVisible();

    unmount();
    const publish = vi.fn().mockRejectedValue({ status: 409 });
    render(<PublicHomepageBannerSettings {...transport({ publish })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    expect(await screen.findByText("This setting changed after you opened it.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      values().message,
    );
    expect(screen.getByRole("button", { name: "Reload saved banner" })).toBeVisible();
  });
  it("warns for an unchanged standard link and keeps that reference after saving election copy", async () => {
    const standard = values();
    const saved = values({ njDecides: true, message: "Election information" });
    render(<PublicHomepageBannerSettings {...transport({
      load: async () => documentResponse(saved, 4, { values: standard, sourceVersion: 3, publishedAt: "2026-10-28T12:00:00.000Z" }),
    })} />);
    expect(await screen.findByText(/This is still the standard banner text/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use suggested election text" }));
    expect(screen.queryByText(/This is still the standard banner text/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Saved draft version 5");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: standard.message } });
    expect(screen.getByText(/This is still the standard banner text/)).toBeVisible();
  });

  it("does not invent standard text history when only an election publication is available", async () => {
    const election = values({ njDecides: true });
    render(<PublicHomepageBannerSettings {...transport({
      load: async () => documentResponse(election, 5, { values: election, sourceVersion: 4, publishedAt: "2026-10-28T12:00:00.000Z" }),
    })} />);
    await screen.findByRole("textbox", { name: "Message" });
    expect(screen.queryByText(/This is still the standard banner text/)).toBeNull();
  });

  it("summarizes configured schedule values and exposes schedule errors automatically", async () => {
    render(<PublicHomepageBannerSettings {...transport({ load: async () => documentResponse(values({ njDecides: true, startsAt: "2026-11-03T23:00:00.000Z" })) })} />);
    await screen.findByRole("textbox", { name: "Message" });
    const schedule = screen.getByText(/Schedule · Starts/).closest("details")!;
    expect(schedule).not.toHaveAttribute("open");
    expect(schedule.querySelector("summary")).toHaveTextContent("Nov 3, 2026");
    expect(schedule.querySelector("summary")).toHaveTextContent("6:00 PM EST");
    fireEvent.change(screen.getByLabelText("End date and time"), { target: { value: "2026-11-02T18:00" } });
    expect(schedule).toHaveAttribute("open");
    expect(screen.getByText("The start date and time must be before the end date and time.")).toBeVisible();
    fireEvent.click(schedule.querySelector("summary")!);
    await waitFor(() => expect(schedule).toHaveAttribute("open"));
    expect(screen.getByText("The start date and time must be before the end date and time.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("End date and time"), { target: { value: "2026-11-04T18:00" } });
    fireEvent.click(schedule.querySelector("summary")!);
    await waitFor(() => expect(schedule).not.toHaveAttribute("open"));
  });

  it("identifies the schedule as NJ Decides-only while standard banner mode is active", async () => {
    render(<PublicHomepageBannerSettings {...transport({ load: async () => documentResponse(values({ njDecides: false })) })} />);
    await screen.findByRole("textbox", { name: "Message" });
    expect(screen.getByText(/Schedule · No schedule set · NJ Decides band only/)).toBeVisible();
  });

});

describe("two-link banner editing", () => {
  const twoLinks = () => values({ njDecides: true, secondLinkLabel: "Watch live", secondLinkHref: "/live/" });
  const newTransport = (initial = twoLinks()) => transport({
    load: async () => documentResponse(initial, 4, undefined, 4),
    save: vi.fn(async request => mutationResponse(request.values as PublicHomepageBannerValues, 5, undefined, 4)),
  });
  it("loads both links, previews them and preserves the second on a message edit", async () => {
    const props = newTransport();
    render(<PublicHomepageBannerSettings {...props} />);
    expect(await screen.findByLabelText("Second link label")).toHaveValue("Watch live");
    expect(screen.getByLabelText("Second link URL")).toHaveValue("/live/");
    const preview = screen.getByLabelText("Proposed NJ Decides sitewide banner preview");
    expect(within(preview).getAllByRole("link").map(link => [link.textContent, link.getAttribute("href")])).toEqual([["View schedule", "/schedule/"], ["Watch live", "/live/"]]);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Election night coverage" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(props.save).toHaveBeenCalledWith(expect.objectContaining({ values: expect.objectContaining({ secondLinkLabel: "Watch live", secondLinkHref: "/live/", message: "Election night coverage" }) })));
  });
  it("adds a second pair to a legacy one-link record and trims both values", async () => {
    const props = transport({ load: async () => documentResponse(values({ njDecides: true })),
      save: vi.fn(async request => mutationResponse(request.values as PublicHomepageBannerValues, 5, undefined, 4)) });
    render(<PublicHomepageBannerSettings {...props} />);
    fireEvent.change(await screen.findByLabelText("Second link label"), { target: { value: " Watch live " } });
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByText("Enter both second link fields or leave both blank.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Second link URL"), { target: { value: " /live/ " } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(props.save).toHaveBeenCalledWith(expect.objectContaining({ values: expect.objectContaining({ secondLinkLabel: "Watch live", secondLinkHref: "/live/" }) })));
  });
  it("blocks a second link without the first and uses explicit empty fields for removal", async () => {
    const props = newTransport();
    render(<PublicHomepageBannerSettings {...props} />);
    fireEvent.change(await screen.findByLabelText("Link label"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Link URL"), { target: { value: "" } });
    expect(screen.getByText("Add the first link before adding a second link.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Link label"), { target: { value: "Results" } });
    fireEvent.change(screen.getByLabelText("Link URL"), { target: { value: "/results/" } });
    fireEvent.change(screen.getByLabelText("Second link label"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Second link URL"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(props.save).toHaveBeenCalledWith(expect.objectContaining({ values: expect.objectContaining({ secondLinkLabel: "", secondLinkHref: "", linkLabel: "Results" }) })));
  });
  it.each([
    ["Second link URL", "javascript:alert(1)", "Enter a safe second link URL."],
    ["Second link URL", "relative/path", "Enter an absolute URL or a path that starts with /."],
    ["Second link label", "é".repeat(41), "Enter a second link label of no more than 80 bytes."],
    ["Second link URL", "/" + "x".repeat(2048), "Enter a second link URL of no more than 2048 bytes."],
  ])("blocks invalid %s values", async (field, value, message) => {
    render(<PublicHomepageBannerSettings {...newTransport()} />);
    fireEvent.change(await screen.findByLabelText(field), { target: { value } });
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });
});

describe("two-link standard banner safeguards", () => {
  it("keeps the warning for a standard second link after applying suggested election copy", async () => {
    const standard = values({ njDecides: false, secondLinkLabel: "Old announcement", secondLinkHref: "/about/" });
    render(<PublicHomepageBannerSettings {...transport({ load: async () => documentResponse(standard, 5,
      { values: standard, sourceVersion: 4, publishedAt: "2026-11-03T19:00:00.000Z" }, 4) })} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Use NJ Decides sitewide mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Use suggested election text" }));
    expect(screen.getByText(/Review Message and both links/)).toBeVisible();
    expect(screen.getByLabelText("Second link label")).toHaveValue("Old announcement");
    fireEvent.change(screen.getByLabelText("Second link label"), { target: { value: "Watch live" } });
    fireEvent.change(screen.getByLabelText("Second link URL"), { target: { value: "/live/" } });
    expect(screen.queryByText(/Review Message and both links/)).not.toBeInTheDocument();
  });
  it("announces the new tab for each standard preview action", async () => {
    render(<PublicHomepageBannerSettings {...transport({ load: async () => documentResponse(values({
      secondLinkLabel: "Watch live", secondLinkHref: "https://live.njpbs.org/",
    }), 4, undefined, 4) })} />);
    const preview = await screen.findByLabelText("Proposed homepage banner preview");
    expect(within(preview).getByRole("link", { name: /View schedule.*opens in new tab/ })).toHaveAttribute("target", "_blank");
    expect(within(preview).getByRole("link", { name: /Watch live.*opens in new tab/ })).toHaveAttribute("target", "_blank");
  });
});
