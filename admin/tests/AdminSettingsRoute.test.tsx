import { settingsPublicationFixture } from "./settings-publication-fixture";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSettingsRoute } from "../src/routes/AdminSettingsRoute";
import { PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID } from "../src/components/PublicHomepageBannerSettings";
import { SITE_NAVIGATION_SETTINGS_ID } from "../src/components/SiteNavigationSettings";
import { PUBLIC_SITE_CHROME_SETTINGS_ID } from "../src/components/PublicSiteChromeSettings";
import { NJ_DECIDES_SETTINGS_ID } from "../src/components/NjDecidesSettings";
import { DEFAULT_SITE_NAVIGATION } from "../../packages/content-core/src/cms-settings";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  cmsGetSettings: vi.fn(),
  cmsSaveSettings: vi.fn(),
  cmsPublishSettings: vi.fn(),
  cmsPublish: vi.fn(),
  cmsListPages: vi.fn(),
  fetchAdminStatus: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ getIdToken: mocks.getIdToken }),
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsGetSettings: mocks.cmsGetSettings,
  cmsSaveSettings: mocks.cmsSaveSettings,
  cmsPublishSettings: mocks.cmsPublishSettings,
  cmsPublish: mocks.cmsPublish,
  cmsListPages: mocks.cmsListPages,
}));

vi.mock("../src/lib/admin-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/admin-status")>()),
  fetchAdminStatus: mocks.fetchAdminStatus,
}));

function shell(role: "admin" | "editor"): ShellData {
  return {
    principal: { id: "user-1", grants: [{ role }] },
    user: {
      uid: "user-1",
      email: "account-29@example.org",
      displayName: "Test user",
    },
    userDoc: { role },
    signOut: vi.fn(),
  } as unknown as ShellData;
}

