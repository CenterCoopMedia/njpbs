import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { LifecycleActionsPanel } from "../src/components/LifecycleActionsPanel";
import { WorkspaceActionsProvider } from "../src/components/WorkspaceActions";
import { HttpError, type TransitionContentRequest, type TransitionContentResponse } from "../src/lib/functions";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";

describe("LifecycleActionsPanel", () => {
  it("preserves other record kinds' workflow status and revision facts", () => {
    render(<LifecycleActionsPanel collection="cmsPosts" documentId="program-1"
      unifiedStatus={false} recordTitle="Garden State" status="published"
      baseVersion={12} liveSourceVersion={8} publicationSupported
      canArchive canUnpublish canRestore onTransition={vi.fn()} />);
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.getByText("Version 12").closest("dd")).toHaveTextContent("Version 12 · Published");
    expect(screen.getByText("Public site")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Draft status for/ })).not.toBeInTheDocument();
  });
  afterEach(() => vi.restoreAllMocks());
  it("keeps a polite publication region mounted before its first failure message", () => {
    const props = { baseVersion: 12, collection: "cmsPosts" as const, documentId: "post-1",
      status: "draft", canPublish: true, canArchive: true, canUnpublish: true, canRestore: true,
      publicationSupported: true, onTransition: vi.fn() };
    const view = render(<LifecycleActionsPanel {...props} />);
    const region = view.container.querySelector('.lifecycle-publication-details[aria-live="polite"]');
    expect(region).toBeEmptyDOMElement();
    view.rerender(<LifecycleActionsPanel {...props} liveSourceVersion={8} publicUpdatePending />);
    expect(screen.getByText("The public update has not started. Retry publication.")
      .closest('[aria-live="polite"]')).toBe(region);
    view.rerender(<LifecycleActionsPanel {...props} />);
    expect(view.container.querySelector('.lifecycle-publication-details')).toBe(region);
    expect(region).toBeEmptyDOMElement();
  });
  it("holds publication for an approved routed page while keeping edit available and the correct route copy", () => {
    render(<LifecycleActionsPanel baseVersion={7} collection="cmsPages" documentId="home" status="approved"
      canEdit canPublish canSchedule canArchive canRestore canUnpublish publicationSupported
      publicationDisabledReason="Version 2 Home publication is not enabled yet."
      onTransition={vi.fn()} onPublish={vi.fn()} onSchedule={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Schedule publish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.getByText("Version 2 Home publication is not enabled yet.")).toBeVisible();
    expect(screen.queryByText(/until it has a public route/)).toBeNull();
  });
  it("keeps the accepted queue notice through the editor's snapshot reload", async () => {
    function Editor() {
      const [reloading, setReloading] = useState(false);
      return <SuccessNoticeProvider routeKey="post-1">
        {reloading ? <p>Reloading the saved snapshot</p> : <LifecycleActionsPanel
          baseVersion={44} collection="cmsPosts" documentId="post-1" status="approved"
          canPublish canArchive canRestore canUnpublish publicationSupported
          onPublish={async () => ({ document: { id: "post-1", version: 45 }, buildQueued: true })}
          onChanged={() => setReloading(true)} />}
      </SuccessNoticeProvider>;
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Reloading the saved snapshot")).toBeVisible();
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent(
      "Publication requested. The saved version is queued for a public build.",
    );
  });

  it.each([
    ["post-no-build-v1", "The public site has not confirmed this version yet; no public build is needed."],
    ["public-context-no-build-v1", "The public site has not confirmed this version yet; no public build is needed."],
    ["release-pair-publication-v2", "The public site has not confirmed this version yet; no public build is needed."],
    ["serializer", "The saved version is queued for a public build."],
  ] as const)("reports pending %s publication truthfully", async (transport, message) => {
    render(<LifecycleActionsPanel
      baseVersion={6} collection="cmsPosts" documentId="post-1" status="approved"
      canPublish canArchive canRestore canUnpublish publicationSupported
      onPublish={async () => ({ document: { id: "post-1", version: 7 }, transport })} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText(`Publication requested. ${message}`)).toBeVisible();
  });

  it("keeps the removal receipt through the editor's snapshot reload", async () => {
    function Editor() {
      const [reloading, setReloading] = useState(false);
      return <SuccessNoticeProvider routeKey="post-1">
        {reloading ? <p>Reloading the saved snapshot</p> : <LifecycleActionsPanel
          baseVersion={44} collection="cmsPosts" documentId="post-1" status="published"
          canUnpublish publicationSupported canArchive={false} canRestore={false}
          onTransition={async (request) => ({
            success: true, ...request, fromStatus: "published", toStatus: "draft", version: 45,
            document: { id: "post-1", version: 45, status: "draft" },
            publication: { status: "queued", queueId: "removal-one" },
          })}
          onChanged={() => setReloading(true)} />}
      </SuccessNoticeProvider>;
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unpublish" }));
    expect(await screen.findByText("Reloading the saved snapshot")).toBeVisible();
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent(
      "Removal saved. The public update is queued; the current public version remains visible until removal is confirmed.",
    );
  });

  it("keeps the affected Home section warning through withdrawal and snapshot reload", async () => {
    function Editor() {
      const [reloading, setReloading] = useState(false);
      return <SuccessNoticeProvider routeKey="placed-post">
        {reloading ? <p>Reloading the saved snapshot</p> : <LifecycleActionsPanel
          baseVersion={3} collection="cmsPosts" documentId="placed-post" status="published"
          canUnpublish publicationSupported canArchive={false} canRestore={false}
          onTransition={async request => ({
            success: true, ...request, fromStatus: "published", toStatus: "draft", version: 4,
            document: { id: "placed-post", version: 4, status: "draft" },
            publication: { status: "queued", queueId: "placed-removal", warnings: [
              "Home will lose a card in: Station reports. Review those sections.",
            ] },
          })}
          onChanged={() => setReloading(true)} />}
      </SuccessNoticeProvider>;
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unpublish" }));
    expect(await screen.findByText("Reloading the saved snapshot")).toBeVisible();
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent(
      "Home will lose a card in: Station reports. Review those sections.",
    );
  });

  it("keeps a failed removal enqueue visible after the saved snapshot reload and notice timeout", async () => {
    vi.useFakeTimers();
    try {
      function Editor() {
        const [reloading, setReloading] = useState(false);
        return <SuccessNoticeProvider routeKey="post-1">
          {reloading ? <p>Reloading the saved snapshot</p> : <LifecycleActionsPanel
            baseVersion={44} collection="cmsPosts" documentId="post-1" status="published"
            canUnpublish publicationSupported canArchive={false} canRestore={false}
            onTransition={async (request) => ({
              success: true, ...request, fromStatus: "published", toStatus: "draft", version: 45,
              document: { id: "post-1", version: 45, status: "draft", publishBuildPending: true, publishBuildQueueId: null },
              publication: { status: "failed", queueId: null },
            })}
            onChanged={() => setReloading(true)} />}
        </SuccessNoticeProvider>;
      }
      render(<Editor />);
      fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm unpublish" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText("Reloading the saved snapshot")).toBeVisible();
      await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
      const notice = screen.getByRole("region", { name: "Notifications" });
      expect(notice.querySelector(".success-notice")).toHaveAttribute("data-tone", "error");
      expect(notice).toHaveTextContent(
        "Removal saved, but the public update did not start. Use Retry removal. Your working copy is unchanged.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reminds staff about published images with no alt text", async () => {
    function Editor() {
      const [reloading, setReloading] = useState(false);
      return <SuccessNoticeProvider routeKey="post-2">
        {reloading ? <p>Reloading the saved snapshot</p> : <LifecycleActionsPanel
          baseVersion={44} collection="cmsPosts" documentId="post-2" status="approved"
          canPublish canArchive canRestore canUnpublish publicationSupported
          onPublish={async () => ({
            document: {
              id: "post-2",
              version: 45,
              heroImage: "asset-lead",
              heroImageAlt: "",
              blocks: [
                { id: "b1", type: "image", visible: true, data: { assetId: "asset-1", alt: "" } },
                { id: "b2", type: "image", visible: false, data: { assetId: "asset-2", alt: "" } },
                { id: "b3", type: "image", visible: true, data: { assetId: "asset-3", alt: "", altDecorative: true } },
              ],
            },
            buildQueued: true,
          })}
          onChanged={() => setReloading(true)} />}
      </SuccessNoticeProvider>;
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Reloading the saved snapshot")).toBeVisible();
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent(
      "Publication requested. The saved version is queued for a public build. 2 images have no alt text. Add it when you can, or mark the image decorative.",
    );
  });

  it("counts only published manual Home hero slides with no description in the reminder", async () => {
    function Editor() {
      const [reloading, setReloading] = useState(false);
      return <SuccessNoticeProvider routeKey="home">
        {reloading ? <p>Reloading the saved snapshot</p> : <LifecycleActionsPanel
          baseVersion={9} collection="cmsPages" documentId="home" status="approved"
          canPublish canArchive canRestore canUnpublish publicationSupported
          onPublish={async () => ({
            document: {
              id: "home",
              version: 10,
              homeHero: {
                mode: "manual",
                limit: 3,
                items: [
                  { itemId: "s1", title: "One", href: "/one/", imageAssetId: "hero-1", alt: "" },
                  { itemId: "s2", title: "Two", href: "/two/", imageAssetId: "hero-2", alt: "", altDecorative: true },
                  { itemId: "s3", title: "Three", href: "/three/", imageAssetId: "hero-3", alt: "A host" },
                  { itemId: "s4", title: "Four", href: "/four/", imageAssetId: "hero-4", alt: "" },
                ],
              },
              blocks: [],
            },
            buildQueued: true,
          })}
          onChanged={() => setReloading(true)} />}
      </SuccessNoticeProvider>;
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Reloading the saved snapshot")).toBeVisible();
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent(
      "1 image has no alt text. Add it when you can, or mark the image decorative.",
    );
  });

  it.each([
    ["no lead", null],
    ["a described image", { kind: "image", data: { assetId: "new-image", alt: "County meeting" } }],
    ["a decorative image", { kind: "image", data: { assetId: "new-image", alt: "", altDecorative: true } }],
    ["a library video", { kind: "library-video", data: { sourceId: "video-library", assetId: "video-1", title: "County meeting" } }],
    ["a linked video", { kind: "linked-video", data: { url: "https://example.com/meeting", title: "County meeting" } }],
    ["an embed", { kind: "embed", data: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "County meeting" } }],
    ["an invalid optional lead", { kind: "unknown", data: {} }],
  ])("ignores the inactive legacy lead alt reminder after selecting %s", async (_label, leadMedia) => {
    function Editor() {
      const [reloading, setReloading] = useState(false);
      return <SuccessNoticeProvider routeKey="replaced-lead">
        {reloading ? <p>Reloading the saved snapshot</p> : <LifecycleActionsPanel
          baseVersion={44} collection="cmsPosts" documentId="replaced-lead" status="approved"
          canPublish canArchive canRestore canUnpublish publicationSupported
          onPublish={async () => ({ document: {
            id: "replaced-lead", version: 45, heroImage: "old-image", heroImageAlt: "",
            leadMedia, blocks: [],
          }, buildQueued: true })}
          onChanged={() => setReloading(true)} />}
      </SuccessNoticeProvider>;
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Reloading the saved snapshot")).toBeVisible();
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent(
      "Publication requested. The saved version is queued for a public build.",
    );
    expect(screen.getByRole("region", { name: "Notifications" })).not.toHaveTextContent("no alt text");
  });

  it.each(["media_publication_unavailable", "network"])("keeps %s publication errors beside the toolbar outside hidden settings", async (code) => {
    const actions = document.createElement("div");
    const feedback = document.createElement("div");
    document.body.append(actions, feedback);
    const reload = vi.fn();
    let reject: (error: Error) => void = () => {};
    const publish = vi.fn(() => new Promise<never>((_resolve, rejectRequest) => { reject = rejectRequest; }));
    const view = render(
      <WorkspaceActionsProvider target={actions} feedbackTarget={feedback}>
        <div hidden>
          <LifecycleActionsPanel baseVersion={44} collection="cmsPosts" documentId="post-1"
            status="approved" canEdit canPublish canArchive canRestore canUnpublish
            publicationSupported workspaceActions onTransition={vi.fn()}
            onPublish={publish} onReload={reload} />
        </div>
      </WorkspaceActionsProvider>,
    );
    try {
      const announcement = feedback.querySelector('.lifecycle-publication-progress[aria-live="polite"]');
      expect(announcement).toBeEmptyDOMElement();
      fireEvent.click(within(actions).getByRole("button", { name: "Publish" }));
      expect(within(feedback).getByText("Requesting publication")).toBeVisible();
      expect(within(feedback).getByText("Requesting publication").closest('[aria-live="polite"]'))
        .toBe(announcement);
      expect(within(actions).getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-busy", "true");
      fireEvent.click(within(actions).getByRole("button", { name: /^.+: Publishing…$/ }));
      expect(publish).toHaveBeenCalledOnce();
      await act(async () => reject(code === "network" ? new Error("Connection lost. Check publication status.")
        : new HttpError(409, "Image publication is paused.", { code })));
      expect(within(feedback).getByRole("alert")).toBeVisible();
      expect(within(feedback).getByRole("alert").closest('[aria-live="polite"]')).toBeNull();
      expect(within(feedback).getByRole("alert")).toHaveTextContent("Publication did not start");
      expect(reload).not.toHaveBeenCalled();
      expect(within(actions).getByRole("button", { name: "Publish" })).toBeEnabled();
    } finally {
      view.unmount();
      actions.remove();
      feedback.remove();
    }
  });

  it("announces a pending lifecycle action and prevents duplicate submission", async () => {
    let resolveTransition: (value: {
      success: true;
      collection: "cmsPosts";
      id: string;
      action: "submit";
      fromStatus: "draft";
      toStatus: "in_review";
      version: number;
      document: Record<string, unknown>;
    }) => void = () => {};
    const transition = vi.fn(
      () =>
        new Promise<{
          success: true;
          collection: "cmsPosts";
          id: string;
          action: "submit";
          fromStatus: "draft";
          toStatus: "in_review";
          version: number;
          document: Record<string, unknown>;
        }>((resolve) => {
          resolveTransition = resolve;
        }),
    );
    render(
      <LifecycleActionsPanel
        baseVersion={5}
        canArchive={false}
        canEdit
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="post-1"
        onTransition={transition}
        publicationSupported
        status="draft"
      />,
    );

    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm submission" }));

    const pending = screen.getByRole("button", { name: /^.+: Applying action…$/ });
    expect(pending).not.toBeDisabled();
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending.querySelector(".activity-indicator")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Applying lifecycle action.",
    );
    fireEvent.click(pending);
    expect(transition).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveTransition({
        success: true,
        collection: "cmsPosts",
        id: "post-1",
        action: "submit",
        fromStatus: "draft",
        toStatus: "in_review",
        version: 6,
        document: { id: "post-1", status: "in_review", version: 6 },
      });
    });
    expect(
      (await screen.findByText("Content submitted for review")).closest(
        '[role="status"]',
      ),
    ).toHaveTextContent("Content submitted for review");
  });

  it("locks confirmation fields while a lifecycle action is pending", () => {
    const transition = vi.fn(
      () => new Promise<TransitionContentResponse>(() => {}),
    );
    render(
      <LifecycleActionsPanel
        baseVersion={5}
        canArchive={false}
        canApprove
        canEdit
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="post-1"
        onTransition={transition}
        publicationSupported
        status="in_review"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    const note = screen.getByLabelText("Review note");
    fireEvent.change(note, { target: { value: "Add a second source." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm send back" }));

    expect(note).toBeDisabled();
    expect(screen.getByRole("button", { name: /^.+: Applying action…$/ }))
      .not.toBeDisabled();
  });

  it("moves draft content through review and approval with a required send-back note", async () => {
    const transition = vi.fn(async (request) => ({
      success: true as const,
      ...request,
      fromStatus: "in_review" as const,
      toStatus: "draft" as const,
      version: 6,
      document: { id: request.id, status: "draft", version: 6 },
    }));
    const props = {
      baseVersion: 5,
      canArchive: true,
      canApprove: true,
      canEdit: true,
      canRestore: true,
      canUnpublish: true,
      collection: "cmsPosts" as const,
      documentId: "post-1",
      onTransition: transition,
      publicationSupported: true,
    };
    const { rerender } = render(
      <LifecycleActionsPanel {...props} status="draft" />,
    );

    expect(screen.getByRole("button", { name: "Submit for review" })).toBeEnabled();
    rerender(<LifecycleActionsPanel {...props} status="in_review" />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    expect(screen.getByRole("button", { name: "Confirm send back" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Review note"), {
      target: { value: "Add a second source." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm send back" }));

    await waitFor(() => expect(transition).toHaveBeenCalledWith({
      collection: "cmsPosts",
      id: "post-1",
      action: "sendBack",
      baseVersion: 5,
      comment: "Add a second source.",
    }));
  });

  it("offers Edit for approved content", () => {
    render(
      <LifecycleActionsPanel
        baseVersion={6}
        canArchive
        canApprove
        canEdit
        canRestore
        canUnpublish
        collection="cmsPages"
        documentId="watch"
        onTransition={vi.fn()}
        publicationSupported
        status="approved"
      />,
    );

    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
  });

  it.each([
    ["draft", "Draft"],
    ["in_review", "In review"],
    ["approved", "Approved"],
  ])(
    "reports the %s revision without a duplicate workflow status",
    (status, statusLabel) => {
      render(
        <LifecycleActionsPanel
          baseVersion={44}
          canApprove
          canArchive
          canEdit
          canPublish
          canRestore
          canUnpublish
          collection="cmsPosts"
          contentVersion={12}
          documentId="post-1"
          liveSourceVersion={8}
          onPublish={vi.fn()}
          onSchedule={vi.fn()}
          onTransition={vi.fn()}
          publicationSupported
          status={status}
        />,
      );

      const facts = screen.getByText("Working version").closest("dl");
      if (!facts) throw new Error("Expected lifecycle version facts.");
      expect(within(facts).getByText("Version 12"))
        .toBeInTheDocument();
      expect(screen.getByText(statusLabel)).toBeInTheDocument();
      expect(screen.getByText(statusLabel).closest('[aria-live="polite"]')).not.toBeNull();
      expect(screen.getByText("A published copy was last recorded"))
        .toBeInTheDocument();
      expect(screen.getByText("A published copy was last recorded").closest('[aria-live="polite"]'))
        .not.toBeNull();
      expect(screen.getByText("Working version 12"))
        .toBeInTheDocument();
    },
  );

  it("makes publication the clear next action after approval", () => {
    render(
      <LifecycleActionsPanel
        baseVersion={12}
        canApprove
        canArchive
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="post-1"
        liveSourceVersion={8}
        onPublish={vi.fn()}
        onSchedule={vi.fn()}
        onTransition={vi.fn()}
        publicationSupported
        status="approved"
      />,
    );

    const guidance = screen.getByText("Approval does not publish").closest(
      ".inline-message",
    );
    expect(guidance).toHaveTextContent(
      "Select Publish to replace the current public snapshot with the approved working revision.",
    );
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
  });

  it("checks the publication status while the queue state is unknown", () => {
    render(
      <LifecycleActionsPanel
        baseVersion={12}
        canApprove
        canArchive
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="post-1"
        liveSourceVersion={8}
        onPublish={vi.fn()}
        onSchedule={vi.fn()}
        onTransition={vi.fn()}
        publicUpdatePending
        publicBuildQueueId="queue-1"
        pendingSourceVersion={10}
        publicationSupported
        status="published"
      />,
    );

    expect(screen.getByText("A published copy was last recorded")).toBeInTheDocument();
    expect(screen.getByText("Checking publication status.")).toBeInTheDocument();
  });

  it.each([
    {
      name: "reviewer",
      canApprove: true,
      canPublish: false,
    },
    {
      name: "publisher",
      canApprove: false,
      canPublish: true,
    },
  ])("keeps approved actions within $name authority", ({
    canApprove,
    canPublish,
  }) => {
    render(
      <LifecycleActionsPanel
        baseVersion={12}
        canApprove={canApprove}
        canArchive={false}
        canEdit
        canPublish={canPublish}
        canRestore={false}
        canSchedule
        canUnpublish={false}
        collection="cmsPosts"
        documentId="post-1"
        liveSourceVersion={8}
        onPublish={vi.fn()}
        onSchedule={vi.fn()}
        onTransition={vi.fn()}
        publicationSupported
        status="approved"
      />,
    );

    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    if (canPublish) {
      expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Schedule publish" })).toBeEnabled();
    } else {
      expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Schedule publish" })).not.toBeInTheDocument();
    }
  });

  it("states that approval itself does not publish", () => {
    render(
      <LifecycleActionsPanel
        baseVersion={12}
        canApprove
        canArchive
        canEdit
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="post-1"
        liveSourceVersion={8}
        onTransition={vi.fn()}
        publicationSupported
        status="in_review"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText(/Approval does not publish it/)).toBeInTheDocument();
  });

  it.each(["draft", "approved"] as const)("shows a scheduled publication failure in %s and keeps recovery actions available", (status) => {
    // #2761: new failures return to draft; legacy approved failures still need recovery.
    render(
      <LifecycleActionsPanel
        baseVersion={7}
        canArchive
        canApprove
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPages"
        documentId="watch"
        onPublish={vi.fn()}
        onSchedule={vi.fn()}
        onTransition={vi.fn()}
        publicationSupported
        scheduledPublishFailure={{
          failedAt: "2026-08-13T18:30:00.000Z",
          failedBy: "system:scheduler",
          reason: "The lead image is not available.",
        }}
        status={status}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Scheduled publication failed",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The lead image is not available.",
    );
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Schedule publish" })).toBeEnabled();
    if (status === "approved") {
      expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    } else {
      expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    }
  });

  it("keeps delayed public confirmation as a successful publication", async () => {
    const publish = vi.fn(async () => ({
      document: { id: "contact", status: "published", version: 7 },
      publicReceipt: {
        collection: "cmsPages" as const,
        id: "contact",
        label: "Contact",
        status: "unconfirmed" as const,
        sourceVersion: 7,
      },
    }));
    const changed = vi.fn();
    render(
      <LifecycleActionsPanel
        baseVersion={6}
        canArchive
        canApprove
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPages"
        documentId="contact"
        onChanged={changed}
        onPublish={publish}
        onTransition={vi.fn()}
        publicationSupported
        status="approved"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(publish).toHaveBeenCalledWith(6, expect.any(Function)));
    expect(changed).toHaveBeenCalledWith({ id: "contact", status: "published", version: 7 });
    expect(screen.getByRole("status")).toHaveTextContent("Publication started");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Contact is not confirmed on the public site yet; check again shortly.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows deployment coordination failures as actionable errors, not edit conflicts", async () => {
    const reload = vi.fn();
    const publish = vi.fn(async () => {
      throw new HttpError(
        409,
        "This image cannot be published until public deployment coordination is active.",
        { code: "media_publication_unavailable" },
      );
    });
    render(
      <LifecycleActionsPanel
        baseVersion={6}
        canArchive
        canApprove
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="post-1"
        onPublish={publish}
        onReload={reload}
        onTransition={vi.fn()}
        publicationSupported
        status="approved"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This image cannot be published until public deployment coordination is active.",
    );
    expect(screen.queryByRole("button", { name: "Reload content" }))
      .not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("offers to reload when publication was saved before deployment coordination failed", async () => {
    const reload = vi.fn();
    const publish = vi.fn(async () => {
      throw new HttpError(
        409,
        "The version was saved as published, but its public build did not start.",
        {
          code: "media_publication_unavailable",
          publicationCommitted: true,
        },
      );
    });
    render(
      <LifecycleActionsPanel
        baseVersion={6}
        canArchive
        canApprove
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="post-1"
        onPublish={publish}
        onReload={reload}
        onTransition={vi.fn()}
        publicationSupported
        status="approved"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The version was saved as published, but its public build did not start.",
    );
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Reload published version" }),
    );
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reports exact runtime publication without claiming a queued build", async () => {
    const publish = vi.fn(async () => ({
      document: { id: "contact", status: "published", version: 7 },
      publicReceipt: {
        collection: "cmsPages" as const,
        id: "contact",
        label: "Contact",
        status: "confirmed" as const,
        sourceVersion: 7,
      },
    }));
    render(
      <LifecycleActionsPanel
        baseVersion={6}
        canArchive
        canApprove
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPages"
        documentId="contact"
        onPublish={publish}
        onTransition={vi.fn()}
        publicationSupported
        status="approved"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(publish).toHaveBeenCalledWith(6, expect.any(Function)));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Contact is confirmed on the public site; no public build was needed.",
    );
  });

  it("reports an exact runtime publication with an already queued build", async () => {
    const publish = vi.fn(async () => ({
      document: { id: "contact", status: "published", version: 7 },
      publicReceipt: {
        collection: "cmsPages" as const,
        id: "contact",
        label: "Contact",
        status: "confirmed" as const,
        sourceVersion: 7,
      },
      buildQueued: true,
    }));
    render(
      <LifecycleActionsPanel
        baseVersion={6}
        canArchive
        canApprove
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPages"
        documentId="contact"
        onPublish={publish}
        onTransition={vi.fn()}
        publicationSupported
        status="approved"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(publish).toHaveBeenCalledWith(6, expect.any(Function)));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Contact is confirmed on the public site; an existing site build is still queued.",
    );
  });

  it("schedules the exact approved version for a chosen New York time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-08-15T12:00:00Z"));
    const schedule = vi.fn(async () => ({
      document: { id: "watch", status: "scheduled", version: 7 },
    }));
    render(
      <LifecycleActionsPanel
        baseVersion={6}
        canArchive
        canApprove
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPages"
        documentId="watch"
        onPublish={vi.fn()}
        onSchedule={schedule}
        onTransition={vi.fn()}
        publicationSupported
        status="approved"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Schedule publish" }));
    expect(screen.getByText(/regardless of your device time zone/i))
      .toBeInTheDocument();
    const localTime = "2030-09-01T10:30";
    fireEvent.change(screen.getByLabelText("Publication time (New York)"), {
      target: { value: localTime },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm schedule" }));

    await waitFor(() => expect(schedule).toHaveBeenCalledWith(
      6,
      "2030-09-01T14:30:00.000Z",
      expect.any(Function),
    ));
    expect(screen.getByRole("status")).toHaveTextContent("Publication scheduled");
  });

  it("keeps immediate publication available when scheduling is not supported", () => {
    render(
      <LifecycleActionsPanel
        baseVersion={6}
        canArchive
        canApprove
        canEdit
        canPublish
        canRestore
        canSchedule={false}
        canUnpublish
        collection="cmsPosts"
        documentId="post-1"
        onPublish={vi.fn()}
        onTransition={vi.fn()}
        publicationSupported
        status="approved"
      />,
    );

    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Schedule publish" })).not.toBeInTheDocument();
  });

  it("keeps review actions for library-only records", () => {
    render(
      <LifecycleActionsPanel
        baseVersion={6}
        canArchive
        canApprove
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="program-1"
        onTransition={vi.fn()}
        publicationSupported={false}
        status="in_review"
      />,
    );

    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send back" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
  });

  it("explains library-only records without offering publication actions", () => {
    render(
      <LifecycleActionsPanel
        baseVersion={6}
        canArchive
        canApprove
        canEdit
        canPublish
        publicationSupported={false}
        canRestore
        canSchedule={false}
        canUnpublish
        collection="cmsPosts"
        documentId="program-1"
        onPublish={vi.fn()}
        onSchedule={vi.fn()}
        onTransition={vi.fn()}
        status="approved"
      />,
    );

    expect(screen.queryByRole("button", { name: "Schedule publish" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.getByText(/available under All content/i)).toBeInTheDocument();
  });

  it.each([
    ["scheduled", ["Edit", "Cancel scheduled publication", "Delete"]],
    ["published", ["Unpublish", "Delete"]],
  ] as const)("preserves recovery actions for library-only %s records", (status, labels) => {
    render(
      <LifecycleActionsPanel
        baseVersion={6}
        canArchive
        canApprove
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="program-1"
        onTransition={vi.fn()}
        publicationSupported={false}
        status={status}
      />,
    );

    for (const label of labels) {
      expect(screen.getByRole("button", { name: label })).toBeEnabled();
    }
  });

  it("opens scheduled content for editing on the first click", async () => {
    const transition = vi.fn(async () => ({
      success: true as const,
      collection: "cmsPages" as const,
      id: "watch",
      action: "edit" as const,
      fromStatus: "scheduled" as const,
      toStatus: "draft" as const,
      version: 5,
      document: { id: "watch", status: "draft", version: 5 },
    }));
    render(
      <LifecycleActionsPanel
        baseVersion={4}
        canArchive
        canApprove
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPages"
        documentId="watch"
        onTransition={transition}
        publicationSupported
        status="scheduled"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel scheduled publication" }));
    expect(
      screen.getByRole("button", { name: "Confirm cancellation" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith({
        collection: "cmsPages",
        id: "watch",
        action: "edit",
        baseVersion: 4,
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Confirm edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirm cancellation" }),
    ).not.toBeInTheDocument();
  });

  it("requires confirmation before unpublishing and adopts the returned version", async () => {
    const transition = vi.fn(async () => ({
      success: true as const,
      collection: "cmsPages" as const,
      id: "watch",
      action: "unpublish" as const,
      fromStatus: "published" as const,
      toStatus: "draft" as const,
      version: 5,
      document: { id: "watch", status: "draft", version: 5 },
    }));
    const changed = vi.fn();
    render(
      <LifecycleActionsPanel
        baseVersion={4}
        canArchive={false}
        canRestore={false}
        canUnpublish
        collection="cmsPages"
        documentId="watch"
        onChanged={changed}
        onTransition={transition}
        publicationSupported
        status="published"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    expect(transition).not.toHaveBeenCalled();
    expect(screen.getByText(/Request removal of the CMS version from the public site/i))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm unpublish" }));

    expect((await screen.findByText("Removal requested")).closest('[role="status"]'))
      .toHaveTextContent("Removal requested");
    expect(transition).toHaveBeenCalledWith({
      collection: "cmsPages",
      id: "watch",
      action: "unpublish",
      baseVersion: 4,
    });
    expect(changed).toHaveBeenCalledWith({ id: "watch", status: "draft", version: 5 });
  });

  it("omits Delete when an editor can unpublish but cannot delete", () => {
    render(
      <LifecycleActionsPanel
        baseVersion={4}
        canArchive={false}
        canRestore={false}
        canUnpublish
        collection="cmsPages"
        documentId="watch"
        onTransition={vi.fn()}
        publicationSupported
        status="published"
      />,
    );

    expect(screen.getByRole("button", { name: "Unpublish" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Unpublish:/)).toBeNull();
  });

  it("offers Delete for published content and restore for archived content", () => {
    const props = {
      baseVersion: 4,
      canArchive: true,
      canRestore: true,
      canUnpublish: true,
      collection: "cmsPosts" as const,
      documentId: "post-1",
      onTransition: vi.fn(),
      publicationSupported: true,
    };
    const { rerender } = render(
      <LifecycleActionsPanel {...props} status="published" />,
    );

    expect(screen.getByRole("button", { name: "Unpublish" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Restore to draft" }))
      .not.toBeInTheDocument();

    rerender(<LifecycleActionsPanel {...props} baseVersion={5} status="archived" />);

    expect(screen.getByRole("button", { name: "Restore to draft" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("offers Delete for every saved active state", () => {
    const props = {
      baseVersion: 4,
      canArchive: true,
      canEdit: true,
      canPublish: true,
      canRestore: true,
      canUnpublish: true,
      collection: "cmsPosts" as const,
      documentId: "post-1",
      onPublish: vi.fn(),
      onTransition: vi.fn(),
      publicationSupported: true,
    };
    const { rerender } = render(
      <LifecycleActionsPanel {...props} status="draft" />,
    );

    for (const status of ["draft", "in_review", "approved", "scheduled", "published"]) {
      rerender(<LifecycleActionsPanel {...props} status={status} />);
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    }
  });

  it.each(["draft", "published"] as const)("keeps connected %s Delete in overflow and confirms the archive transition", async status => {
    const actionsTarget = document.createElement("div");
    const secondaryTarget = document.createElement("div");
    document.body.append(actionsTarget, secondaryTarget);
    const transition = vi.fn(async () => ({
      success: true as const,
      collection: "cmsPosts" as const,
      id: "post-1",
      action: "archive" as const,
      fromStatus: status,
      toStatus: "archived" as const,
      version: 5,
      document: { id: "post-1", status: "archived", version: 5 },
    }));
    const view = render(
      <WorkspaceActionsProvider target={actionsTarget} secondaryTarget={secondaryTarget}>
        <LifecycleActionsPanel
          baseVersion={4}
          canArchive
          canEdit
          canPublish
          canRestore
          canUnpublish
          collection="cmsPosts"
          documentId="post-1"
          onPublish={vi.fn()}
          onTransition={transition}
          publicationSupported
          status={status}
          workspaceActions
        />
      </WorkspaceActionsProvider>,
    );

    try {
      const deleteButton = within(secondaryTarget).getByRole("button", { name: "Delete" });
      expect(deleteButton).toHaveClass("ui-menu-item-danger");
      expect(deleteButton).toBeEnabled();
      expect(within(actionsTarget).queryByRole("button", { name: "Delete" })).toBeNull();

      fireEvent.click(deleteButton);
      expect(screen.getByRole("group", { name: "Move to recycle bin" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Move to recycle bin" }));

      await waitFor(() => expect(transition).toHaveBeenCalledWith({
        collection: "cmsPosts",
        id: "post-1",
        action: "archive",
        baseVersion: 4,
      }));
    } finally {
      view.unmount();
      actionsTarget.remove();
      secondaryTarget.remove();
    }
  });

  it("keeps library-only overflow actions before help after a status change", () => {
    const actionsTarget = document.createElement("div");
    const secondaryTarget = document.createElement("div");
    document.body.append(actionsTarget, secondaryTarget);
    const panel = (status: string) => (
      <WorkspaceActionsProvider target={actionsTarget} secondaryTarget={secondaryTarget}>
        <LifecycleActionsPanel baseVersion={4} canApprove canEdit canPublish
          canArchive={false} canUnpublish={false} canRestore={false}
          collection="cmsPosts" documentId="sponsor-1" publicationSupported={false}
          status={status} workspaceActions onTransition={vi.fn()} />
      </WorkspaceActionsProvider>
    );
    const view = render(panel("draft"));
    try {
      expect(within(secondaryTarget).getAllByRole("button").map(button => button.textContent))
        .toEqual(["Submit for review", "Lifecycle help"]);
      view.rerender(panel("in_review"));
      expect(within(secondaryTarget).getAllByRole("button").map(button => button.textContent))
        .toEqual(["Approve", "Send back", "Lifecycle help"]);
      expect(secondaryTarget.firstElementChild).toBe(within(secondaryTarget).getByRole("button", { name: "Approve" }));
    } finally {
      view.unmount();
      actionsTarget.remove();
      secondaryTarget.remove();
    }
  });

  it("places restore confirmation below its workspace action and manages focus", () => {
    const actionsTarget = document.createElement("div");
    actionsTarget.className = "workspace-actions";
    document.body.append(actionsTarget);
    render(
      <WorkspaceActionsProvider target={actionsTarget}>
        <LifecycleActionsPanel
          baseVersion={5}
          canArchive
          canRestore
          canUnpublish
          collection="cmsPosts"
          documentId="post-1"
          onTransition={vi.fn()}
          publicationSupported
          status="archived"
          workspaceActions
        />
      </WorkspaceActionsProvider>,
    );

    const restore = within(actionsTarget).getByRole("button", {
      name: "Restore to draft",
    });
    restore.focus();
    fireEvent.click(restore);

    const confirmation = within(actionsTarget).getByRole("group", {
      name: "Confirm restore",
    });
    expect(confirmation).toHaveClass(
      "lifecycle-actions-confirmation-workspace",
    );
    const confirm = within(confirmation).getByRole("button", {
      name: "Confirm restore",
    });
    const description = within(confirmation).getByText(
      "Restoring returns this deleted content to draft. It does not publish the content or replace its last published snapshot.",
    );
    expect(description).toHaveAttribute("id");
    expect(confirm).toHaveAttribute("aria-describedby", description.id);
    expect(confirm).toHaveFocus();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(restore).toHaveFocus();
    expect(
      within(actionsTarget).queryByRole("group", { name: "Confirm restore" }),
    ).not.toBeInTheDocument();

    actionsTarget.remove();
  });

  it("holds actions while work is unsaved and explains the reason", () => {
    render(
      <LifecycleActionsPanel
        baseVersion={4}
        canArchive
        canRestore={false}
        canUnpublish
        collection="cmsPages"
        disabledReason="Save or revert your content edits before changing lifecycle."
        documentId="watch"
        onTransition={vi.fn()}
        publicationSupported
        status="published"
      />,
    );

    expect(screen.getByRole("button", { name: "Unpublish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByText(/save or revert your content edits/i)).toBeInTheDocument();
    expect(screen.getByText(/save or revert your content edits/i).closest('[aria-live="polite"]'))
      .toBeNull();
  });

  it("shows stale conflicts and offers a reload without retrying", async () => {
    const reload = vi.fn();
    const transition = vi.fn(async () => {
      throw new HttpError(409, "This document changed since you opened it.");
    });
    render(
      <LifecycleActionsPanel
        baseVersion={4}
        canArchive
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="post-1"
        onReload={reload}
        onTransition={transition}
        publicationSupported
        status="archived"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore to draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));

    expect(await screen.findByText("Content was not restored")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload content" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(transition).toHaveBeenCalledOnce();
  });

  it("keeps editing, publishing, and withdrawal in the current workflow", async () => {
    const transition = vi.fn(async (request) => ({
      success: true as const,
      ...request,
      fromStatus: "approved",
      toStatus: "draft",
      version: 8,
      document: { id: request.id, status: "draft", version: 8 },
    }));
    const publish = vi.fn(async () => ({
      document: { id: "post-1", status: "published", version: 8 },
      buildQueued: true,
    }));
    const { rerender } = render(
      <LifecycleActionsPanel
        baseVersion={7}
        canArchive
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="post-1"
        onPublish={publish}
        onSchedule={vi.fn()}
        onTransition={transition}
        publicationSupported
        status="approved"
      />,
    );

    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Schedule publish" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith(7, expect.any(Function)));
    expect(screen.queryByRole("button", { name: "Confirm publication" })).toBeNull();

    rerender(
      <LifecycleActionsPanel
        baseVersion={8}
        canArchive
        canEdit
        canPublish
        canRestore
        canUnpublish
        collection="cmsPosts"
        documentId="post-1"
        onPublish={publish}
        onTransition={transition}
        publicationSupported
        status="published"
      />,
    );
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("keeps Edit available when a record has no public route", () => {
    render(
      <LifecycleActionsPanel
        baseVersion={7}
        canArchive={false}
        canEdit
        canRestore={false}
        canUnpublish={false}
        collection="cmsPosts"
        documentId="sponsor-1"
        onTransition={vi.fn()}
        publicationSupported={false}
        status="approved"
      />,
    );

    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });

  it("does not offer Publish for a library-only draft", () => {
    render(
      <LifecycleActionsPanel
        baseVersion={7}
        canArchive={false}
        canEdit
        canPublish
        canRestore={false}
        canUnpublish={false}
        collection="cmsPosts"
        documentId="sponsor-1"
        onPublish={vi.fn()}
        publicationSupported={false}
        status="draft"
      />,
    );

    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});

describe("library card publication feedback", () => {
  it("keeps Send back available to a card reviewer without publication permission", async () => {
    const transition = vi.fn(async (request: TransitionContentRequest) => ({ success: true as const, ...request,
      fromStatus: "in_review", toStatus: "draft", version: 3,
      document: { id: "newsletter", status: "draft", version: 3 } }));
    render(<LifecycleActionsPanel collection="cmsPosts" documentId="newsletter" status="in_review"
      baseVersion={2} canApprove canEdit canPublish={false} canArchive={false} canUnpublish={false} canRestore={false}
      publicationSupported={false} cardPublication onTransition={transition} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send back" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "Please check the description." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm send back" }));
    await waitFor(() => expect(transition).toHaveBeenCalledWith({ collection: "cmsPosts", id: "newsletter",
      action: "sendBack", baseVersion: 2, comment: "Please check the description." }));
  });

  it("explains that approval publishes a library card and keeps routed actions absent", async () => {
    const transition = vi.fn(async (request: TransitionContentRequest) => ({ success: true as const, ...request,
      fromStatus: "in_review", toStatus: "approved", version: 3,
      document: { id: "newsletter", status: "approved", version: 3 },
      publication: { status: "queued" as const, queueId: "card-context", cardPublication: true } }));
    render(<LifecycleActionsPanel collection="cmsPosts" documentId="newsletter" status="in_review"
      baseVersion={2} liveSourceVersion={null} unifiedStatus={false} canApprove canEdit canPublish
      canArchive canUnpublish canRestore publicationSupported={false} cardPublication onTransition={transition} />);
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Schedule publish" })).toBeNull();
    expect(screen.getByText("Approve publishes this card. Unpublish or Archive removes it. Draft edits stay private.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText("Approve this saved version and update its public cards. Later draft edits stay private.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));
    expect(await screen.findByText("Approval saved. Check the public card status for confirmation.")).toBeVisible();
    expect(transition).toHaveBeenCalledWith({ collection: "cmsPosts", id: "newsletter", action: "approve", baseVersion: 2 });
  });
});
