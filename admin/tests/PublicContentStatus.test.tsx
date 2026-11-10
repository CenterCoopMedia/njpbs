import { webcrypto, createHash } from "node:crypto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicContentStatusProvider } from "../src/context/PublicContentStatusContext";
import { PublishedVersionStatus } from "../src/components/PublishedVersionStatus";
import { loadPublicContentStatus, readPublicContentStatus } from "../src/lib/public-content-status";
import { cmsGetPublicationStatus, cmsRetryPublication, cmsRecheckPublication } from "../src/lib/functions";

vi.mock("../src/lib/functions", () => ({ cmsGetPublicationStatus: vi.fn(), cmsRetryPublication: vi.fn(), cmsRecheckPublication: vi.fn() }));

const identity = { schemaVersion: 1, buildBatchId: "build-one", generation: 1, commitSha: "a".repeat(40) };
const contentKey = createHash("sha256").update("cmsPosts/post-one").digest("hex");
const contactKey = createHash("sha256").update("cmsPages/contact").digest("hex");
function receipt(version = 8, publication = identity) {
  return { ...publication, collections: ["cmsPages", "cmsPosts"], routes: [
    { path: "/", source: "site" },
    { path: "/posts/one/", source: "cms", sourceVersion: version, contentKey },
  ] };
}
function saved(queueStatus: string | null = "pending"): Awaited<ReturnType<typeof cmsGetPublicationStatus>> {
  const settled = ["success", "failed", "cancelled", "superseded", "public_unconfirmed"].includes(queueStatus ?? "");
  return { success: true as const, found: true, publication: {
    workingVersion: 12, contentVersion: 3, workingStatus: "draft",
    publishedSourceVersion: 10, publishedContentVersion: 2,
    publicSourceVersion: queueStatus === "success" ? 10 : 8, publiclyVisible: true,
    publicUpdatePending: !["success", "public_unconfirmed"].includes(queueStatus ?? ""),
    publicBuildQueueId: settled ? null : "queue-one", queueStatus,
  } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

describe("public version evidence", () => {
  it.each(["saved", "dirty", "saving"] as const)("document bar preserves confirmed Page evidence with %s draft state", state => {
    render(<PublishedVersionStatus collection="cmsPages" documentId="contact" workingVersion={12}
      contentVersion={3} publishedSourceVersion={10} publishedContentVersion={2} workingStatus="draft"
      documentBar={{ kind: "page", draftState: state }} loadPublicationMetadata={false} watchPublicReceipts={false}
      publicationTransport="page-no-build-v1" pageReceipt={{ operationId: "A".repeat(20), sourceVersion: 10, visible: true }} />);
    expect(screen.getByText(state === "saved" ? "Draft saved" : state === "dirty" ? "Unsaved changes" : "Saving…")).toBeVisible();
    expect(screen.getByText("v2 live")).toBeVisible();
    expect(screen.getByText(/Newer draft/)).toBeVisible();
  });
  it("does not turn unknown Post publication evidence into a live claim in the document bar", () => {
    render(<PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={30} contentVersion={30}
      publishedSourceVersion={29} publishedContentVersion={29} workingStatus="draft"
      documentBar={{ kind: "post", draftState: "saved" }} loadPublicationMetadata={false} watchPublicReceipts={false} />);
    expect(screen.getByText("Captured draft")).toBeVisible();
    expect(screen.queryByText("v29 live")).not.toBeInTheDocument();
  });

  it("shows the confirmed Page receipt without public inventory reads", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render(<PublishedVersionStatus collection="cmsPages" documentId="contact" workingVersion={12}
      contentVersion={3} publishedSourceVersion={10} publishedContentVersion={2}
      loadPublicationMetadata={false} watchPublicReceipts={false}
      publicationTransport="page-no-build-v1" pageReceipt={{ operationId: "A".repeat(20), sourceVersion: 10, visible: true }} />);
    expect(screen.getByText("Version 2 live")).toBeVisible();
    expect(screen.getByText("Working version 3 is newer")).toBeVisible();
    expect(fetch).not.toHaveBeenCalled(); expect(cmsGetPublicationStatus).not.toHaveBeenCalled();
  });
  it("uses the completed Page list projection without hydrating an idle row", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("_content-status") ? receipt() : identity)));
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPages" documentId="contact" workingVersion={12}
        publishedSourceVersion={10} publishedContentVersion={2} loadPublicationMetadata={false}
        publicationTransport="page-no-build-v1" pageReceipt={{ operationId: "A".repeat(20), sourceVersion: 10, visible: true }} />
    </PublicContentStatusProvider>);
    expect(await screen.findByText("Version 2 live")).toBeVisible();
    expect(cmsGetPublicationStatus).not.toHaveBeenCalled();
  });
  it("keeps the exhausted warning in the compact editor without public inventory reads", async () => {
    const warning = "The public check failed after publication. The publisher needs attention.";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved("success"), publication: {
      ...saved("success").publication, postServingConfirmed: false, postProofStatus: "failed",
      postProofPending: false, postProofWarning: warning,
    } });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12}
        compact watchPublicReceipts={false} canRetry />
    </PublicContentStatusProvider>);
    expect(await screen.findByText("Public check failed")).toBeVisible();
    expect(screen.getByText(warning)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry publication" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("shows the served Post before proof and polls its failure and recovery after queue success", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("_content-status") ? receipt(8) : identity)));
    let proof: "pending" | "failed" | "verified" = "pending";
    vi.mocked(cmsGetPublicationStatus).mockImplementation(async () => ({ ...saved("success"), publication: {
      ...saved("success").publication, postServingConfirmed: proof !== "failed", postProofStatus: proof,
      postProofPending: proof !== "verified", ...(proof === "failed" ? {
        postProofWarning: "The public check failed after publication. The publisher will retry." } : {}),
    } }));
    const view = render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} canRetry />
    </PublicContentStatusProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Version 2 live")).toBeVisible();
    expect(screen.queryByText("Waiting for public confirmation")).not.toBeInTheDocument();
    proof = "failed";
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("Public check failed")).toBeVisible();
    expect(screen.getByText("The public check failed after publication. The publisher will retry.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry publication" })).not.toBeInTheDocument();
    proof = "verified";
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("Version 2 live")).toBeVisible();
    expect(screen.queryByText("Public check failed")).not.toBeInTheDocument();
    const calls = vi.mocked(cmsGetPublicationStatus).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(cmsGetPublicationStatus).toHaveBeenCalledTimes(calls);
    view.unmount();
  });

  it("keeps the current Post pending without the server's served confirmation", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("_content-status") ? receipt(8) : identity)));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved("success"), publication: {
      ...saved("success").publication, postProofStatus: "pending", postServingConfirmed: false,
    } });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} />
    </PublicContentStatusProvider>);
    expect(await screen.findByText("Waiting for public confirmation")).toBeVisible();
    expect(screen.queryByText("Version 2 live")).not.toBeInTheDocument();
  });
  it.each([true, false])("uses the exact Page completion receipt when static inventory is stale (visible %s)", async visible => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? { ...receipt(), routes: [{ path: "/contact/", source: "site" }] } : identity)));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved("success"), publication: {
      ...saved("success").publication, publiclyVisible: visible, publicSourceVersion: visible ? 10 : null,
      publicationTransport: "page-no-build-v1", pageReceipt: { operationId: "A".repeat(20), sourceVersion: 10, visible },
    } });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPages" documentId="contact" workingVersion={12} canRetry canRetryWithdrawal />
    </PublicContentStatusProvider>);
    expect(await screen.findByText(visible ? "Version 2 live" : "Not live")).toBeVisible();
    expect(screen.queryByText("Site content live")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
  });
  it("keeps a failed Page operation retryable even when the static inventory has the same source number", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? { ...receipt(), routes: [{ path: "/contact/", source: "cms", sourceVersion: 10, contentKey: contactKey }] } : identity)));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved("failed"), publication: {
      ...saved("failed").publication, publicBuildQueueId: "A".repeat(20), publicationTransport: "page-no-build-v1",
    } });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPages" documentId="contact" workingVersion={12} canRetry />
    </PublicContentStatusProvider>);
    expect(await screen.findByRole("button", { name: "Retry publication" })).toBeEnabled();
    expect(screen.queryByText("Version 2 live")).not.toBeInTheDocument();
  });
  it.each(["home", "post"])("keeps %s removal retry visible after detail confirmation until the full build is confirmed", async kind => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? { ...receipt(), routes: [] } : identity)));
    let status = "failed";
    vi.mocked(cmsGetPublicationStatus).mockImplementation(async () => ({ ...saved(status), publication: {
      ...saved(status).publication, publiclyVisible: false,
      ...(status === "success" ? {} : kind === "home"
        ? { homeWarning: "Home may briefly show the previous card until the full build finishes." }
        : { withdrawalBuildPending: true }),
    } }));
    vi.mocked(cmsRetryPublication).mockImplementation(async () => {
      status = "pending";
      return { success: true, queueId: "retry-home", dispatched: false, status: "pending", message: "Queued" };
    });
    const editor = () => <PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} canRetryWithdrawal />
    </PublicContentStatusProvider>;
    let view = render(editor());
    await screen.findByText("Not live");
    fireEvent.click(await screen.findByRole("button", { name: "Retry removal" }));
    expect(await screen.findByText("Removal is queued")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry removal" })).toBeDisabled();
    view.unmount();
    status = "success";
    view = render(editor());
    await screen.findByText(/Saved version 3/);
    expect(screen.queryByRole("button", { name: "Retry removal" })).not.toBeInTheDocument();
  });
  it("retains the slower Home removal warning after detail removal is confirmed and the editor reloads", async () => {
    const warning = "Removal is taking the slower path; the story stays on Home until the full build finishes";
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? { ...receipt(), routes: [] } : identity)));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved(), publication: {
      ...saved().publication, publiclyVisible: false, homeWarning: warning,
    } });
    const editor = () => <PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} />
    </PublicContentStatusProvider>;
    const first = render(editor());
    expect(await screen.findByText(warning)).toBeVisible();
    first.unmount();
    render(editor());
    expect(await screen.findByText(warning)).toBeVisible();
  });
  it("reuses the inventory only after validating both unchanged public receipts", async () => {
    const fetchMock = vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? receipt() : identity,
    ));
    vi.stubGlobal("fetch", fetchMock);

    const first = await loadPublicContentStatus(new AbortController().signal);
    const second = await loadPublicContentStatus(new AbortController().signal, first);

    expect(second).toBe(first);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("_publication")).length).toBe(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("_content-status")).length).toBe(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/contact/"))).toBe(false);
  });

  it.each([
    { ...receipt(), routes: null },
    { ...receipt(), buildBatchId: "different-inventory" },
  ])("refuses an invalid inventory even when the publication identity is unchanged", async invalid => {
    let status: unknown = receipt();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? status : identity,
    )));
    const first = await loadPublicContentStatus(new AbortController().signal);
    status = invalid;
    await expect(loadPublicContentStatus(new AbortController().signal, first)).rejects.toThrow("do not match");
  });

  it("replaces inventory only for a matching changed publication", async () => {
    let publication = identity;
    let status = receipt();
    const fetchMock = vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? status : publication,
    ));
    vi.stubGlobal("fetch", fetchMock);
    const first = await loadPublicContentStatus(new AbortController().signal);
    const changed = { ...identity, buildBatchId: "build-two", generation: 2, commitSha: "b".repeat(40) };
    publication = changed;
    status = receipt(10, changed);

    const second = await loadPublicContentStatus(new AbortController().signal, first);
    expect(second).not.toBe(first);
    expect(second.routes).toContainEqual(expect.objectContaining({ sourceVersion: 10 }));

    publication = { ...changed, generation: 3 };
    await expect(loadPublicContentStatus(new AbortController().signal, second)).rejects.toThrow(
      "Public version receipts do not match.",
    );
    publication = { ...changed, generation: "2" } as unknown as typeof identity;
    await expect(loadPublicContentStatus(new AbortController().signal, second)).rejects.toThrow(
      "Public version receipt is invalid.",
    );
  });

  it("does not fetch public receipts until a surface watches them", async () => {
    const fetchMock = vi.fn(async () => Response.json(receipt()));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PublicContentStatusProvider getIdToken={async () => "test-token"}>
        <p>Idle shell</p>
      </PublicContentStatusProvider>,
    );
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts in-flight public reads when the user provider unmounts", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, options?: RequestInit) => {
      const signal = options?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("Expected an abort signal.");
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }));
    const view = render(
      <PublicContentStatusProvider getIdToken={async () => "test-token"}>
        <PublishedVersionStatus
          collection="cmsPosts"
          documentId="post-one"
          loadPublicationMetadata={false}
          workingVersion={12}
        />
      </PublicContentStatusProvider>,
    );
    await waitFor(() => expect(signals).toHaveLength(2));

    view.unmount();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("disposes the validated inventory with its user provider", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const fetchMock = vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? receipt() : identity,
    ));
    vi.stubGlobal("fetch", fetchMock);
    const status = (key: string) => (
      <PublicContentStatusProvider key={key} getIdToken={async () => "test-token"}>
        <PublishedVersionStatus
          collection="cmsPosts"
          documentId="post-one"
          loadPublicationMetadata={false}
          publishedSourceVersion={8}
          workingVersion={12}
        />
      </PublicContentStatusProvider>
    );
    const view = render(status("user-one"));
    await screen.findByText("Published copy live");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("_content-status"))).toHaveLength(1);

    view.rerender(status("user-two"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("_content-status"))).toHaveLength(2);
    });
  });

  it("does not keep a public-status timer while the document is hidden", async () => {
    const started = vi.spyOn(window, "setInterval");
    const clear = vi.spyOn(window, "clearInterval");
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/contact/")
      ? new Response("") : Response.json(url.includes("_content-status") ? receipt() : identity)));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue(saved());
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} />
    </PublicContentStatusProvider>);
    await screen.findByText("The saved copy is queued");
    expect(started.mock.calls.map(([, delay]) => delay)).toContain(5_000);
    expect(started.mock.calls.map(([, delay]) => delay)).toContain(10_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(clear).toHaveBeenCalled();
  });

  it("uses list fields on home without starting the public receipt poll", async () => {
    const fetchMock = vi.fn(async () => Response.json(receipt()));
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus
        compact
        collection="cmsPosts"
        documentId="post-one"
        loadPublicationMetadata={false}
        watchPublicReceipts={false}
        liveSourceVersion={8}
        contentVersion={4}
        workingVersion={12}
      />
    </PublicContentStatusProvider>);
    expect(await screen.findByText("Published copy live")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cmsGetPublicationStatus).not.toHaveBeenCalled();
  });

  it.each([
    { route: { path: "/contact/", source: "site" }, label: "Site content live" },
    { route: { path: "/contact/", source: "cms", sourceVersion: 7, contentKey: contactKey }, label: "Version 3 live" },
  ])("reads Contact from the committed inventory like every other unowned Page ($label)", async ({ route, label }) => {
    vi.stubGlobal("crypto", webcrypto);
    const fetchMock = vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? { ...receipt(), routes: [{ path: "/", source: "site" }, route] } : identity));
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus
        collection="cmsPages"
        documentId="contact"
        loadPublicationMetadata={false}
        contentVersion={3}
        publishedContentVersion={3}
        publishedSourceVersion={7}
        workingVersion={3}
      />
    </PublicContentStatusProvider>);
    expect(await screen.findByText(label)).toBeVisible();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/contact/"))).toBe(false);
  });

  it.each([
    { pageConfirmation: { checking: false, attempts: 0, nextAttemptAt: 0 }, stage: "Publication accepted" },
    { pageConfirmation: { checking: true, attempts: 1, nextAttemptAt: Date.now() + 60_000 }, stage: "Checking the public page" },
    { pageConfirmation: { checking: false, attempts: 1, nextAttemptAt: Date.now() + 60_000 }, stage: "Waiting to check the public page again" },
  ])("shows the real build-free Page check stage ($stage)", async ({ pageConfirmation, stage }) => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("_content-status") ? receipt() : identity)));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved("pending"), publication: {
      ...saved("pending").publication, publicationTransport: "page-no-build-v1", pageConfirmation,
    } });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPages" documentId="accessibility" workingVersion={12} />
    </PublicContentStatusProvider>);
    const publishing = await screen.findByText("The saved copy is publishing");
    const progress = publishing.closest(".loading-indicator");
    expect(progress?.querySelector(".loading-indicator-stage")).toHaveTextContent(stage);
    expect(screen.queryByText("Waiting for the publish service to pick up the job")).not.toBeInTheDocument();
  });

  it("marks a retained receipt checking when polling resumes", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue(saved());
    let releaseSecond: ((value: Response) => void) | undefined;
    let receiptCalls = 0;
    let publication = identity;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/contact/")) return new Response("");
      if (!url.includes("_content-status")) return Response.json(publication);
      receiptCalls += 1;
      if (receiptCalls === 1) return Response.json(receipt());
      return new Promise<Response>((resolve) => { releaseSecond = resolve; });
    }));
    const { rerender } = render(
      <PublicContentStatusProvider getIdToken={async () => "test-token"}>
        <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} />
      </PublicContentStatusProvider>,
    );
    expect(await screen.findByText("The saved copy is queued")).toBeVisible();
    const changed = { ...identity, buildBatchId: "build-two", generation: 2, commitSha: "b".repeat(40) };
    publication = changed;
    rerender(
      <PublicContentStatusProvider getIdToken={async () => "test-token"}>
        <p>Idle shell</p>
      </PublicContentStatusProvider>,
    );
    rerender(
      <PublicContentStatusProvider getIdToken={async () => "test-token"}>
        <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} />
      </PublicContentStatusProvider>,
    );
    expect(await screen.findByText("Checking public site…")).toBeVisible();
    await act(async () => { releaseSecond?.(Response.json(receipt(8, changed))); });
  });

  it("refreshes settled metadata when the document becomes visible", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("/contact/")
      ? new Response("")
      : Response.json(url.includes("_content-status") ? receipt() : identity))));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({
      ...saved(null),
      publication: {
        ...saved(null).publication,
        publicUpdatePending: false,
        publicBuildQueueId: null,
        queueStatus: null,
      },
    });
    render(
      <PublicContentStatusProvider getIdToken={async () => "test-token"}>
        <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} />
      </PublicContentStatusProvider>,
    );
    expect(await screen.findByText("Published copy live")).toBeVisible();
    const afterLoad = vi.mocked(cmsGetPublicationStatus).mock.calls.length;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(vi.mocked(cmsGetPublicationStatus).mock.calls.length).toBeGreaterThan(afterLoad);
  });

  it("rejects mismatched, unscoped, and malformed receipts instead of showing not live", () => {
    expect(readPublicContentStatus(receipt(), identity)).toHaveLength(2);
    expect(() => readPublicContentStatus(receipt(), { ...identity, generation: 2 })).toThrow();
    expect(() => readPublicContentStatus({ ...receipt(), collections: undefined }, identity)).toThrow();
    expect(() => readPublicContentStatus({ ...receipt(), routes: [{ path: "/", source: "cms", sourceVersion: 0 }] }, identity)).toThrow();
    expect(() => readPublicContentStatus({ ...receipt(), routes: [...receipt().routes, receipt().routes[1]] }, identity)).toThrow();
  });

  it("refreshes live and failed state without replacing unsaved input", async () => {
    vi.stubGlobal("crypto", webcrypto);
    let version = 8;
    let publication = identity;
    let inventoryPublication = identity;
    let broken = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (broken) throw new Error("Offline");
      return Response.json(url.includes("_content-status") ? receipt(version, inventoryPublication) : publication);
    }));
    let queueStatus = "pending";
    vi.mocked(cmsGetPublicationStatus).mockImplementation(async (_token, request) =>
      request.id === "home" ? { ...saved(), found: false, publication: {
        ...saved().publication, workingVersion: null, publishedSourceVersion: null,
        publiclyVisible: false, publicUpdatePending: false, publicBuildQueueId: null, queueStatus: null,
      } } : saved(queueStatus));
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <input aria-label="Unsaved title" defaultValue="Original" />
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} />
      <PublishedVersionStatus collection="cmsPages" documentId="home" />
    </PublicContentStatusProvider>);
    expect(await screen.findByText("Published copy live")).toBeVisible();
    const queued = await screen.findByText("The saved copy is queued");
    expect(queued).toBeVisible();
    // In-flight progress is the shared indicator, and its stage line is the real queue state.
    const progress = queued.closest(".loading-indicator");
    expect(progress?.querySelector(".spinner")).toBeInTheDocument();
    expect(progress?.querySelector(".loading-indicator-stage")).toHaveTextContent(
      "Waiting for the publish service to pick up the job",
    );
    expect(await screen.findByText("Site content live")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Unsaved title"), { target: { value: "Keep this edit" } });

    queueStatus = "failed";
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    const failed = await screen.findAllByText("The saved copy was not published. Retry publication.");
    expect(failed).not.toHaveLength(0);
    expect(failed[0].querySelector(".activity-indicator")).not.toBeInTheDocument();
    expect(screen.getByText("Published copy live")).toBeVisible();

    version = 10;
    publication = { ...identity, buildBatchId: "build-two", generation: 2, commitSha: "b".repeat(40) };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.queryByText("Published copy live")).not.toBeInTheDocument());
    expect(screen.getAllByText("Public status unavailable")).not.toHaveLength(0);
    inventoryPublication = publication;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByText("Version 2 live")).toBeVisible();
    expect(screen.queryByText("The saved copy was not published. Retry publication."))
      .not.toBeInTheDocument();
    expect(screen.getByLabelText("Unsaved title")).toHaveValue("Keep this edit");

    broken = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.queryByText("Version 2 live")).not.toBeInTheDocument());
    expect(screen.getAllByText("Public status unavailable")).not.toHaveLength(0);
    expect(screen.getByLabelText("Unsaved title")).toHaveValue("Keep this edit");
  });

  it.each([false, true])("waits beyond one minute for public confirmation under the same release identity (withdrawal=%s)", async (withdrawal) => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", webcrypto);
    const publication = identity;
    let routes = receipt().routes;
    const fetchMock = vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? { ...publication, collections: ["cmsPages", "cmsPosts"], routes } : publication,
    ));
    vi.stubGlobal("fetch", fetchMock);
    let metadata = { ...saved("pending"), publication: { ...saved("pending").publication, publiclyVisible: !withdrawal } };
    vi.mocked(cmsGetPublicationStatus).mockImplementation(async () => metadata);
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <input aria-label="Unsaved title" defaultValue="Keep this edit" />
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} canRetry canRetryWithdrawal />
    </PublicContentStatusProvider>);
    await act(async () => {});
    expect(screen.getByText(withdrawal ? "Removal is queued" : "The saved copy is queued")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    metadata = { ...metadata, publication: { ...metadata.publication, queueStatus: "publishing" } };
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText(withdrawal ? "Removing from the public site" : "The saved copy is publishing")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    // Metadata stays at five seconds; both public receipts use ten seconds.
    expect(cmsGetPublicationStatus).toHaveBeenCalledTimes(13);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("_publication")).length).toBe(7);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("_content-status")).length).toBe(7);

    // Successful CMS settlement can arrive before the public receipt catches up.
    metadata = { ...metadata, publication: { ...metadata.publication,
      queueStatus: null, publicBuildQueueId: null, publicUpdatePending: false,
      publicSourceVersion: withdrawal ? null : 10,
    } };
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText(withdrawal ? "Waiting for public removal confirmation" : "Waiting for public confirmation")).toBeVisible();
    expect(screen.queryByText(/not confirmed|did not complete|was not published/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    routes = withdrawal ? [{ path: "/", source: "site" }] : receipt(10, publication).routes;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText(withdrawal ? "Not live" : "Version 2 live")).toBeVisible();
    expect(screen.queryByText(/Waiting for public/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Unsaved title")).toHaveValue("Keep this edit");
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("_content-status")).length).toBe(8);
  });

  it.each(["reserved", "pending", "publishing"])("keeps %s queue progress even if the saved pending flag has cleared", async (queueStatus) => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? receipt() : identity,
    )));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved(queueStatus),
      publication: { ...saved(queueStatus).publication, publicUpdatePending: false },
    });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} />
    </PublicContentStatusProvider>);
    const progress = await screen.findByText(queueStatus === "publishing" ? "The saved copy is publishing" : "The saved copy is queued");
    expect(progress.closest(".loading-indicator")?.querySelector(".spinner")).toBeInTheDocument();
    expect(screen.queryByText(/not confirmed|was not published/)).not.toBeInTheDocument();
  });

  it.each([false, true])("offers recovery when a saved update has no queue (withdrawal=%s)", async (withdrawal) => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? receipt() : identity,
    )));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved(null),
      publication: { ...saved(null).publication, publicBuildQueueId: null, publiclyVisible: !withdrawal },
    });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} canRetry canRetryWithdrawal />
    </PublicContentStatusProvider>);
    expect(await screen.findByText(withdrawal ? "Removal has not started. Retry removal." : "The public update has not started. Retry publication.")).toBeVisible();
    expect(screen.getByRole("button", { name: withdrawal ? "Retry removal" : "Retry publication" })).toBeEnabled();
    expect(screen.queryByText(/was not published/)).not.toBeInTheDocument();
  });

  it.each(["failed", "cancelled", "superseded"].flatMap((queueStatus) =>
    [false, true].map((withdrawal) => ({ queueStatus, withdrawal })),
  ))("keeps settled $queueStatus wording without a queue pointer (withdrawal=$withdrawal)", async ({ queueStatus, withdrawal }) => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? receipt() : identity,
    )));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved(queueStatus),
      publication: { ...saved(queueStatus).publication, publicBuildQueueId: null, publiclyVisible: !withdrawal },
    });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} canRetry canRetryWithdrawal />
    </PublicContentStatusProvider>);
    expect(await screen.findByText(withdrawal ? "Removal did not complete. Retry removal." : "The saved copy was not published. Retry publication.")).toBeVisible();
    expect(screen.getByRole("button", { name: withdrawal ? "Retry removal" : "Retry publication" })).toBeEnabled();
    expect(screen.queryByText(/has not started/)).not.toBeInTheDocument();
  });

  it.each([false, true])("keeps recovery for legacy unconfirmed settlement (withdrawal=%s)", async (withdrawal) => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? receipt() : identity,
    )));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved(null),
      publication: { ...saved(null).publication, publicBuildQueueId: null,
        publicUpdatePending: false, publicSourceVersion: 8, publiclyVisible: !withdrawal },
    });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} canRetry canRetryWithdrawal />
    </PublicContentStatusProvider>);
    expect(await screen.findByText(withdrawal ? "Waiting for public removal confirmation" : "Waiting for public confirmation")).toBeVisible();
    expect(screen.getByRole("button", { name: withdrawal ? "Retry removal" : "Retry publication" })).toBeEnabled();
  });

  it.each(["reserved", "pending", "publishing"])("keeps %s evidence through a failed refresh after the pending flag clears", async (queueStatus) => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", webcrypto);
    const fetchMock = vi.fn(async (url: string) => Response.json(
      url.includes("_content-status") ? receipt() : identity,
    ));
    vi.stubGlobal("fetch", fetchMock);
    const metadata = { ...saved(queueStatus),
      publication: { ...saved(queueStatus).publication, publicUpdatePending: false },
    };
    vi.mocked(cmsGetPublicationStatus).mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(new Error("Transient read failure"))
      .mockResolvedValue(metadata);
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <input aria-label="Unsaved title" defaultValue="Keep this edit" />
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12}
        publicUpdatePending={false} publicBuildQueueId="queue-one" canRetry />
    </PublicContentStatusProvider>);
    await act(async () => {});
    const label = queueStatus === "publishing" ? "The saved copy is publishing" : "The saved copy is queued";
    expect(screen.getByText(label)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("Publish progress unavailable. Check again shortly.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText("Publish progress unavailable. Check again shortly.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Unsaved title")).toHaveValue("Keep this edit");
    expect(cmsGetPublicationStatus).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("_publication"))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("_content-status"))).toHaveLength(2);
  });

  it("polls active publication only while refreshing settled rows on focus", async () => {
    const intervals: (() => void)[] = [];
    const nativeSetInterval = globalThis.setInterval;
    vi.spyOn(window, "setInterval").mockImplementation((callback) => {
      if (typeof callback === "function") intervals.push(() => callback());
      return nativeSetInterval(() => {}, 3_600_000);
    });
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/contact/")
      ? new Response("") : Response.json(url.includes("_content-status") ? receipt() : identity)));
    vi.mocked(cmsGetPublicationStatus).mockImplementation(async (_token, request) => request.id === "home"
      ? { ...saved(), publication: { ...saved().publication, publicUpdatePending: false,
        publiclyVisible: false, publicBuildQueueId: null, queueStatus: null } } : saved());
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} />
      <PublishedVersionStatus collection="cmsPages" documentId="home" />
    </PublicContentStatusProvider>);
    await screen.findByText("Site content live");
    await screen.findByText("The saved copy is queued");
    vi.mocked(cmsGetPublicationStatus).mockClear();
    await act(async () => { intervals.forEach((callback) => callback()); });
    expect(cmsGetPublicationStatus).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cmsGetPublicationStatus).mock.calls[0][1].id).toBe("post-one");
    vi.mocked(cmsGetPublicationStatus).mockClear();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(cmsGetPublicationStatus).toHaveBeenCalledTimes(2);
  });

  it.each([4, 5])("uses summary editorial version %s without loading per-record metadata", async (contentVersion) => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/contact/")
      ? new Response("") : Response.json(url.includes("_content-status") ? receipt() : identity)));
    const getIdToken = vi.fn().mockResolvedValue("test-token");
    render(<PublicContentStatusProvider getIdToken={getIdToken}>
      <PublishedVersionStatus
        collection="cmsPosts"
        documentId="post-one"
        loadPublicationMetadata={false}
        liveSourceVersion={7}
        contentVersion={contentVersion}
        publishedSourceVersion={8}
        publishedContentVersion={4}
        workingVersion={12}
      />
    </PublicContentStatusProvider>);

    expect(await screen.findByText("Version 4 live")).toBeVisible();
    if (contentVersion === 5) {
      expect(screen.getByText("Working version 5 is newer")).toBeVisible();
    } else {
      expect(screen.queryByText(/is newer/)).not.toBeInTheDocument();
    }
    expect(cmsGetPublicationStatus).not.toHaveBeenCalled();
    expect(getIdToken).not.toHaveBeenCalled();
  });

  it.each([3, 4])("compares editorial version %s with the confirmed snapshot", async (contentVersion) => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/contact/")
      ? new Response("") : Response.json(url.includes("_content-status") ? receipt() : identity)));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({
      ...saved("success"),
      publication: { ...saved("success").publication, contentVersion,
        publishedContentVersion: 3, publishedSourceVersion: 8, publicUpdatePending: false },
    });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} />
    </PublicContentStatusProvider>);

    await screen.findByText("Version 3 live");
    if (contentVersion === 4) {
      expect(screen.getByText("Working version 4 is newer")).toBeVisible();
    } else {
      expect(screen.queryByText(/is newer/)).not.toBeInTheDocument();
      expect(screen.getByText("Saved version 3 · Draft")).toBeVisible();
    }
  });

  it.each([
    { queueStatus: "pending", withdrawal: false, text: "The saved copy is queued", active: true },
    { queueStatus: "publishing", withdrawal: false, text: "The saved copy is publishing", active: true },
    { queueStatus: "publishing", withdrawal: true, text: "Removing from the public site", active: true },
    { queueStatus: "cancelled", withdrawal: true, text: "Removal did not complete. Retry removal.", active: false },
    { queueStatus: "failed", withdrawal: false, text: "The saved copy was not published. Retry publication.", active: false },
    { queueStatus: "public_unconfirmed", withdrawal: false, text: "Waiting for public confirmation", active: false },
    { queueStatus: "unavailable", withdrawal: false, text: "Publish progress unavailable. Check again shortly.", active: false },
  ])("animates only active public work: $queueStatus/$withdrawal", async ({ queueStatus, withdrawal, text, active }) => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/contact/")
      ? new Response("") : Response.json(url.includes("_content-status") ? receipt() : identity)));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({
      ...saved(queueStatus),
      publication: { ...saved(queueStatus).publication, publiclyVisible: !withdrawal },
    });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} />
    </PublicContentStatusProvider>);

    const progress = await screen.findByText(text);
    // Active work is the shared indicator around the sentence; settled outcomes are plain text.
    expect(Boolean(progress.closest(".loading-indicator")?.querySelector(".spinner"))).toBe(active);
  });

  it.each([false, true])("retries only the saved snapshot or its removal (withdrawal=%s)", async (withdrawal) => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("/contact/") ? new Response("") : Response.json(url.includes("_content-status") ? receipt() : identity)));
    let queueStatus = "failed";
    vi.mocked(cmsGetPublicationStatus).mockImplementation(async () => ({
      ...saved(queueStatus), publication: { ...saved(queueStatus).publication, publiclyVisible: !withdrawal },
    }));
    let finish: () => void = () => {};
    vi.mocked(cmsRetryPublication).mockImplementation(() => new Promise((resolve) => {
      finish = () => {
        queueStatus = "pending";
        resolve({ success: true, queueId: "retry-one", dispatched: false, status: "pending", message: "Queued" });
      };
    }));
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <input aria-label="Unsaved title" defaultValue="Keep this edit" />
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} canRetry canRetryWithdrawal />
    </PublicContentStatusProvider>);
    fireEvent.click(await screen.findByRole("button", { name: withdrawal ? "Retry removal" : "Retry publication" }));
    const pending = await screen.findByRole("button", { name: /^.+: Requesting…$/ });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(pending);
    expect(cmsRetryPublication).toHaveBeenCalledTimes(1);
    expect(cmsRetryPublication).toHaveBeenCalledWith("test-token", {
      collection: "cmsPosts", id: "post-one", sourceVersion: 10, baseVersion: 12,
      ...(withdrawal ? { operation: "withdraw" } : {}),
    });
    await act(async () => { finish(); });
    expect(await screen.findByText(withdrawal ? "Removal is queued" : "The saved copy is queued")).toBeVisible();
    expect(screen.getByLabelText("Unsaved title")).toHaveValue("Keep this edit");
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
  });

  it.each([
    { publicState: "checking", pending: false, queueStatus: "success", resumable: false, retry: false },
    { publicState: "unavailable", pending: false, queueStatus: "success", resumable: false, retry: false },
    { publicState: "unavailable", pending: true, queueStatus: "failed", resumable: false, retry: true },
    { publicState: "unavailable", pending: true, queueStatus: "reserved", resumable: false, retry: false },
    { publicState: "unavailable", pending: true, queueStatus: "reserved", resumable: true, retry: true },
  ])("offers retry only with evidence and a resumable queue: $publicState/$queueStatus/$resumable", async (state) => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(() => state.publicState === "checking"
      ? new Promise<Response>(() => {}) : Promise.reject(new Error("Offline"))));
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved(), publication: {
      ...saved().publication, publicUpdatePending: state.pending, queueStatus: state.queueStatus,
      canResumeReservation: state.resumable,
    } });
    render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
      <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} canRetry />
    </PublicContentStatusProvider>);
    await screen.findByText(/Saved version 3/);
    expect(Boolean(screen.queryByRole("button", { name: "Retry publication" }))).toBe(state.retry);
  });
});


