import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PagePreview } from "../src/components/PagePreview";
import type {
  PreviewRequestResponse,
  PreviewStatusResponse,
} from "../src/lib/functions";

const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function status(
  overrides: Partial<PreviewStatusResponse> = {},
): PreviewStatusResponse {
  return {
    success: true,
    queueId: "queue123",
    status: "building",
    pageId: "contact",
    sourceVersion: 7,
    previewUrl: null,
    error: null,
    requestedAt: "2026-07-23T12:00:00.000Z",
    completedAt: null,
    expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    ...overrides,
  };
}

describe("PagePreview", () => {
  it("starts a saved-page preview from the workspace action", async () => {
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    const onReveal = vi.fn();
    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={vi.fn()}
        workspaceAction
        onReveal={onReveal}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(onReveal).toHaveBeenCalledOnce();
    await waitFor(() => expect(requestPreview).toHaveBeenCalledWith("contact"));
  });

  it("omits standalone card chrome when rendered headless", () => {
    const { container } = render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        headless
      />,
    );

    const preview = container.querySelector(".page-preview-editor--headless");
    expect(preview).toBeInTheDocument();
    expect(preview).not.toHaveClass("page-preview-editor");
  });

  it("requires the current page to be saved before requesting a build", () => {
    const requestPreview = vi.fn();
    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: "Build preview" });
    expect(button).toBeDisabled();
    expect(
      screen.getByText(/Save or discard this page’s changes/),
    ).toBeInTheDocument();
    fireEvent.click(button);
    expect(requestPreview).not.toHaveBeenCalled();
  });

  it("offers the save-or-discard gate before a preview of unsaved work (#1042)", async () => {
    const saveChanges = vi.fn().mockResolvedValue(true);
    const discardChanges = vi.fn();
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={vi.fn()}
        saveChanges={saveChanges}
        discardChanges={discardChanges}
      />,
    );

    // The bare disabled build control is replaced by the two decisions a person can actually act
    // on, so the gate is a choice rather than a locked button with an explanation beside it.
    expect(
      screen.queryByRole("button", { name: "Build preview" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Save and preview" }),
    );

    await waitFor(() => expect(saveChanges).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestPreview).toHaveBeenCalledWith("contact"));
    expect(discardChanges).not.toHaveBeenCalled();
  });

  it("does not build a preview when the save it offered did not land (#1042)", async () => {
    const saveChanges = vi.fn().mockResolvedValue(false);
    const requestPreview = vi.fn();
    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={vi.fn()}
        saveChanges={saveChanges}
        discardChanges={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Save and preview" }),
    );

    await waitFor(() => expect(saveChanges).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/changes were not saved, so no preview was built/),
    ).toBeInTheDocument();
    expect(requestPreview).not.toHaveBeenCalled();
  });

  it("confirms before it discards unsaved work for a preview (#1042)", async () => {
    const discardChanges = vi.fn();
    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty
        saving={false}
        requestPreview={vi.fn()}
        loadPreviewStatus={vi.fn()}
        saveChanges={vi.fn()}
        discardChanges={discardChanges}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(discardChanges).not.toHaveBeenCalled();
    expect(
      screen.getByText("Discard your unsaved changes?"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(discardChanges).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Discard your unsaved changes?"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Discard unsaved changes" }),
    );
    expect(discardChanges).toHaveBeenCalledTimes(1);
  });

  it("holds the gate while a save is already in flight (#1042)", () => {
    const saveChanges = vi.fn();
    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty
        saving
        requestPreview={vi.fn()}
        loadPreviewStatus={vi.fn()}
        saveChanges={saveChanges}
        discardChanges={vi.fn()}
      />,
    );

    const discard = screen.getByRole("button", { name: "Discard changes" });
    expect(discard).toBeDisabled();
    expect(
      screen.getByText("Wait for the current save to finish."),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Save and preview" }),
    );
    expect(saveChanges).not.toHaveBeenCalled();
  });

  it("states honestly when the protected preview service is not configured", () => {
    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Build preview" })).toBeDisabled();
    expect(screen.getByText(/not configured in this environment/)).toBeInTheDocument();
  });

  it.each([
    ["GitHub artifact", "queue123", "https://abc123.njpbs-preview.pages.dev", "https://abc123.njpbs-preview.pages.dev/contact/"],
    ["private artifact", "11111111111111111111", "https://preview.njpbs.org/p/11111111111111111111/", "https://preview.njpbs.org/p/11111111111111111111/contact/"],
  ])("polls the immutable %s and opens the real route without an embedded copy", async (_name, queueId, previewUrl, expectedUrl) => {
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId,
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    const loadPreviewStatus = vi
      .fn()
      .mockResolvedValueOnce(status({ queueId }))
      .mockResolvedValue(
        status({
          status: "ready",
          queueId,
          previewUrl,
          completedAt: "2026-07-23T12:01:00.000Z",
        }),
      );
    let resolveCopy: () => void = () => {};
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { container } = render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));

    await waitFor(() => expect(requestPreview).toHaveBeenCalledWith("contact"));
    const buildingStatus = await screen.findByText(/Building saved version 7/);
    expect(buildingStatus).toBeInTheDocument();
    expect(buildingStatus.parentElement).toBe(
      screen.getByRole("button", { name: /^.+: Building preview…$/ }).parentElement,
    );
    const open = await screen.findByRole("link", { name: "Open in new tab" });
    expect(open).toHaveAttribute(
      "href",
      expectedUrl,
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(
      screen.queryByRole("group", { name: "Preview viewport" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    const copying = screen.getByRole("button", { name: /^.+: Copying link…$/ });
    expect(copying).toHaveAttribute("aria-busy", "true");
    expect(copying.querySelector(".activity-indicator")).toBeInTheDocument();
    expect(screen.getByText("Copying preview link.")).toHaveAttribute(
      "role",
      "status",
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expectedUrl,
      ),
    );
    await act(async () => resolveCopy());
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByText("Preview link copied.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(open).toHaveAttribute(
      "href",
      expectedUrl,
    );
  });

  it.each([
    "https://preview.njpbs.org/p/22222222222222222222/",
    "https://preview.njpbs.org/",
    "https://preview.njpbs.org/p/11111111111111111111/?other=1",
    "https://user:password@preview.njpbs.org/p/11111111111111111111/",
    "https://example.com/p/11111111111111111111/",
  ])("refuses an invalid or cross-queue reviewer URL: %s", async previewUrl => {
    const queueId = "11111111111111111111";
    render(<PagePreview pageId="contact" pagePath="/contact/" dirty={false} saving={false}
      requestPreview={async () => ({ success: true, queueId, pageId: "contact", sourceVersion: 7, dispatched: true, status: "building" })}
      loadPreviewStatus={async () => status({ queueId, status: "ready", previewUrl })} />);
    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));
    expect(await screen.findByText("The preview service returned an invalid reviewer URL.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open in new tab" })).toBeNull();
  });

  it("opens the built saved revision in a full browser tab (#1042)", async () => {
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    const loadPreviewStatus = vi.fn().mockResolvedValue(
      status({
        status: "ready",
        previewUrl: "https://abc123.njpbs-preview.pages.dev",
      }),
    );
    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));

    const open = await screen.findByRole("link", { name: "Open in new tab" });
    expect(open).toHaveAttribute(
      "href",
      "https://abc123.njpbs-preview.pages.dev/contact/",
    );
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noreferrer");
    // A person who cannot see the link's placement still hears what activating it does, and that
    // a second activation is a second tab rather than a silent reuse of the first.
    const described = open.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    const description = document.getElementById(described!);
    expect(description?.textContent).toContain(
      "Opens saved version 7 of this page in a new browser tab",
    );
    expect(description?.textContent).toContain("a separate tab");
    // The full tab is the preferred way to review, so it leads the actions rather than trailing
    // the in-panel conveniences.
    const actions = open.closest(".page-preview-link-actions");
    expect(actions?.firstElementChild).toBe(open);
  });

  it("clears a ready preview when the editor moves to another page", async () => {
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    const loadPreviewStatus = vi.fn().mockResolvedValue(
      status({
        status: "ready",
        previewUrl: "https://abc123.njpbs-preview.pages.dev",
      }),
    );
    const { rerender } = render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));
    expect(
      await screen.findByRole("link", { name: "Open in new tab" }),
    ).toBeInTheDocument();

    rerender(
      <PagePreview
        pageId="schedule"
        pagePath="/schedule/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Open in new tab" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Build preview" }),
    ).toBeEnabled();
  });

  it("ignores a preview request that settles after moving to another page", async () => {
    let resolveRequest:
      | ((value: PreviewRequestResponse) => void)
      | undefined;
    const pendingRequest = new Promise<PreviewRequestResponse>((resolve) => {
      resolveRequest = resolve;
    });
    const requestPreview = vi.fn().mockReturnValue(pendingRequest);
    const loadPreviewStatus = vi.fn();
    const { rerender } = render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
      />,
    );

    const buildPreview = screen.getByRole("button", { name: "Build preview" });
    const reservedLabels = () =>
      Array.from(
        buildPreview.querySelectorAll(".async-action-idle-reserve"),
        (label) => label.textContent,
      );
    expect(reservedLabels()).toEqual([
      "Build a new preview",
    ]);

    fireEvent.click(buildPreview);
    const requesting = screen.getByRole("button", {
      name: /^.+: Requesting preview…$/,
    });
    expect(reservedLabels()).toEqual([
      "Build a new preview",
    ]);
    expect(requesting).not.toBeDisabled();
    expect(requesting).toHaveAttribute("aria-disabled", "true");
    expect(requesting).toHaveAttribute("aria-busy", "true");
    expect(requesting.querySelector(".activity-indicator")).toBeInTheDocument();
    expect(screen.getByText("Requesting preview.")).toHaveAttribute(
      "role",
      "status",
    );

    rerender(
      <PagePreview
        pageId="schedule"
        pagePath="/schedule/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
      />,
    );
    resolveRequest?.({
      success: true,
      queueId: "old-contact-queue",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Build preview" }),
      ).toBeEnabled(),
    );
    expect(loadPreviewStatus).not.toHaveBeenCalled();
    expect(screen.queryByText(/did not match this page/)).not.toBeInTheDocument();
  });

  it("retires a ready preview after the same page is saved again", async () => {
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    const loadPreviewStatus = vi.fn().mockResolvedValue(
      status({
        status: "ready",
        previewUrl: "https://abc123.njpbs-preview.pages.dev",
      }),
    );
    const { rerender } = render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        savedVersion={7}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));
    expect(
      await screen.findByRole("link", { name: "Open in new tab" }),
    ).toBeInTheDocument();

    rerender(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        savedVersion={8}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Open in new tab" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Build preview" }),
    ).toBeEnabled();
  });

  it("retires an accepted build once a later save moves past the version it captured (#1042)", async () => {
    // An accepted request has a fixed source version: the service already snapshotted the page.
    // If the editor saves again through Update while that build runs, finishing it would present
    // a link labelled ready under a page that has since moved on. Retire it and offer a build of
    // what is stored now.
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    let releaseStatus: (value: PreviewStatusResponse) => void = () => {};
    const loadPreviewStatus = vi.fn(
      () =>
        new Promise<PreviewStatusResponse>((resolve) => {
          releaseStatus = resolve;
        }),
    );
    const props = {
      pageId: "contact" as const,
      pagePath: "/contact/",
      dirty: false,
      saving: false,
      requestPreview,
      loadPreviewStatus,
      pollIntervalMs: 1,
    };
    const { rerender } = render(<PagePreview {...props} savedVersion={7} />);

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));
    expect(await screen.findByText(/Building saved version 7/)).toBeInTheDocument();

    // Someone saves the page again while that build is still running.
    rerender(<PagePreview {...props} savedVersion={8} />);

    await waitFor(() =>
      expect(screen.queryByText(/Building saved version 7/)).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Build preview" }),
    ).toBeEnabled();
    // Even a late ready answer for the retired request cannot put its link on screen.
    await act(async () =>
      releaseStatus(
        status({
          status: "ready",
          sourceVersion: 7,
          previewUrl: "https://abc123.njpbs-preview.pages.dev",
        }),
      ),
    );
    expect(
      screen.queryByRole("link", { name: "Open in new tab" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a build in flight when the save that started it advances the revision (#1042)", async () => {
    // The gate saves and then builds, so the new saved revision reaches this panel moments after
    // the build starts. Retiring the build there would cancel exactly what the person asked for.
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 8,
      dispatched: true,
      status: "building",
    });
    const loadPreviewStatus = vi.fn().mockResolvedValue(
      status({
        status: "ready",
        sourceVersion: 8,
        previewUrl: "https://abc123.njpbs-preview.pages.dev",
      }),
    );
    const props = {
      pageId: "contact" as const,
      pagePath: "/contact/",
      dirty: false,
      saving: false,
      requestPreview,
      loadPreviewStatus,
      pollIntervalMs: 1,
    };
    const { rerender } = render(<PagePreview {...props} savedVersion={7} />);

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));
    await waitFor(() => expect(requestPreview).toHaveBeenCalledTimes(1));
    rerender(<PagePreview {...props} savedVersion={8} />);

    expect(
      await screen.findByRole("link", { name: "Open in new tab" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open in new tab" }),
    ).toBeInTheDocument();
    expect(requestPreview).toHaveBeenCalledTimes(1);
  });

  it("retires a ready link when its server expiry time arrives", async () => {
    vi.useFakeTimers();
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    const loadPreviewStatus = vi.fn().mockResolvedValue(
      status({
        status: "ready",
        previewUrl: "https://abc123.njpbs-preview.pages.dev",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(
      screen.getByRole("link", { name: "Open in new tab" }),
    ).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText("This preview is no longer listed")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open in new tab" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
  });

  it("surfaces a terminal workflow failure and offers a new build", async () => {
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    const loadPreviewStatus = vi.fn().mockResolvedValue(
      status({
        status: "failed",
        error: "Preview build failed - see GitHub Actions logs",
      }),
    );
    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));

    expect(
      await screen.findByText("Preview build failed - see GitHub Actions logs"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Build a new preview" }),
    ).toBeEnabled();
  });

  it("keeps polling the same request after a temporary status failure", async () => {
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    let resolveReady: ((value: PreviewStatusResponse) => void) | undefined;
    const ready = new Promise<PreviewStatusResponse>((resolve) => {
      resolveReady = resolve;
    });
    const loadPreviewStatus = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Status service timed out"))
      .mockReturnValueOnce(ready);

    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));

    expect(
      await screen.findByText(/Status service timed out/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Checking again automatically/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^.+: Building preview…$/ }),
    ).toHaveAttribute("aria-disabled", "true");

    resolveReady?.(
      status({
        status: "ready",
        previewUrl: "https://abc123.njpbs-preview.pages.dev",
      }),
    );

    expect(
      await screen.findByRole("link", { name: "Open in new tab" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Status service timed out/),
    ).not.toBeInTheDocument();
    expect(loadPreviewStatus).toHaveBeenCalledTimes(2);
  });

  it("stops polling and offers a new build after a terminal status failure", async () => {
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    const loadPreviewStatus = vi.fn().mockRejectedValue(
      Object.assign(new Error("Preview request not found"), { status: 404 }),
    );

    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));

    expect(
      await screen.findByText("Preview request not found"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Build a new preview" }),
    ).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loadPreviewStatus).toHaveBeenCalledOnce();
  });

  it("does not retry a status-less application error", async () => {
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    const loadPreviewStatus = vi
      .fn()
      .mockRejectedValue(new Error("Functions base URL is not configured"));

    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));

    expect(
      await screen.findByText("Functions base URL is not configured"),
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loadPreviewStatus).toHaveBeenCalledOnce();
  });

  it("stops retrying after repeated temporary status failures", async () => {
    const requestPreview = vi.fn().mockResolvedValue({
      success: true,
      queueId: "queue123",
      pageId: "contact",
      sourceVersion: 7,
      dispatched: true,
      status: "building",
    });
    const loadPreviewStatus = vi.fn().mockRejectedValue(
      Object.assign(new Error("Preview status service unavailable"), {
        status: 503,
      }),
    );

    render(
      <PagePreview
        pageId="contact"
        pagePath="/contact/"
        dirty={false}
        saving={false}
        requestPreview={requestPreview}
        loadPreviewStatus={loadPreviewStatus}
        pollIntervalMs={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));

    expect(
      await screen.findByText("Preview status service unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Build a new preview" }),
    ).toBeEnabled();
    expect(loadPreviewStatus).toHaveBeenCalledTimes(3);
  });
});
