import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SavedPreview, type SavedPreviewProps } from "../src/components/SavedPreview";

const queueId = "abcdefghijklmnopqrst";
const target = { collection: "cmsPages" as const, documentId: "contact", sourceVersion: 7 };
const result = (overrides = {}) => ({ success: true as const, ...target, pageId: target.documentId,
  queueId, rendererSha: "a".repeat(40), status: "ready" as const, pagePath: "/contact/",
  previewUrl: `https://preview.njpbs.org/p/${queueId}/`, error: null, requestedAt: null, completedAt: null,
  expiresAt: new Date(Date.now() + 86400000).toISOString(), reused: true as const, retryAfterMs: 0, ...overrides });
function deferred<T>() { let resolve!: (value:T)=>void; const promise = new Promise<T>(yes => { resolve=yes; }); return {promise,resolve}; }
function props(overrides = {}): SavedPreviewProps {
  return { collection: "cmsPages", documentId: "contact", enabled: true,
    preparePreview: vi.fn(async () => target), requestPreview: vi.fn(async () => result()),
    loadPreviewStatus: vi.fn(async () => result()), ...overrides };
}
let popup: { closed:boolean; document: Document; opener: unknown; focus: ReturnType<typeof vi.fn>; close:ReturnType<typeof vi.fn>; location: { replace:ReturnType<typeof vi.fn> } };
beforeEach(() => {
  popup = { closed:false, document:document.implementation.createHTMLDocument(), opener:window, focus:vi.fn(), close:vi.fn(), location: { replace:vi.fn() } };
  vi.spyOn(window,"open").mockImplementation(() => popup as unknown as Window);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("one Preview action", () => {
  it("does no background exports or polling and renders no refresh action", async () => {
    vi.useFakeTimers(); const input=props(); render(<SavedPreview {...input}/>);
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(input.requestPreview).not.toHaveBeenCalled(); expect(input.loadPreviewStatus).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button",{name:"Preview"})).toBeEnabled();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it.each(["cmsPages", "cmsPosts"])("explains unavailable Preview for %s through a focusable control", collection => {
    const input = props({ collection, enabled: false, disabledReason: "Finish or cancel the media changes before previewing." });
    render(<SavedPreview {...input} />);
    const shell = screen.getByRole("group", { name: /Preview unavailable: Finish or cancel/ });
    expect(shell).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAccessibleDescription("Finish or cancel the media changes before previewing.");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(window.open).not.toHaveBeenCalled();
  });
  it("opens immediately, waits for the confirmed save, and navigates exactly once", async () => {
    const save = deferred<typeof target>(); const input=props({preparePreview:vi.fn(()=>save.promise)});
    render(<SavedPreview {...input}/>); fireEvent.click(screen.getByRole("button",{name:"Preview"}));
    expect(window.open).toHaveBeenCalledTimes(1); expect(popup.opener).toBeNull();
    expect(popup.document.title).toBe("Preparing preview | Boardwalk");
    expect(input.requestPreview).not.toHaveBeenCalled();
    await act(async()=>{save.resolve(target);});
    await waitFor(()=>expect(popup.location.replace).toHaveBeenCalledWith(result().previewUrl+"contact/"));
    expect(input.requestPreview).toHaveBeenCalledWith(target);
    expect(popup.location.replace).toHaveBeenCalledTimes(1);
  });
  it("coalesces repeated clicks while saving without opening more tabs", async () => {
    const save=deferred<typeof target>(); const input=props({preparePreview:vi.fn(()=>save.promise)});
    render(<SavedPreview {...input}/>); const button=screen.getByRole("button",{name:"Preview"});
    fireEvent.click(button); fireEvent.click(button); fireEvent.click(button);
    expect(window.open).toHaveBeenCalledTimes(1);
    await act(async()=>{save.resolve(target);});
    await waitFor(()=>expect(input.requestPreview).toHaveBeenCalledTimes(1));
  });
  it("immediately waits on the accepted job before automatically opening it", async () => {
    vi.useFakeTimers(); const input=props({requestPreview:vi.fn(async()=>result({status:"pending",previewUrl:null}))});
    render(<SavedPreview {...input}/>); fireEvent.click(screen.getByRole("button",{name:"Preview"}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    expect(input.loadPreviewStatus).toHaveBeenCalledWith(queueId, { signal: expect.any(AbortSignal), waitMs: 5000, observedStatus: "pending" });
    expect(popup.location.replace).toHaveBeenCalledTimes(1);
  });
  it("shows context refresh progress and stops that progress on the typed failure", async () => {
    vi.useFakeTimers();
    const status = deferred<ReturnType<typeof result>>();
    const input = props({
      requestPreview: vi.fn(async () => result({ status: "building", contextRefreshing: true, previewUrl: null })),
      loadPreviewStatus: vi.fn(() => status.promise),
    });
    render(<SavedPreview {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(popup.document.title).toBe("Previews are refreshing | Boardwalk");
    expect((popup.document.querySelector(".preview-footer") as HTMLElement).hidden).toBe(false);
    await act(async () => { status.resolve(result({ status: "failed", failureReason: "preview_context_refreshing", previewUrl: null })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Previews are refreshing after a recent publish. Try again in a minute.");
    expect(popup.document.querySelector(".cms-preview-progress")?.getAttribute("data-state")).toBe("error");
    expect((popup.document.querySelector(".preview-footer") as HTMLElement).hidden).toBe(true);
    expect((popup.document.querySelector(".preview-steps") as HTMLElement).hidden).toBe(true);
    expect(popup.location.replace).not.toHaveBeenCalled();
  });
  it("accepts and polls a pending preview while session setup runs, then waits before navigation", async () => {
    vi.useFakeTimers();
    const session = deferred<void>();
    const input = props({ prepareSession: vi.fn(() => session.promise),
      requestPreview: vi.fn(async () => result({ status: "pending", previewUrl: null })) });
    render(<SavedPreview {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(input.prepareSession).toHaveBeenCalledTimes(1);
    expect(input.requestPreview).toHaveBeenCalledWith(target);
    expect(input.loadPreviewStatus).toHaveBeenCalledWith(queueId, { signal: expect.any(AbortSignal), waitMs: 5000, observedStatus: "pending" });
    expect(popup.location.replace).not.toHaveBeenCalled();
    await act(async () => { session.resolve(undefined); });
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(result().previewUrl + "contact/");
  });

  it.each(["unmount", "popup closure"])("does not navigate after %s while the ready result waits for session setup", async (ending) => {
    vi.useFakeTimers();
    const session = deferred<void>();
    const input = props({ prepareSession: vi.fn(() => session.promise),
      requestPreview: vi.fn(async () => result({ status: "pending", previewUrl: null })) });
    const view = render(<SavedPreview {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(input.loadPreviewStatus).toHaveBeenCalledWith(queueId, { signal: expect.any(AbortSignal), waitMs: 5000, observedStatus: "pending" });
    expect(popup.location.replace).not.toHaveBeenCalled();
    if (ending === "unmount") view.unmount();
    else popup.closed = true;
    await act(async () => { session.resolve(undefined); });
    expect(popup.location.replace).not.toHaveBeenCalled();
  });

  it("retains the normal navigation fallback when session setup rejects", async () => {
    vi.useFakeTimers();
    const input = props({ prepareSession: vi.fn(async () => { throw new Error("Session unavailable"); }),
      requestPreview: vi.fn(async () => result({ status: "pending", previewUrl: null })) });
    render(<SavedPreview {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(input.loadPreviewStatus).toHaveBeenCalledWith(queueId, { signal: expect.any(AbortSignal), waitMs: 5000, observedStatus: "pending" });
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(result().previewUrl + "contact/");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not save or build when the browser blocks the new tab", async()=>{
    vi.mocked(window.open).mockReturnValue(null); const input=props();
    render(<SavedPreview {...input}/>); fireEvent.click(screen.getByRole("button",{name:"Preview"}));
    expect(input.preparePreview).not.toHaveBeenCalled(); expect(input.requestPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/allow.*pop-ups/i);
  });
  it("keeps failures truthful without returning a previously rendered page", async()=>{
    const input=props({preparePreview:vi.fn(async()=>{throw new Error("private transport details");})});
    render(<SavedPreview {...input}/>);fireEvent.click(screen.getByRole("button",{name:"Preview"}));
    await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent(/edits.*editor/i));
    expect(screen.queryByText(/private transport details/)).toBeNull();
    expect(input.requestPreview).not.toHaveBeenCalled(); expect(popup.location.replace).not.toHaveBeenCalled();
  });
  it("cancels a closed progress tab without dispatching after a late save", async()=>{
    vi.useFakeTimers(); const save=deferred<typeof target>(); const input=props({preparePreview:vi.fn(()=>save.promise)});
    render(<SavedPreview {...input}/>);fireEvent.click(screen.getByRole("button",{name:"Preview"}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);}); popup.closed=true;
    await act(async()=>{await vi.advanceTimersByTimeAsync(500);save.resolve(target);});
    expect(input.requestPreview).not.toHaveBeenCalled(); expect(popup.location.replace).not.toHaveBeenCalled();
  });
  it("ignores an old document response after navigation",async()=>{
    const requested=deferred<ReturnType<typeof result>>();const input=props({requestPreview:vi.fn(()=>requested.promise)});
    const view=render(<SavedPreview {...input}/>);fireEvent.click(screen.getByRole("button",{name:"Preview"}));
    await waitFor(()=>expect(input.requestPreview).toHaveBeenCalledTimes(1));
    view.rerender(<SavedPreview {...input} documentId="about"/>);
    await act(async()=>{requested.resolve(result());});
    expect(popup.location.replace).not.toHaveBeenCalled();
  });
  it("will not turn a retained export into the immutable opening path",async()=>{
    const input=props({requestPreview:vi.fn(async()=>result({previewUrl:`https://preview.njpbs.org/s/${queueId}/`}))});
    render(<SavedPreview {...input}/>);fireEvent.click(screen.getByRole("button",{name:"Preview"}));
    await waitFor(()=>expect(screen.getByRole("alert")).toBeVisible());
    expect(popup.location.replace).not.toHaveBeenCalled();
  });
  it("recovers a transient preview request without saving twice or opening another tab",async()=>{
    vi.useFakeTimers();
    const request=vi.fn().mockRejectedValueOnce(Object.assign(new Error("Temporary"),{status:503})).mockResolvedValueOnce(result());
    const input=props({requestPreview:request});render(<SavedPreview {...input}/>);
    fireEvent.click(screen.getByRole("button",{name:"Preview"}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(750);});
    expect(request).toHaveBeenCalledTimes(2);expect(input.preparePreview).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledTimes(1);expect(popup.location.replace).toHaveBeenCalledTimes(1);
  });
  it("explains a renderer update after the bounded retries finish", async () => {
    vi.useFakeTimers();
    const updating = Object.assign(new Error("Preview renderer is updating; try again shortly"), {
      status: 503,
      data: { code: "preview-renderer-updating" },
    });
    const request = vi.fn().mockRejectedValue(updating);
    const input = props({ requestPreview: request });
    render(<SavedPreview {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await act(async () => { await vi.advanceTimersByTimeAsync(2_250); });

    expect(request).toHaveBeenCalledTimes(3);
    expect(input.preparePreview).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The preview service is updating. Try Preview again in a few minutes. Your edits remain in the editor.",
    );
    expect(popup.document.title).toBe("Preview service is updating | Boardwalk");
    expect(popup.document.body.textContent).toContain("Return to the CMS and select Preview again in a few minutes.");
  });
  it("keeps an uncoded preview outage generic after the bounded retries finish", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(Object.assign(new Error("private service detail"), {
      status: 503,
      data: { code: "other-service-state" },
    }));
    render(<SavedPreview {...props({ requestPreview: request })} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await act(async () => { await vi.advanceTimersByTimeAsync(2_250); });

    expect(request).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Preview is temporarily unavailable. Your edits remain in the editor.",
    );
    expect(screen.queryByText("private service detail")).toBeNull();
    expect(popup.document.title).toBe("Preview unavailable | Boardwalk");
  });
  it("does not retry revoked access or silently choose other content",async()=>{
    vi.useFakeTimers();
    const request=vi.fn().mockRejectedValue(Object.assign(new Error("Denied"),{status:403}));
    render(<SavedPreview {...props({requestPreview:request})}/>);
    fireEvent.click(screen.getByRole("button",{name:"Preview"}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(request).toHaveBeenCalledTimes(1);expect(popup.location.replace).not.toHaveBeenCalled();
  });
  it("releases a tab the reader navigated elsewhere instead of redirecting it later",async()=>{
    vi.useFakeTimers();const request=deferred<ReturnType<typeof result>>();
    render(<SavedPreview {...props({requestPreview:vi.fn(()=>request.promise)})}/>);
    fireEvent.click(screen.getByRole("button",{name:"Preview"}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    popup.document=document.implementation.createHTMLDocument();
    await act(async()=>{await vi.advanceTimersByTimeAsync(500);request.resolve(result());});
    expect(popup.location.replace).not.toHaveBeenCalled();expect(popup.close).not.toHaveBeenCalled();
  });

});

it.each(["unmount", "popup closure"])("aborts the in-flight status transport on %s", async ending => {
  vi.useFakeTimers();
  const status = deferred<ReturnType<typeof result>>();
  const loadPreviewStatus = vi.fn(() => status.promise);
  const input = props({ requestPreview: vi.fn(async () => result({ status: "pending", previewUrl: null })), loadPreviewStatus });
  const view = render(<SavedPreview {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  const signal = vi.mocked(input.loadPreviewStatus).mock.calls[0][1]!.signal;
  expect(signal.aborted).toBe(false);
  if (ending === "unmount") view.unmount(); else popup.closed = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(signal.aborted).toBe(true);
  expect(loadPreviewStatus).toHaveBeenCalledTimes(1);
  expect(popup.location.replace).not.toHaveBeenCalled();
});
