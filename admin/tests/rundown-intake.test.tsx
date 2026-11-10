import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RundownIntake } from "../src/components/live-production/RundownIntake";
import { ExitGuardProvider } from "../src/routes/ExitGuard";
import { LiveProductionWorkspace } from "../src/routes/LiveProductionRoute";
import { createMemoryRouter, RouterProvider } from "react-router";
import { fakeRundownClient, reviewView, sourceView } from "./rundown-fixtures";
import { fakeClient } from "./live-production-fixtures";
import type { RundownClient } from "../src/lib/rundown-intake";
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function open(client = fakeRundownClient(), extras: Partial<Parameters<typeof RundownIntake>[0]> = {}) {
  const onStateChange = vi.fn(), onDraftChanged = vi.fn();
  const props = { client, sessionId: "rehearsal", active: false, ended: false, connected: true, hidden: false, disabled: false, onStateChange, onDraftChanged, ...extras };
  const mounted = render(<ExitGuardProvider><RundownIntake {...props} /></ExitGuardProvider>);
  fireEvent.click(screen.getByText(/^Google Docs rundown/));
  await screen.findByRole("button", { name: /Changed · City hearing/ });
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh rundown" })).toBeEnabled());
  return { ...mounted, props, onStateChange, onDraftChanged };
}
describe("source proposal review", () => {
  it("shows current/proposed lines and order, and sends only explicit draft acceptance with chosen fields", async () => {
    const client = fakeRundownClient(); client.decide = vi.fn(client.decide);
    const { onDraftChanged } = await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
    const editor = screen.getByRole("region", { name: "Review source suggestion" });
    expect(editor).toHaveTextContent("Current order: 5"); expect(editor).toHaveTextContent("Source order: 1");
    expect(editor).toHaveTextContent("SYNTHETIC PRIOR HEADLINE");
    expect(within(editor).getByLabelText("Headline")).toHaveValue("SYNTHETIC CITY HEARING");
    fireEvent.click(within(editor).getByLabelText("Replace producer-edited headline"));
    fireEvent.click(within(editor).getByRole("button", { name: "Accept into draft" }));
    await waitFor(() => expect(onDraftChanged).toHaveBeenCalledOnce());
    expect(vi.mocked(client.decide).mock.calls[0][0]).toMatchObject({ action: "accept", reviewVersion: 1, sourceGeneration: 1,
      baseVersion: 1, suggestionId: "headline-change", overrideFields: ["headline"], text: { templateId: "headline", headline: "SYNTHETIC CITY HEARING" } });
    expect(screen.getByRole("heading", { name: "Source proposals" })).toHaveFocus();
  });
  it("requires a template choice for ambiguous lines and keeps ignored proposals separate from drafts", async () => {
    const client = fakeRundownClient(); client.decide = vi.fn(client.decide);
    const { onDraftChanged } = await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Ambiguous · Interview/ }));
    expect(screen.getByRole("button", { name: "Accept into draft" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "name_title" } });
    expect(screen.getByLabelText("Name")).toHaveValue("ALEX EXAMPLE");
    expect(screen.getByLabelText("Title")).toHaveValue("SYNTHETIC REPORTER");
    fireEvent.click(screen.getByRole("button", { name: "Ignore suggestion" }));
    await waitFor(() => expect(client.decide).toHaveBeenCalledOnce());
    expect(vi.mocked(client.decide).mock.calls[0][0]).toMatchObject({ action: "ignore", baseVersion: 0 });
    expect(onDraftChanged).not.toHaveBeenCalled();
  });
  it("identifies producer edits separately from the stored source proposal", async () => {
    const client = fakeRundownClient(); client.decide = vi.fn(client.decide);
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "PRODUCER WORDING" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept into draft" }));
    await waitFor(() => expect(client.decide).toHaveBeenCalledOnce());
    expect(vi.mocked(client.decide).mock.calls[0][0]).toMatchObject({ editedFields: ["headline"], text: { templateId: "headline", headline: "PRODUCER WORDING" } });
  });
  it("tracks wording edits after resolving an ambiguous proposal", async () => {
    const client = fakeRundownClient(); client.decide = vi.fn(client.decide);
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Ambiguous · Interview/ }));
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "name_title" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PRODUCER NAME" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept into draft" }));
    await waitFor(() => expect(client.decide).toHaveBeenCalledOnce());
    expect(vi.mocked(client.decide).mock.calls[0][0].editedFields).toEqual(["name"]);
  });
  it("does not mark mapped text as edited merely because the producer chooses another template", async () => {
    const client = fakeRundownClient(); client.decide = vi.fn(client.decide);
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "name_title" } });
    fireEvent.click(screen.getByLabelText("Replace producer-edited headline"));
    fireEvent.click(screen.getByRole("button", { name: "Accept into draft" }));
    await waitFor(() => expect(client.decide).toHaveBeenCalledOnce());
    expect(vi.mocked(client.decide).mock.calls[0][0].editedFields).toEqual([]);
  });
  it("requires every protected text override for a new template while retaining producer wording and order protection", async () => {
    const client = fakeRundownClient(), review = reviewView();
    review.changes[0].target!.protectedFields = ["headline", "templateId", "order"];
    client.reconcile = async () => structuredClone(review); client.decide = vi.fn(client.decide);
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: "name_title" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PRODUCER WORDING" } });
    const accept = screen.getByRole("button", { name: "Accept into draft" });
    expect(accept).toBeDisabled();
    expect(screen.getByText(/To change templates, select every producer-edited text field/)).toBeInTheDocument();
    fireEvent.click(accept); expect(client.decide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Replace producer-edited headline"));
    expect(accept).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Replace producer-edited template"));
    expect(accept).toBeEnabled();
    expect(screen.getByLabelText("Replace producer-edited order")).not.toBeChecked();
    expect(screen.getByLabelText("Name")).toHaveValue("PRODUCER WORDING");
    fireEvent.click(accept);
    await waitFor(() => expect(client.decide).toHaveBeenCalledOnce());
    expect(vi.mocked(client.decide).mock.calls[0][0]).toMatchObject({ overrideFields: ["headline", "templateId"], editedFields: ["name"],
      text: { templateId: "name_title", name: "PRODUCER WORDING" } });
  });
  it.each([
    { ended: true, connected: true, label: "Session ended. Source reading stopped." },
    { ended: false, connected: false, label: "Source reading paused while disconnected." },
  ])("punctuates cached-source status once when ended=$ended, connected=$connected", async ({ ended, connected, label }) => {
    const client = fakeRundownClient(), cached = sourceView(); cached.source.status = "quota";
    client.source = async () => cached;
    const { rerender, props } = await open(client);
    expect(screen.getByRole("status")).toHaveTextContent("Google request limit reached. Using the last good read.");
    rerender(<ExitGuardProvider><RundownIntake {...props} ended={ended} connected={connected} /></ExitGuardProvider>);
    expect(screen.getByRole("status").textContent).toBe(`${label} Using the last good read.`);
  });
  it("explains parser flags and preserves ordinary review guidance", async () => {
    const client = fakeRundownClient(), review = reviewView();
    const flags = ["ambiguous_grouping", "editorial_annotation", "repeated_marker", "unknown_parser_flag"];
    review.changes[1].reasons = [...flags, "Producer-edited fields stay protected unless explicitly selected."];
    client.reconcile = async () => review;
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Ambiguous · Interview/ }));
    const editor = screen.getByRole("region", { name: "Review source suggestion" });
    expect(editor).toHaveTextContent("Check how the source lines are grouped, then choose a template.");
    expect(editor).toHaveTextContent("The source includes editorial notes. Check the proposed wording before accepting.");
    expect(editor).toHaveTextContent("This source marker appears more than once. Check the source passage and banner identity.");
    expect(editor).toHaveTextContent("Check the source passage before accepting this suggestion.");
    expect(editor).toHaveTextContent("Producer-edited fields stay protected unless explicitly selected.");
    for (const flag of flags) expect(editor).not.toHaveTextContent(flag);
  });
  it("keeps a focused input enabled while background discovery is in flight", async () => {
    const client = fakeRundownClient(); let release: (value: ReturnType<typeof sourceView>) => void = () => {};
    client.refresh = vi.fn(() => new Promise<ReturnType<typeof sourceView>>(resolve => { release = resolve; }));
    const { rerender, props } = await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
    vi.useFakeTimers();
    rerender(<ExitGuardProvider><RundownIntake {...props} active /></ExitGuardProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const field = screen.getByLabelText("Headline"); field.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(25000); });
    expect(client.refresh).toHaveBeenCalledOnce(); expect(field).toBeEnabled(); expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "CONTINUED TYPING" } }); expect(field).toHaveValue("CONTINUED TYPING");
    await act(async () => { release(sourceView()); });
  });
  it("returns focus once after a decision and preserves mode-switch focus afterward", async () => {
    const client = fakeRundownClient(); const { rerender, props } = await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ignore suggestion" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Source proposals" })).toHaveFocus());
    const outside = document.createElement("button"); document.body.append(outside); outside.focus();
    rerender(<ExitGuardProvider><RundownIntake {...props} hidden /></ExitGuardProvider>);
    rerender(<ExitGuardProvider><RundownIntake {...props} hidden={false} /></ExitGuardProvider>);
    expect(outside).toHaveFocus(); outside.remove();
  });
  it("clears a transient discovery error after automatic recovery", async () => {
    const client = fakeRundownClient(); client.refresh = vi.fn().mockRejectedValueOnce(new Error("Temporary source failure")).mockResolvedValue(sourceView());
    const { rerender, props } = await open(client);
    vi.useFakeTimers();
    rerender(<ExitGuardProvider><RundownIntake {...props} active /></ExitGuardProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(25000); });
    expect(screen.getByText("Temporary source failure")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(50000); });
    expect(client.refresh).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Temporary source failure")).not.toBeInTheDocument();
  });
  it("releases the draft mutation hold when the receipt arrives while the follow-up read remains pending", async () => {
    const client = fakeRundownClient(); const { onStateChange } = await open(client);
    let release: (value: ReturnType<typeof sourceView>) => void = () => {};
    client.source = vi.fn(() => new Promise<ReturnType<typeof sourceView>>(resolve => { release = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept into draft" }));
    await screen.findByText(/Accepted into a saved draft/);
    expect(client.source).toHaveBeenCalledOnce();
    expect(onStateChange).toHaveBeenLastCalledWith(false, false);
    expect(screen.getByRole("button", { name: "Refresh rundown" })).toBeDisabled();
    await act(async () => { release(sourceView()); });
  });
  it("retains an uncertain decision and retries the same identity, including the dirty exit guard", async () => {
    const client = fakeRundownClient(), decide = client.decide;
    client.decide = vi.fn().mockRejectedValueOnce(new Error("Network unavailable")).mockImplementation(decide);
    const { onStateChange } = await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept into draft" }));
    const retry = await screen.findByRole("button", { name: "Retry decision receipt" });
    expect(onStateChange).toHaveBeenLastCalledWith(true, false);
    fireEvent.click(retry);
    await waitFor(() => expect(client.decide).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.decide).mock.calls[0][0].requestId).toBe(vi.mocked(client.decide).mock.calls[1][0].requestId);
  });
  it("keeps proposed edits visible during a newer source and refuses the stale decision", async () => {
    const client = fakeRundownClient();
    const next = sourceView(); next.source.generation = 2; next.snapshot!.hash = "new-source";
    client.refresh = async () => next;
    client.reconcile = vi.fn(client.reconcile).mockImplementationOnce(fakeRundownClient().reconcile)
      .mockImplementation(async () => ({ ...await fakeRundownClient().reconcile("rehearsal", 2), version: 2, sourceGeneration: 2 }));
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "MY PROPOSED EDIT" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh rundown" }));
    await screen.findByText(/The source or review changed/);
    expect(screen.getByLabelText("Headline")).toHaveValue("MY PROPOSED EDIT");
    expect(screen.getByRole("button", { name: "Accept into draft" })).toBeDisabled();
  });
  it("stops automatic discovery when inactive, disconnected or unmounted", async () => {
    const client = fakeRundownClient(); client.refresh = vi.fn(client.refresh);
    const { rerender, unmount, props } = await open(client);
    vi.useFakeTimers();
    rerender(<ExitGuardProvider><RundownIntake {...props} active /></ExitGuardProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(25000); });
    expect(client.refresh).toHaveBeenCalledTimes(1);
    rerender(<ExitGuardProvider><RundownIntake {...props} active={false} /></ExitGuardProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(client.refresh).toHaveBeenCalledTimes(1);
    rerender(<ExitGuardProvider><RundownIntake {...props} active connected={false} /></ExitGuardProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(client.refresh).toHaveBeenCalledTimes(1);
    unmount(); await vi.advanceTimersByTimeAsync(60000); expect(client.refresh).toHaveBeenCalledTimes(1);
  });
  it("reloads the actual saved source and version after a configuration conflict", async () => {
    const client = fakeRundownClient(); client.configure = vi.fn().mockRejectedValue(Object.assign(new Error("Source changed"), { status: 409 }));
    await open(client);
    fireEvent.click(screen.getByText("Source settings"));
    fireEvent.change(screen.getByLabelText("Google Doc ID"), { target: { value: "edited_doc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save source settings" }));
    await screen.findByText(/Source changed.*Reload source settings/);
    const saved = sourceView(); saved.source.configVersion = 2; saved.source.config!.documentId = "other_saved_doc";
    client.source = async () => saved;
    fireEvent.click(screen.getByRole("button", { name: "Reload source settings" }));
    await waitFor(() => expect(screen.getByLabelText("Google Doc ID")).toHaveValue("other_saved_doc"));
    fireEvent.change(screen.getByLabelText("Google Doc ID"), { target: { value: "final_doc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save source settings" }));
    await waitFor(() => expect(client.configure).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.configure).mock.calls[1][1]).toBe(2);
  });
  it("preserves manual banner edits when an accepted suggestion refreshes the shared workspace", async () => {
    const studio = fakeClient(), client: RundownClient = fakeRundownClient(); studio.command = vi.fn(studio.command);
    render(<ExitGuardProvider><RouterProvider router={createMemoryRouter([{ path: "/", element: <LiveProductionWorkspace client={studio} rundownClient={client} /> }])} /></ExitGuardProvider>);
    await screen.findByRole("option", { name: /Studio rehearsal/ });
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
    fireEvent.click(await screen.findByRole("button", { name: /Headline · v1/ })); fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "UNSAVED MANUAL TEXT" } });
    fireEvent.click(screen.getByText(/^Google Docs rundown/));
    fireEvent.click(await screen.findByRole("button", { name: /Changed · City hearing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept into draft" }));
    await screen.findByText(/Accepted into a saved draft/);
    expect(screen.getAllByLabelText("Headline")[0]).toHaveValue("UNSAVED MANUAL TEXT");
    expect(studio.command).not.toHaveBeenCalled();
  });
  it.each(["settings", "proposal", "receipt"] as const)("retains %s work across banner changes without a false discard prompt, but guards session exit", async kind => {
    const client = fakeRundownClient();
    if (kind === "receipt") client.decide = vi.fn().mockRejectedValue(new Error("Network unavailable"));
    render(<ExitGuardProvider><RouterProvider router={createMemoryRouter([{ path: "/", element: <LiveProductionWorkspace client={fakeClient()} rundownClient={client} /> }])} /></ExitGuardProvider>);
    await screen.findByRole("option", { name: /Studio rehearsal/ });
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
    fireEvent.click(await screen.findByRole("button", { name: /Headline · v1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    fireEvent.click(screen.getByText(/^Google Docs rundown/));
    await screen.findByRole("button", { name: /Changed · City hearing/ });
    if (kind === "settings") {
      fireEvent.click(screen.getByText("Source settings"));
      fireEvent.change(screen.getByLabelText("Google Doc ID"), { target: { value: "unsaved_doc" } });
    } else {
      fireEvent.click(screen.getByRole("button", { name: /Changed · City hearing/ }));
      if (kind === "proposal") fireEvent.change(within(screen.getByRole("region", { name: "Review source suggestion" })).getByLabelText("Headline"), { target: { value: "UNSAVED SOURCE WORDING" } });
      else {
        fireEvent.click(screen.getByRole("button", { name: "Accept into draft" }));
        await screen.findByRole("button", { name: "Retry decision receipt" });
      }
    }
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    fireEvent.click(screen.getByRole("button", { name: /Name and title · v1/ }));
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    if (kind === "settings") expect(screen.getByLabelText("Google Doc ID")).toHaveValue("unsaved_doc");
    else if (kind === "proposal") expect(within(screen.getByRole("region", { name: "Review source suggestion" })).getByLabelText("Headline")).toHaveValue("UNSAVED SOURCE WORDING");
    else expect(screen.getByRole("button", { name: "Retry decision receipt" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add banner" }));
    const newBanner = within(screen.getByRole("heading", { name: "New banner" }).closest("form")!);
    fireEvent.change(newBanner.getByLabelText("Banner template"), { target: { value: "name_title" } });
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument();
    expect(newBanner.getByLabelText("Name")).toHaveValue("");
    fireEvent.click(newBanner.getByRole("button", { name: "Cancel new banner" }));
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "" } });
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Production session")).toHaveValue("rehearsal");
  });
});