it.each([true, false])("uses the exact record completion receipt with stale inventory (visible %s)", async visible => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("_content-status") ? receipt(8) : identity)));
  vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved("success"), publication: {
    ...saved("success").publication, publiclyVisible: visible, publicSourceVersion: visible ? 10 : null,
    recordPublication: { queueId: "A".repeat(20), sourceVersion: 10, withdrawal: !visible, status: "success", missingConsumers: [] },
  } });
  render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
    <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} canRetry canRetryWithdrawal />
  </PublicContentStatusProvider>);
  expect(await screen.findByText(visible ? "Version 2 live" : "Not live")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
});
it("keeps a record retryable when static inventory has the same source number", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("_content-status") ? receipt(10) : identity)));
  vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved("failed"), publication: {
    ...saved("failed").publication,
    recordPublication: { queueId: "A".repeat(20), sourceVersion: 10, withdrawal: false, status: "failed", missingConsumers: ["record"], warning: "Retry the accepted record update." },
  } });
  render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
    <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} canRetry />
  </PublicContentStatusProvider>);
  expect(await screen.findByRole("button", { name: "Retry publication" })).toBeVisible();
  expect(screen.queryByText("Version 2 live")).not.toBeInTheDocument();
});

it("shows paused record removal as pending without a retry action", async () => {
  const warning = "Record removal is accepted. Card and index updates will resume when publishing resumes.";
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("_content-status") ? receipt(10) : identity)));
  vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved("pending"), publication: {
    ...saved("pending").publication, publiclyVisible: false,
    recordPublication: { queueId: "A".repeat(20), sourceVersion: 10, withdrawal: true, status: "pending", missingConsumers: ["record"], warning },
  } });
  render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
    <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12} canRetryWithdrawal />
  </PublicContentStatusProvider>);
  expect(await screen.findByText("Removal is queued")).toBeVisible();
  expect(screen.getByText(warning)).toBeVisible();
  expect(screen.queryByText("Removal did not complete. Retry removal.")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry removal" })).not.toBeInTheDocument();
});


