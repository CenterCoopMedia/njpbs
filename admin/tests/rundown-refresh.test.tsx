import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ExitGuardProvider } from "../src/routes/ExitGuard";
import { LiveProductionWorkspace } from "../src/routes/LiveProductionRoute";
import type { LiveProductionClient } from "../src/lib/live-production-workspace";
import type { RundownClient } from "../src/lib/rundown-intake";
import { banners, fakeClient } from "./live-production-fixtures";
import { fakeRundownClient, reviewView } from "./rundown-fixtures";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function open(studio: LiveProductionClient, client: RundownClient) {
  render(<ExitGuardProvider><RouterProvider router={createMemoryRouter([
    { path: "/", element: <LiveProductionWorkspace client={studio} rundownClient={client} /> },
  ])} /></ExitGuardProvider>);
  await screen.findByRole("option", { name: /Studio rehearsal/ });
  fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
  await screen.findByRole("button", { name: /Name and title · v1/ });
}

async function openProposal() {
  fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
  fireEvent.click(screen.getByText(/^Google Docs rundown/));
  fireEvent.click(await screen.findByRole("button", { name: /Changed · City hearing/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Accept into draft" })).toBeEnabled());
}

describe("rundown draft synchronization", () => {
  it.each([
    { beyond: true, onAir: false }, { beyond: false, onAir: false },
    { beyond: true, onAir: true }, { beyond: false, onAir: true },
    { beyond: false, onAir: false, failRead: true },
  ])("refreshes the selected accepted revision before live actions (already beyond=$beyond, on air=$onAir, failed read=$failRead)", async ({ beyond, onAir, failRead = false }) => {
    const studio = fakeClient({ onAir }), client = fakeRundownClient();
    const [name, headline] = banners();
    let accepted = false, failed = false, release = () => {};
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const saved = { ...headline, order: 4, record: { ...headline.record,
      draft: { ...headline.record.draft, version: 2, text: { templateId: "headline" as const, headline: "SYNTHETIC CITY HEARING" } } } };
    studio.banners = vi.fn(async (_id, cursor) => {
      if (cursor) {
        if (accepted && failRead && !failed) { failed = true; throw new Error("SYNTHETIC BANNER READ FAILED"); }
        if (accepted) await waiting;
        return { banners: [accepted ? saved : headline], nextCursor: null };
      }
      return beyond || accepted ? { banners: [name], nextCursor: "second" } : { banners: [headline, name], nextCursor: null };
    });
    studio.command = vi.fn(studio.command);
    const decide = client.decide;
    client.decide = async (...args) => { accepted = true; return decide(...args); };
    await open(studio, client);
    if (beyond) fireEvent.click(screen.getByRole("button", { name: "Load more banners" }));
    fireEvent.click(await screen.findByRole("button", { name: /Headline · v1/ }));
    await openProposal();
    fireEvent.click(screen.getByLabelText("Replace producer-edited headline"));
    fireEvent.click(screen.getByRole("button", { name: "Accept into draft" }));
    await screen.findByText(/Accepted into a saved draft/);
    await waitFor(() => expect(vi.mocked(studio.banners).mock.calls.filter(([, cursor]) => cursor === "second")).toHaveLength(beyond ? 2 : 1));
    if (failRead) {
      await screen.findByText("SYNTHETIC BANNER READ FAILED");
      expect(screen.getAllByText("Use Refresh studio to load the accepted draft before another live action.").length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Refresh studio" }));
      await waitFor(() => expect(vi.mocked(studio.banners).mock.calls.filter(([, cursor]) => cursor === "second")).toHaveLength(2));
    }
    expect(screen.queryByText(/outside the refreshed rundown/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^(Update live|Take saved banner)$/ })).toBeDisabled();
    expect(studio.command).not.toHaveBeenCalled();
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByLabelText("Headline")).toHaveValue("SYNTHETIC CITY HEARING"));
    expect(screen.getByLabelText("Order number")).toHaveValue("5");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    const live = screen.getByRole("button", { name: onAir ? "Update live" : "Take saved banner" });
    await waitFor(() => expect(live).toBeEnabled());
    fireEvent.click(live);
    expect(studio.command).toHaveBeenCalledWith(expect.objectContaining({
      commandAction: onAir ? "update_text" : "take", bannerId: "headline-banner", baseVersion: 2,
    }));
  });

  it("reconciles saved manual text, protected fields and the decision version with an unchanged source hash", async () => {
    const studio = fakeClient(), client = fakeRundownClient();
    const save = studio.save;
    let saved = false;
    studio.save = async request => { const result = await save(request); saved = true; return result; };
    client.reconcile = vi.fn(async () => {
      const review = reviewView();
      if (saved) {
        review.version = 2;
        review.changes[0].target = { ...review.changes[0].target!, baseVersion: 2,
          text: { templateId: "headline", headline: "MANUALLY SAVED HEADLINE" }, protectedFields: ["headline", "templateId"] };
      }
      return review;
    });
    client.decide = vi.fn(client.decide);
    client.refresh = vi.fn(client.refresh);
    await open(studio, client);
    fireEvent.click(screen.getByRole("button", { name: /Headline · v1/ }));
    await openProposal();
    const initialReconciliations = vi.mocked(client.reconcile).mock.calls.length;
    const editor = within(screen.getByRole("region", { name: "Review source suggestion" }));
    fireEvent.change(editor.getByLabelText("Headline"), { target: { value: "RETAIN PROPOSED WORDING" } });
    fireEvent.change(screen.getAllByLabelText("Headline")[0], { target: { value: "MANUALLY SAVED HEADLINE" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved. Output has not changed.");
    await waitFor(() => expect(client.reconcile).toHaveBeenCalledTimes(initialReconciliations + 1));
    expect(editor.getByLabelText("Headline")).toHaveValue("RETAIN PROPOSED WORDING");
    expect(editor.getByRole("button", { name: "Accept into draft" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(editor.getByRole("button", { name: "Accept into draft" })).toBeEnabled());
    expect(editor.getByText("Current draft · v2")).toBeInTheDocument();
    expect(editor.getByText("MANUALLY SAVED HEADLINE")).toBeInTheDocument();
    expect(editor.getByLabelText("Replace producer-edited template")).toBeInTheDocument();
    expect(editor.queryByLabelText("Replace producer-edited order")).not.toBeInTheDocument();
    fireEvent.click(editor.getByRole("button", { name: "Accept into draft" }));
    await waitFor(() => expect(client.decide).toHaveBeenCalledOnce());
    expect(vi.mocked(client.decide).mock.calls[0][0]).toMatchObject({ baseVersion: 2, reviewVersion: 2, sourceGeneration: 1 });
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it("reloads a server-refused stale review without retrying or discarding proposed wording", async () => {
    const studio = fakeClient(), client = fakeRundownClient();
    let refused = false;
    client.reconcile = vi.fn(async () => ({ ...reviewView(), version: refused ? 2 : 1 }));
    client.decide = vi.fn(async () => {
      refused = true;
      throw Object.assign(new Error("The record changed."), { status: 409 });
    });
    await open(studio, client);
    fireEvent.click(screen.getByRole("button", { name: /Headline · v1/ }));
    await openProposal();
    const initialReconciliations = vi.mocked(client.reconcile).mock.calls.length;
    const editor = within(screen.getByRole("region", { name: "Review source suggestion" }));
    fireEvent.change(editor.getByLabelText("Headline"), { target: { value: "RETAIN WORDING AFTER REFUSAL" } });
    fireEvent.click(editor.getByRole("button", { name: "Accept into draft" }));
    await screen.findByText(/Refresh rundown to compare the latest suggestion/);
    await waitFor(() => expect(client.reconcile).toHaveBeenCalledTimes(initialReconciliations + 1));
    expect(editor.getByLabelText("Headline")).toHaveValue("RETAIN WORDING AFTER REFUSAL");
    expect(editor.getByRole("button", { name: "Accept into draft" })).toBeDisabled();
    expect(client.decide).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Retry decision receipt" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(editor.getByRole("button", { name: "Accept into draft" })).toBeEnabled());
  });
});