function renderRoute(
  role: "admin" | "editor" = "admin",
  sharedNotices = false,
  section = "newsroom-defaults",
  entry = `/admin-settings?section=${section}`,
) {
  const route = (
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/" element={<p>Newsroom home</p>} />
        <Route path="/admin-settings" element={<AdminSettingsRoute />} />
      </Routes>
    </MemoryRouter>
  );
  return render(
    <ShellProvider value={shell(role)}>
      {sharedNotices ? (
        <SuccessNoticeProvider routeKey="admin-settings">
          {route}
        </SuccessNoticeProvider>
      ) : route}
    </ShellProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getIdToken.mockResolvedValue("id-token");
  mocks.cmsGetSettings.mockImplementation(
    async (_token: string, request: { id: string }) => ({
      success: true,
      found: false,
      id: request.id,
    }),
  );
  mocks.cmsSaveSettings.mockResolvedValue({
    success: true,
    changed: true,
    id: "newsroom-home",
    settings: {
      schemaVersion: 1,
      values: { bannerHeading: "Preparing the newsroom publishing workflow" },
      version: 1,
    },
  });
  mocks.cmsListPages.mockResolvedValue({ success: true, pages: [] });
  mocks.cmsPublish.mockResolvedValue({
    success: true,
    queueId: "queue-public-banner",
    dispatched: true,
    status: "publishing",
    message: "Publish queued.",
  });
  mocks.fetchAdminStatus.mockResolvedValue({
    schemaVersion: 2,
    status: "current",
    environment: "Production",
    generatedAt: "2026-08-25T12:00:00.000Z",
    refreshAfter: "2026-08-28T12:00:00.000Z",
    build: {
      revision: "d805028221a24448055bf0adcce344d1921547b7",
      builtAt: "2026-08-25T12:00:00.000Z",
    },
    milestone: {
      number: 16,
      title: "M14: Admin interface + UX",
      state: "closed",
      openIssues: 0,
      closedIssues: 37,
      updatedAt: "2026-08-19T17:28:15.000Z",
      url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
    },
    milestones: [
      {
        number: 6,
        title: "M4: CMS + editorial workflow",
        state: "open",
        openIssues: 8,
        closedIssues: 87,
        updatedAt: "2026-08-24T15:15:06.000Z",
        url: "https://github.com/CenterCoopMedia/njpbs/milestone/6",
      },
      {
        number: 16,
        title: "M14: Admin interface + UX",
        state: "closed",
        openIssues: 0,
        closedIssues: 37,
        updatedAt: "2026-08-19T17:28:15.000Z",
        url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
      },
    ],
  });
});
describe("Admin settings route", () => {
  it("scrolls to and focuses the NJ Decides hash target after its settings load", async () => {
    let finishLoading!: () => void;
    mocks.cmsGetSettings.mockImplementation((_token: string, request: { id: string }) =>
      request.id === NJ_DECIDES_SETTINGS_ID
        ? new Promise(resolve => { finishLoading = () => resolve({ success: true, found: false, id: request.id }); })
        : Promise.resolve({ success: true, found: false, id: request.id }));
    const scroll = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      renderRoute("admin", false, "newsroom-defaults", "/admin-settings#nj-decides-settings-heading");
      await waitFor(() => expect(finishLoading).toBeTypeOf("function"));
      expect(screen.queryByRole("heading", { name: "NJ Decides brand" })).not.toBeInTheDocument();
      await act(async () => finishLoading());
      const heading = await screen.findByRole("heading", { name: "NJ Decides brand" });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(scroll).toHaveBeenCalledWith({ block: "center" });
      expect(heading).toHaveAttribute("data-route-focus-heading", "true");
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });
  it("publishes the separate public homepage banner through one server-owned settings operation", async () => {
    const publicValues = {
      enabled: true,
      message: "Weather may affect tonight's schedule.",
      linkLabel: "View schedule",
      linkHref: "/schedule/",
    };
    mocks.cmsGetSettings.mockImplementation(
      async (_token: string, request: { id: string }) =>
        request.id === PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID
          ? {
              success: true,
              found: true,
              id: request.id,
              settings: {
                schemaVersion: 1,
                values: publicValues,
                version: 4,
              },
            }
          : { success: true, found: false, id: request.id },
    );
    mocks.cmsPublishSettings.mockResolvedValue({
      publication: settingsPublicationFixture(4),
      success: true,
      changed: true,
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      settings: {
        schemaVersion: 1,
        values: publicValues,
        version: 5,
        published: {
          schemaVersion: 1,
          values: publicValues,
          sourceVersion: 4,
          publishedAt: "2026-08-31T14:00:00.000Z",
        },
      },
    });
    renderRoute("admin", false, "public-homepage-banner");

    const bannerHeading = await screen.findByRole("heading", { name: "Public homepage banner" });
    expect(bannerHeading).toBeVisible();
    const bannerPanel = bannerHeading.closest("section");
    if (!bannerPanel) throw new Error("Expected the banner panel");
    fireEvent.click(within(bannerPanel).getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(mocks.cmsPublishSettings).toHaveBeenCalledWith("id-token", {
        id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
        baseVersion: 4,
      }),
    );
    expect(mocks.cmsPublish).not.toHaveBeenCalled();
    expect(await screen.findByText(/Updating the site/)).toBeVisible();
  });

  it("publishes the site navigation through one server-owned settings operation", async () => {
    mocks.cmsGetSettings.mockImplementation(
      async (_token: string, request: { id: string }) =>
        request.id === SITE_NAVIGATION_SETTINGS_ID
          ? {
              success: true,
              found: true,
              id: request.id,
              settings: { schemaVersion: 1, values: DEFAULT_SITE_NAVIGATION, version: 2 },
            }
          : { success: true, found: false, id: request.id },
    );
    mocks.cmsPublishSettings.mockResolvedValue({
      publication: settingsPublicationFixture(2),
      success: true,
      changed: true,
      id: SITE_NAVIGATION_SETTINGS_ID,
      settings: {
        schemaVersion: 1,
        values: DEFAULT_SITE_NAVIGATION,
        version: 3,
        published: {
          schemaVersion: 1,
          values: DEFAULT_SITE_NAVIGATION,
          sourceVersion: 2,
          publishedAt: "2026-09-25T14:00:00.000Z",
        },
      },
    });
    renderRoute("admin", false, "site-navigation");

    const heading = await screen.findByRole("heading", { name: "Site navigation" });
    const panel = heading.closest("section");
    if (!panel) throw new Error("Expected the site navigation panel");
    await waitFor(() => expect(mocks.cmsListPages).toHaveBeenCalledWith("id-token"));
    fireEvent.click(within(panel).getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(mocks.cmsPublishSettings).toHaveBeenCalledWith("id-token", {
        id: SITE_NAVIGATION_SETTINGS_ID,
        baseVersion: 2,
      }),
    );
    expect(mocks.cmsPublish).not.toHaveBeenCalled();
    expect(await screen.findByText(/Updating the site/)).toBeVisible();
  });

  it("publishes the header newsletter action through one server-owned settings operation", async () => {
    const chromeValues = {
      newsletterEnabled: true,
      newsletterLabel: "Newsletter",
      newsletterHref: "/newsletter/",
      newsletterOpensInNewTab: false,
    };
    mocks.cmsGetSettings.mockImplementation(
      async (_token: string, request: { id: string }) =>
        request.id === PUBLIC_SITE_CHROME_SETTINGS_ID
          ? {
              success: true,
              found: true,
              id: request.id,
              settings: { schemaVersion: 1, values: chromeValues, version: 6 },
            }
          : { success: true, found: false, id: request.id },
    );
    mocks.cmsPublishSettings.mockResolvedValue({
      publication: settingsPublicationFixture(6),
      success: true,
      changed: true,
      id: PUBLIC_SITE_CHROME_SETTINGS_ID,
      settings: {
        schemaVersion: 1,
        values: chromeValues,
        version: 7,
        published: {
          schemaVersion: 1,
          values: chromeValues,
          sourceVersion: 6,
          publishedAt: "2026-09-21T19:00:00.000Z",
        },
      },
    });
    renderRoute("admin", false, "public-site-chrome");

    const heading = await screen.findByRole("heading", { name: "Public header newsletter action" });
    const panel = heading.closest("section");
    if (!panel) throw new Error("Expected the header newsletter panel");
    fireEvent.click(within(panel).getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(mocks.cmsPublishSettings).toHaveBeenCalledWith("id-token", {
        id: PUBLIC_SITE_CHROME_SETTINGS_ID,
        baseVersion: 6,
      }),
    );
    expect(mocks.cmsPublish).not.toHaveBeenCalled();
    expect(await screen.findByText(/Updating the site/)).toBeVisible();
  });

  it("opens the connected brand owner from the Page heading link", async () => {
    const scroll = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      renderRoute("admin", false, "newsroom-defaults", "/admin-settings#nj-decides-settings-heading");
      const heading = await screen.findByRole("heading", { name: "NJ Decides brand" });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(scroll).toHaveBeenCalledWith({ block: "center" });
      expect(mocks.cmsGetSettings).toHaveBeenCalledWith("id-token", { id: NJ_DECIDES_SETTINGS_ID });
      expect(mocks.cmsGetSettings).not.toHaveBeenCalledWith("id-token", { id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });

  it("publishes NJ Decides branding through the route-bound settings operation", async () => {
    const brandValues = {
      backgroundColor: "#e9eaee",
      textColor: "#011375",
      linkColor: "#011375",
      ruleColor: "#8B0000",
      accentColor: "#011375",
      flagEnabled: true,
    };
    mocks.cmsGetSettings.mockImplementation(
      async (_token: string, request: { id: string }) =>
        request.id === NJ_DECIDES_SETTINGS_ID
          ? {
              success: true,
              found: true,
              id: request.id,
              settings: { schemaVersion: 1, values: brandValues, version: 3 },
            }
          : { success: true, found: false, id: request.id },
    );
    mocks.cmsPublishSettings.mockResolvedValue({
      publication: settingsPublicationFixture(3),
      success: true,
      changed: true,
      id: NJ_DECIDES_SETTINGS_ID,
      settings: {
        schemaVersion: 1,
        values: brandValues,
        version: 4,
        published: {
          schemaVersion: 1,
          values: brandValues,
          sourceVersion: 3,
          publishedAt: "2026-10-26T16:00:00.000Z",
        },
      },
    });
    renderRoute("admin", false, "nj-decides-brand");

    const heading = await screen.findByRole("heading", { name: "NJ Decides brand" });
    const panel = heading.closest("section");
    if (!panel) throw new Error("Expected the NJ Decides brand panel");
    fireEvent.click(within(panel).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(mocks.cmsPublishSettings).toHaveBeenCalledWith(
      "id-token",
      { id: NJ_DECIDES_SETTINGS_ID, baseVersion: 3 },
    ));
    expect(mocks.cmsPublish).not.toHaveBeenCalled();
  });

  it("creates the first saved newsroom banner from the plain-language default", async () => {
    const view = renderRoute("admin", true);

    const input = await screen.findByRole("textbox", { name: "Main heading" });
    expect(input).toHaveValue("Admin interface and user experience");
    fireEvent.change(input, {
      target: { value: "Preparing the newsroom publishing workflow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save newsroom banner" }));

    await waitFor(() => expect(mocks.cmsSaveSettings).toHaveBeenCalledWith(
      "id-token",
      {
        id: "newsroom-home",
        values: { bannerHeading: "Preparing the newsroom publishing workflow" },
        createOnly: true,
      },
    ));
    await waitFor(() =>
      expect(view.container.querySelector(".success-notice")).toHaveTextContent(
        "Newsroom banner saved.",
      ),
    );
    expect(
      view.container.querySelector(
        ".admin-settings-form > .inline-message-success",
      ),
    ).toBeNull();
  });

  it("uses the loaded version as the update precondition", async () => {
    mocks.cmsGetSettings.mockResolvedValue({
      success: true,
      found: true,
      id: "newsroom-home",
      settings: {
        schemaVersion: 1,
        values: { bannerHeading: "Current newsroom work" },
        version: 4,
      },
    });
    renderRoute();

    const input = await screen.findByRole("textbox", { name: "Main heading" });
    fireEvent.change(input, { target: { value: "Next newsroom priority" } });
    fireEvent.click(screen.getByRole("button", { name: "Save newsroom banner" }));

    await waitFor(() => expect(mocks.cmsSaveSettings).toHaveBeenCalledWith(
      "id-token",
      {
        id: "newsroom-home",
        values: { bannerHeading: "Next newsroom priority" },
        baseVersion: 4,
      },
    ));
  });

  it("saves the milestone selected for Newsroom home", async () => {
    mocks.cmsSaveSettings.mockResolvedValueOnce({
      success: true,
      changed: true,
      id: "newsroom-milestone",
      settings: {
        schemaVersion: 1,
        values: { milestoneNumber: 6 },
        version: 1,
      },
    });
    renderRoute();

    const select = await screen.findByRole("combobox", { name: "Milestone" });
    expect(select).toHaveValue("16");
    fireEvent.change(select, { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Save current milestone" }));

    await waitFor(() =>
      expect(mocks.cmsSaveSettings).toHaveBeenCalledWith("id-token", {
        id: "newsroom-milestone",
        values: { milestoneNumber: 6 },
        createOnly: true,
      }),
    );
    expect(await screen.findByText("Current milestone saved.")).toBeVisible();
  });

  it("lets an admin replace a saved milestone that left the catalog", async () => {
    const currentStatus = await mocks.fetchAdminStatus();
    const fallbackMilestone = currentStatus.milestones[0];
    mocks.fetchAdminStatus.mockResolvedValue({
      ...currentStatus,
      milestone: fallbackMilestone,
      milestones: [fallbackMilestone],
    });
    mocks.cmsGetSettings.mockImplementation(
      async (_token: string, request: { id: string }) =>
        request.id === "newsroom-milestone"
          ? {
              success: true,
              found: true,
              id: "newsroom-milestone",
              settings: {
                schemaVersion: 1,
                values: { milestoneNumber: 999 },
                version: 4,
              },
            }
          : { success: true, found: false, id: "newsroom-home" },
    );
    mocks.cmsSaveSettings.mockResolvedValueOnce({
      success: true,
      changed: true,
      id: "newsroom-milestone",
      settings: {
        schemaVersion: 1,
        values: { milestoneNumber: 6 },
        version: 5,
      },
    });
    renderRoute();

    expect(await screen.findByRole("combobox", { name: "Milestone" }))
      .toHaveValue("6");
    expect(
      screen.getByText(/Saved milestone 999 is no longer in the GitHub catalog/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /^Newsroom defaults$/ })).toBeVisible();
    const save = screen.getByRole("button", { name: "Save current milestone" });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(mocks.cmsSaveSettings).toHaveBeenCalledWith("id-token", {
        id: "newsroom-milestone",
        values: { milestoneNumber: 6 },
        baseVersion: 4,
      }),
    );
  });

  it("offers to reload the saved heading after a version conflict", async () => {
    mocks.cmsSaveSettings.mockRejectedValue({ status: 409 });
    renderRoute();

    const input = await screen.findByRole("textbox", { name: "Main heading" });
    fireEvent.change(input, { target: { value: "A newer newsroom priority" } });
    fireEvent.click(screen.getByRole("button", { name: "Save newsroom banner" }));

    const reload = await screen.findByRole("button", {
      name: "Reload saved heading",
    });
    const save = screen.getByRole("button", { name: "Save newsroom banner" });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: "Keep this local correction" } });
    expect(input).toHaveValue("Keep this local correction");
    expect(save).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(mocks.cmsSaveSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(reload);

    await waitFor(() =>
      expect(
        mocks.cmsGetSettings.mock.calls.filter(
          ([, request]) => request.id === "newsroom-home",
        ),
      ).toHaveLength(2),
    );
  });

  it("requires a fresh milestone version after a conflict, even if the selection changes", async () => {
    mocks.cmsSaveSettings.mockRejectedValue({ status: 409 });
    renderRoute();
    const select = await screen.findByRole("combobox", { name: "Milestone" });
    fireEvent.change(select, { target: { value: "6" } });
    const save = screen.getByRole("button", { name: "Save current milestone" });
    fireEvent.click(save);
    const reload = await screen.findByRole("button", { name: "Reload saved milestone" });
    expect(save).toBeDisabled();
    fireEvent.change(select, { target: { value: "16" } });
    expect(save).toBeDisabled();
    fireEvent.submit(select.closest("form")!);
    expect(mocks.cmsSaveSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(reload);
    const refreshed = await screen.findByRole("combobox", { name: "Milestone" });
    fireEvent.change(refreshed, { target: { value: "6" } });
    expect(screen.getByRole("button", { name: "Save current milestone" })).toBeEnabled();
  });

  it.each(["production", ""])("shows studio device settings for the production/default target (%s)", async target => {
    vi.stubEnv("VITE_CMS_DEPLOYMENT_ENVIRONMENT", target);
    try {
      renderRoute("admin", false, "studio-devices");
      expect(await screen.findByRole("region", { name: "Live production devices" })).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Studio PC name" })).toBeVisible();
      expect(screen.getByRole("heading", { name: "Public website" })).toBeVisible();
    } finally { vi.unstubAllEnvs(); }
  });

  it("omits production device enrollment from the dev build", async () => {
    vi.stubEnv("VITE_CMS_DEPLOYMENT_ENVIRONMENT", "development");
    try {
      renderRoute("admin", false, "studio-devices");
      expect(await screen.findByRole("heading", { name: "Public website" })).toBeVisible();
      expect(screen.queryByRole("button", { name: /^Studio devices$/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Live production devices" })).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Studio PC name" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Public website" })).toBeVisible();
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps editors out of site-wide Admin settings", async () => {
    renderRoute("editor");

    expect(await screen.findByText("Newsroom home")).toBeVisible();
    expect(mocks.cmsGetSettings).not.toHaveBeenCalled();
    expect(mocks.cmsListPages).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Site navigation" })).toBeNull();
  });
});