it.each([true, false])("polls overdue pending record receipts through completion (visible %s)", async visible => {
  vi.useFakeTimers();
  const publicFetch = vi.fn();
  vi.stubGlobal("fetch", publicFetch);
  let confirmed = false;
  const warning = "The record update is taking longer than expected. Retry publication.";
  vi.mocked(cmsGetPublicationStatus).mockImplementation(async () => ({ ...saved(confirmed ? "success" : "failed"), publication: {
    ...saved(confirmed ? "success" : "failed").publication, publiclyVisible: visible,
    publicSourceVersion: confirmed && visible ? 10 : null,
    publicBuildQueueId: "A".repeat(20),
    recordPublication: { queueId: "A".repeat(20), sourceVersion: 10, withdrawal: !visible,
      status: confirmed ? "success" : "pending", missingConsumers: confirmed ? [] : ["posts", "record"],
      ...(confirmed ? {} : { warning }) },
  } }));
  const view = render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
    <PublishedVersionStatus collection="cmsPosts" documentId="post-one" workingVersion={12}
      canRetry canRetryWithdrawal watchPublicReceipts={false} />
  </PublicContentStatusProvider>);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText(warning)).toBeVisible();
  expect(screen.getByRole("button", { name: visible ? "Retry publication" : "Retry removal" })).toBeVisible();
  confirmed = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText(visible ? "Version 2 live" : "Not live")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
  const reads = vi.mocked(cmsGetPublicationStatus).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(cmsGetPublicationStatus).toHaveBeenCalledTimes(reads);
  expect(publicFetch).not.toHaveBeenCalled();
  view.unmount();
});


