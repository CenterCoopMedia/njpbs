import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PublicHomepageBannerSettings } from "../src/components/PublicHomepageBannerSettings";
import { PublicSiteChromeSettings } from "../src/components/PublicSiteChromeSettings";
import { SiteNavigationSettings } from "../src/components/SiteNavigationSettings";
import { HttpError, type GetSettingsResponse } from "../src/lib/functions";
import { DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, DEFAULT_SITE_NAVIGATION } from "../../packages/content-core/src/cms-settings";

const message = "Boardwalk was updated. Reload this page, then publish again.";
function document<T>(id: string, values: T): GetSettingsResponse<T> {
  return { success: true, found: true, id, settings: { schemaVersion: 1, version: 4, values } };
}

describe("public settings publish refusal", () => {
  const refusals = [
    { label: "upgrade", code: "settings_publication_client_outdated", message },
    { label: "release", code: "settings_publication_unavailable", message: "A public code release is in progress. Try this publication again shortly." },
    { label: "billing", code: "settings_publication_unavailable", message: "Public publication is paused by the billing control." },
  ];
  it.each(["banner", "header", "navigation"].flatMap(kind => refusals.map(refusal => ({ kind, ...refusal }))))(
    "keeps the $kind form and shows the $label refusal in place", async ({ kind, code, message: refusalMessage }) => {
    const save = vi.fn(async () => { throw new Error("A publish refusal must not save the draft"); });
    const publish = vi.fn(async () => { throw new HttpError(409, refusalMessage, { code }); });
    if (kind === "banner") render(<PublicHomepageBannerSettings save={save} publish={publish}
      load={async () => document("public-homepage-banner", { enabled: true, message: "Saved banner message" })} />);
    if (kind === "header") render(<PublicSiteChromeSettings save={save} publish={publish}
      load={async () => document("public-site-chrome", { ...DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, newsletterLabel: "Saved header label" })} />);
    if (kind === "navigation") render(<SiteNavigationSettings save={save} publish={publish} loadPages={async () => []}
      load={async () => document("site-navigation", DEFAULT_SITE_NAVIGATION)} />);
    const button = await screen.findByRole("button", { name: "Publish" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(refusalMessage);
    expect(screen.getByText("Saved draft version 4")).toBeVisible();
    expect(screen.queryByText("This setting changed after you opened it.")).not.toBeInTheDocument();
    if (kind === "banner") expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Saved banner message");
    if (kind === "header") expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue("Saved header label");
    if (kind === "navigation") expect(screen.getAllByRole("textbox", { name: "Column heading" })[0]).toHaveValue("Watch");
    expect(save).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