it.each(["cmsPages", "cmsPosts"] as const)("names removal in a failed recheckable %s withdrawal", async collection => {
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved("failed"), publication: {
    ...saved("failed").publication, publiclyVisible: false, recheckQueueId: "A".repeat(20),
    ...(collection === "cmsPages" ? { publicationTransport: "page-no-build-v1" as const } : {}),
  } });
  render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
    <PublishedVersionStatus collection={collection} documentId={collection === "cmsPages" ? "contact" : "post-one"}
      workingVersion={12} canRetry canRetryWithdrawal detailsOnly alertsOnly watchPublicReceipts={false} />
  </PublicContentStatusProvider>);
  expect(await screen.findByText("Public removal could not be confirmed. Check again or retry removal.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry removal" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  expect(screen.queryByText(/retry publication/i)).not.toBeInTheDocument();
});

it("rechecks from the record's publication details and refreshes exact metadata", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const first = saved("failed");
  first.publication.recheckQueueId = "A".repeat(20);
  vi.mocked(cmsGetPublicationStatus).mockResolvedValue(first);
  vi.mocked(cmsRecheckPublication).mockImplementation(async () => {
    vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved("success"), publication: {
      ...saved("success").publication, publicationTransport: "page-no-build-v1",
      pageReceipt: { operationId: "A".repeat(20), sourceVersion: 10, visible: true },
    } });
    return { success: true, queueId: "A".repeat(20), outcome: "confirmed_late", message: "Publication confirmed on the public site." };
  });
  render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
    <PublishedVersionStatus collection="cmsPages" documentId="contact" workingVersion={12}
      canRetry detailsOnly alertsOnly watchPublicReceipts={false} />
  </PublicContentStatusProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  await waitFor(() => expect(cmsRecheckPublication).toHaveBeenCalledWith("test-token", "A".repeat(20)));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument());
  expect(cmsGetPublicationStatus).toHaveBeenCalledTimes(2);
});
it.each([false, true])("keeps recheck out of status-only record labels (publish permission %s)", async canRetry => {
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(cmsGetPublicationStatus).mockResolvedValue({ ...saved("failed"), publication: {
    ...saved("failed").publication, recheckQueueId: "A".repeat(20),
  } });
  render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
    <PublishedVersionStatus collection="cmsPages" documentId="contact" workingVersion={12}
      canRetry={canRetry} statusOnly watchPublicReceipts={false} />
  </PublicContentStatusProvider>);
  await waitFor(() => expect(cmsGetPublicationStatus).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
});

it("drops an old recheck result when a different publication fails on the same open record", async () => {
  vi.stubGlobal("fetch", vi.fn());
  let publication: Awaited<ReturnType<typeof cmsGetPublicationStatus>>["publication"] = { ...saved("failed").publication, recheckQueueId: "A".repeat(20) };
  vi.mocked(cmsGetPublicationStatus).mockImplementation(async () => ({ success: true, found: true, publication }));
  vi.mocked(cmsRecheckPublication).mockImplementation(async () => {
    publication = { ...saved("success").publication, recheckQueueId: undefined };
    return { success: true, queueId: "A".repeat(20), outcome: "confirmed_late", message: "Publication confirmed on the public site." };
  });
  render(<PublicContentStatusProvider getIdToken={async () => "test-token"}>
    <PublishedVersionStatus collection="cmsPages" documentId="contact" workingVersion={12}
      canRetry detailsOnly alertsOnly watchPublicReceipts={false} />
  </PublicContentStatusProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  expect(await screen.findByText("Publication confirmed on the public site.")).toBeVisible();
  publication = { ...saved("failed").publication, publicBuildQueueId: "B".repeat(20), recheckQueueId: "B".repeat(20) };
  act(() => window.dispatchEvent(new Event("focus")));
  expect(await screen.findByRole("button", { name: "Check again" })).toBeVisible();
  expect(screen.queryByText("Publication confirmed on the public site.")).not.toBeInTheDocument();
});
