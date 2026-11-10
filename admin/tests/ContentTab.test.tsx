import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ComponentProps } from "react";
import { ContentTab as ProductionContentTab } from "../src/components/ContentTab";
import { HttpError } from "../src/lib/functions";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";
import { createHomeNewsletterBlock } from "../../packages/content-core/src/home-newsletter-section";
import v1Home from "../../site/tests/fixtures/home-composition-v1.json";
import type { Principal } from "../../packages/content-core/src/rbac";
import type { PublicPageId } from "../../packages/content-core/src/public-pages";

// Most cases use Home as a small generic page while testing another authenticated adapter
// concern. The production ownership boundary has a dedicated case below.
function ContentTab(props: ComponentProps<typeof ProductionContentTab>) {
  return <ProductionContentTab {...props} enforcePublicPageOwnership={false} />;
}

// Dialog controls live in a portal; avoid re-scanning the page preview for each one.
function openComponentEditor() {
  const dialog = document.querySelector<HTMLDialogElement>(".component-editor-dialog[open]");
  expect(dialog).not.toBeNull();
  return within(dialog!);
}

function textButton(name: string, root: HTMLElement = document.body) {
  const button = within(root).getByText(name).closest("button");
  expect(button).toHaveAccessibleName(name);
  expect(button).toBeVisible();
  return button!;
}

// ContentTab owns the auth token and the server-owned content boundary, so the test mocks the
// authenticated functions and the separate Firestore-backed lock client. A page hydrates
// through cmsGetContent, and a save posts to cmsSaveContent with the public page id plus the
// separate block-editor template.
const firestoreMocks = vi.hoisted(() => {
  const testDb = { name: "test-db" };
  const doc = vi.fn(
    (database: unknown, collectionPath: string, docId: string) => ({
      collectionPath,
      database,
      docId,
    }),
  );
  const getDoc = vi.fn();
  // The content section registry is a live collection read (#845). This suite exercises the
  // editor, not the registry, so the collection reference is inert and its subscription is
  // answered with an empty collection snapshot -- the hook then keeps the seeded desks.
  const collection = vi.fn((database: unknown, collectionPath: string) => ({
    collectionPath,
    database,
  }));
  const onSnapshot = vi.fn(
    (reference: unknown, next: (snapshot: unknown) => void) => {
      const isCollection =
        typeof reference === "object" &&
        reference !== null &&
        !("docId" in reference);
      next(isCollection ? { docs: [] } : { exists: () => false });
      return () => {};
    },
  );
  const transactionGet = vi.fn(async () => ({ exists: () => false }));
  const transactionSet = vi.fn();
  const transactionUpdate = vi.fn();
  const runTransaction = vi.fn(
    (_database: unknown, action: (transaction: unknown) => unknown) =>
      action({
        get: transactionGet,
        set: transactionSet,
        update: transactionUpdate,
      }),
  );
  const serverTimestamp = vi.fn(() => ({ toMillis: () => Date.now() }));
  return {
    collection,
    doc,
    getDoc,
    onSnapshot,
    runTransaction,
    serverTimestamp,
    testDb,
    transactionGet,
    transactionSet,
    transactionUpdate,
  };
});

const authMocks = vi.hoisted(() => ({
  getIdToken: vi.fn(async () => "id-token"),
  state: { status: "signed-out" } as unknown,
}));

const staffSiteMocks = vi.hoisted(() => ({
  preparePrivatePreviewSession: vi.fn<(token: Promise<string>) => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/staff-site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/staff-site")>()),
  preparePrivatePreviewSession: staffSiteMocks.preparePrivatePreviewSession,
}));

const functionsMocks = vi.hoisted(() => ({
  cmsBulkArchiveContent: vi.fn(),
  cmsGetContent: vi.fn(),
  cmsGetRevision: vi.fn(),
  cmsListContent: vi.fn(),
  cmsListMedia: vi.fn(),
  cmsListRevisions: vi.fn(),
  cmsPublish: vi.fn(),
  cmsRequestSavedPreview: vi.fn(),
  cmsSaveContent: vi.fn(),
  cmsUploadMedia: vi.fn(),
}));

// The editor presence lock and the content section registry both subscribe through
// onSnapshot, so a lock assertion has to name the lock rather than count every
// subscription the editor makes (#845). A lock watches one document, so its reference
// carries a docId; the registry watches a collection, so its reference does not.
function editorLockSubscriptions() {
  return firestoreMocks.onSnapshot.mock.calls.filter(
    (call) =>
      typeof call[0] === "object" && call[0] !== null && "docId" in call[0],
  );
}

vi.mock("firebase/firestore", () => ({
  query: (ref: object, ...constraints: unknown[]) => ({ ...ref, constraints }),
  limit: (count: number) => ({ limit: count }),
  collection: firestoreMocks.collection,
  doc: firestoreMocks.doc,
  getDoc: firestoreMocks.getDoc,
  onSnapshot: firestoreMocks.onSnapshot,
  runTransaction: firestoreMocks.runTransaction,
  serverTimestamp: firestoreMocks.serverTimestamp,
}));

// `firebaseConfig` is here because the real functions module builds its emulator base URL from
// the project id at import time, and this file now loads that module for real (see the mock
// below). Without it the import throws before any test runs.
vi.mock("../src/lib/firebase", () => ({
  db: firestoreMocks.testDb,
  firebaseConfig: { projectId: "test-project" },
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    getIdToken: authMocks.getIdToken,
    state: authMocks.state,
  }),
}));

vi.mock("../src/lib/use-media-categories", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/use-media-categories")>(),
  useMediaCategories: () => ({
    state: {
      status: "ready",
      categories: [
        {
          id: "news",
          label: "News",
          description: "Newsroom media",
          order: 10,
          active: true,
          reserved: false,
          version: 1,
          etag: '"media-category.bmV3cw.1"',
          canUpload: true,
          canManage: false,
          createdAt: null,
          createdBy: null,
          updatedAt: null,
          updatedBy: null,
        },
      ],
    },
    reload: vi.fn(),
  }),
}));

// Only the network call is faked. Keeping the rest of the module real matters: BlockEditor
// reads isConflictError from here to tell a save conflict from an ordinary failure, and a
// bare factory mock would replace it with undefined -- so the first test to reject a page save
// would fail on a missing function rather than on anything it meant to check.
vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsBulkArchiveContent: functionsMocks.cmsBulkArchiveContent,
  cmsGetContent: functionsMocks.cmsGetContent,
  cmsRequestSavedPreview: functionsMocks.cmsRequestSavedPreview,
  cmsGetRevision: functionsMocks.cmsGetRevision,
  cmsListContent: functionsMocks.cmsListContent,
  cmsListMedia: functionsMocks.cmsListMedia,
  cmsListRevisions: functionsMocks.cmsListRevisions,
  cmsPublish: functionsMocks.cmsPublish,
  cmsSaveContent: functionsMocks.cmsSaveContent,
  cmsUploadMedia: functionsMocks.cmsUploadMedia,
}));

// CMS page and record documents do not carry a trusted editorial section yet, so the live
// content routes admit site-wide grants. Keep the general editor fixture on that real boundary;
// scoped-grant denial belongs in the dedicated access tests.
const editor: Principal = { id: "e", grants: [{ role: "editor" }] };
const siteWideEditor: Principal = { id: "e", grants: [{ role: "editor" }] };
const adminPrincipal: Principal = { id: "a", grants: [{ role: "admin" }] };
const siteWideContributor: Principal = {
  id: "c",
  grants: [{ role: "contributor" }],
};
const scopedEditor: Principal = {
  id: "scoped-editor",
  grants: [{ role: "editor", sections: ["news"] }],
};
const noCapabilityPrincipal: Principal = {
  id: "no-capability",
  grants: [],
};
const emptyLibrarySelection = {
  success: true as const,
  records: [],
  total: 0,
  allCount: 0,
  mineCount: 0,
  assignedCount: 0,
  page: 1,
  pageCount: 1,
  statusCounts: {
    draft: 0,
    in_review: 0,
    scheduled: 0,
    published: 0,
    archived: 0,
  },
};

// Built from createBlock so the stored payload is a valid block envelope (loadPage runs
// parseBlocks on what it reads), then given real headline text so hydration is observable.
const headlineBase = createBlock("headline", "srv-headline");
const storedHeadline: AdminBlock = {
  ...headlineBase,
  data: { ...headlineBase.data, text: "Existing headline" },
};
const promotionShelfBase = createBlock("promotion_playlist", "srv-home-shelf");
const storedPromotionShelf: AdminBlock = {
  ...promotionShelfBase,
  order: 1,
  visible: false,
};

function legacyHomeDocument(version = 3): Record<string, unknown> {
  return {
    id: "home",
    blocks: [storedPromotionShelf],
    title: "Home",
    createdBy: editor.id,
    status: "draft",
    version,
  };
}

function markedHomeDocument(version = 4): Record<string, unknown> {
  return {
    id: "home",
    blocks: homeCompositionDefaults(),
    homeCompositionVersion: 1,
    title: "Home",
    createdBy: editor.id,
    status: "draft",
    version,
  };
}

function foundContentResponse(document: Record<string, unknown>) {
  return {
    success: true as const,
    found: true as const,
    document,
  };
}

function mockFoundContent(document: Record<string, unknown>) {
  functionsMocks.cmsGetContent.mockResolvedValue({
    success: true,
    found: true,
    document,
  });
}

function mockMissingContent() {
  functionsMocks.cmsGetContent.mockResolvedValue({
    success: true,
    found: false,
    document: null,
  });
}

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("ContentTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.state = { status: "signed-out" };
    mockFoundContent({ id: "home", blocks: [storedHeadline] });
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPages",
      id: "home",
      created: false,
      document: { id: "home", blocks: [storedHeadline] },
    });
    functionsMocks.cmsListContent.mockResolvedValue(emptyLibrarySelection);
    functionsMocks.cmsListRevisions.mockResolvedValue({
      success: true,
      entries: [],
      nextCursor: null,
    });
    functionsMocks.cmsGetRevision.mockResolvedValue({
      success: true,
      revision: null,
    });
    functionsMocks.cmsBulkArchiveContent.mockResolvedValue({
      success: true,
      outcomes: [],
      counts: {
        archived: 0,
        already_archived: 0,
        conflict: 0,
        missing: 0,
        failed: 0,
      },
    });
  });

  it("does not reserve a page whose own save decision refuses this contributor", async () => {
    // The contributor clears the site-wide content-write floor, so the lease actor resolves.
    // The page itself is another matter: it carries no trusted ownership or workflow status, so
    // the save would be refused and reserving it would hold the record against an editor who
    // could actually work on it -- and Firestore would refuse the lease anyway (#1047).
    authMocks.state = {
      status: "signed-in",
      user: {
        uid: "c",
        email: "account-6@example.org",
        displayName: "Casey Contributor",
      },
      principal: siteWideContributor,
      userDoc: {
        role: null,
        grants: [{ role: "contributor" }],
        displayName: "Casey Contributor",
      },
    };

    render(
      <ContentTab
        principal={siteWideContributor}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    // Settle the cold workspace import before the short UI readiness assertion.
    await act(async () => { await vi.dynamicImportSettled(); });
    const headline = await screen.findByDisplayValue(
      "Existing headline",
      {},
      { timeout: 3_000 },
    );
    // Presence is still observed: the person must be told who is editing even when they cannot.
    await waitFor(() => expect(editorLockSubscriptions()).toHaveLength(1));

    fireEvent.change(headline, { target: { value: "Changed headline" } });
    await act(async () => {});
    expect(firestoreMocks.transactionSet).not.toHaveBeenCalled();
  });

  it("reserves a draft page the contributor owns", async () => {
    mockFoundContent({
      id: "about",
      blocks: [storedHeadline],
      createdBy: "c",
      status: "draft",
    });
    authMocks.state = {
      status: "signed-in",
      user: {
        uid: "c",
        email: "account-6@example.org",
        displayName: "Casey Contributor",
      },
      principal: siteWideContributor,
      userDoc: {
        role: null,
        grants: [{ role: "contributor" }],
        displayName: "Casey Contributor",
      },
    };

    render(
      <ContentTab
        principal={siteWideContributor}
        surface={{ kind: "page", pageId: "about", section: "genericPage" }}
      />,
    );

    await screen.findByDisplayValue("Existing headline");
    await waitFor(() =>
      expect(firestoreMocks.transactionSet).toHaveBeenCalledTimes(1),
    );
    expect(firestoreMocks.transactionSet.mock.calls[0]![1]).toMatchObject({
      surfaceKey: "cmsPages:about",
      ownerId: "c",
      ownerName: "Casey Contributor",
    });
  });

  it.each([
    {
      label: "site-wide editor",
      principal: siteWideEditor,
      user: {
        uid: "e",
        email: "account-9@example.org",
        displayName: "Eden Editor",
      },
      userDoc: {
        role: null,
        grants: [{ role: "editor" }],
        displayName: "Eden Editor",
      },
    },
    {
      label: "top-level administrator",
      principal: adminPrincipal,
      user: {
        uid: "a",
        email: "account-2@example.org",
        displayName: "Al Admin",
      },
      userDoc: {
        role: "admin",
        grants: [],
        displayName: "Al Admin",
      },
    },
  ])("subscribes and claims the real lease identity for a $label", async ({
    principal,
    user,
    userDoc,
  }) => {
    authMocks.state = {
      status: "signed-in",
      user,
      principal,
      userDoc,
    };

    render(
      <ContentTab
        principal={principal}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    await screen.findByDisplayValue("Existing headline");
    await waitFor(() => expect(editorLockSubscriptions()).toHaveLength(1));
    expect(editorLockSubscriptions()[0]?.[0]).toMatchObject({
      collectionPath: "cmsEditorLocks",
      database: firestoreMocks.testDb,
      docId: "cmsPages:home",
    });

    await waitFor(() =>
      expect(firestoreMocks.transactionSet).toHaveBeenCalledTimes(1),
    );
    const [reference, claim] = firestoreMocks.transactionSet.mock.calls[0]!;
    expect(reference).toMatchObject({
      collectionPath: "cmsEditorLocks",
      database: firestoreMocks.testDb,
      docId: "cmsPages:home",
    });
    expect(claim).toMatchObject({
      surfaceKey: "cmsPages:home",
      contentCollection: "cmsPages",
      contentId: "home",
      ownerId: user.uid,
      ownerName: userDoc.displayName,
      sessionId: expect.any(String),
    });
    expect(claim.sessionId).toHaveLength(36);
  });

  it.each([
    {
      label: "section-scoped editor",
      principal: scopedEditor,
      userDoc: {
        role: null,
        grants: [{ role: "editor", sections: ["news"] }],
        displayName: "Nia News",
      },
    },
    {
      label: "account without a content capability",
      principal: noCapabilityPrincipal,
      userDoc: {
        role: null,
        grants: [],
        displayName: "Nora No Access",
      },
    },
  ])("does not subscribe or claim for a $label", async ({
    principal,
    userDoc,
  }) => {
    authMocks.state = {
      status: "signed-in",
      user: {
        uid: principal.id,
        email: `${principal.id}@njpbs.org`,
        displayName: userDoc.displayName,
      },
      principal,
      userDoc,
    };

    render(
      <ContentTab
        principal={principal}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    const headline = await screen.findByDisplayValue("Existing headline");
    if (!(headline as HTMLInputElement).disabled) {
      fireEvent.change(headline, { target: { value: "Changed headline" } });
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(editorLockSubscriptions()).toHaveLength(0);
    expect(firestoreMocks.runTransaction).not.toHaveBeenCalled();
  });

  it("hydrates a page by public page id and saves its separate editor template", async () => {
    render(<ContentTab principal={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Home page" }));

    // Hydration reads the public-page document, and its stored block seeds the editor.
    expect(await screen.findByDisplayValue("Existing headline")).toBeTruthy();
    expect(functionsMocks.cmsGetContent).toHaveBeenCalledWith("id-token", {
      collection: "cmsPages",
      id: "home",
    });
    expect(firestoreMocks.getDoc).not.toHaveBeenCalled();

    // Saving the hydrated page posts to cmsSaveContent keyed by the public page id, sending
    // the stored composition (not a blank editor) and its separate editor template.
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );

    const [idToken, body] = functionsMocks.cmsSaveContent.mock.calls[0]!;
    expect(idToken).toBe("id-token");
    expect(body.collection).toBe("cmsPages");
    expect(body.id).toBe("home");
    expect(body.document.template).toBe("home");
    expect(body.document.blocks).toHaveLength(1);
    expect(body.document.blocks[0]).toMatchObject({
      id: "srv-headline",
      type: "headline",
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("sends the explicit Data Hub composition version with a normal Page block save", async () => {
    const section = { ...createBlock("data_hub_section", "hub-unemployment"), order: 0,
      data: { sectionId: "unemployment", heading: "", introduction: "" } };
    const retained = { ...createBlock("link_card", "retained-link"), order: 1,
      data: { title: "Retained link", url: "https://example.org/", summary: "Legacy copy" } };
    const document = { id: "data-hub", title: "New Jersey by the Numbers", status: "draft", version: 3,
      template: "genericPage", dataHubCompositionVersion: 1, blocks: [section, retained] };
    mockFoundContent(document);
    functionsMocks.cmsSaveContent.mockImplementation(async (_token, request) => ({ success: true,
      collection: "cmsPages", id: "data-hub", created: false,
      document: { ...document, ...request.document, version: 4 } }));
    render(<ContentTab principal={editor} surface={{ kind: "page", pageId: "data-hub", section: "genericPage" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Data Hub section 1" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Heading" }), { target: { value: "Employment in New Jersey" } });
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(functionsMocks.cmsSaveContent).toHaveBeenCalledOnce());
    expect(functionsMocks.cmsSaveContent.mock.calls[0][1]).toMatchObject({ collection: "cmsPages", id: "data-hub", baseVersion: 3,
      document: { template: "genericPage", dataHubCompositionVersion: 1, blocks: [
        { data: { sectionId: "unemployment", heading: "Employment in New Jersey", introduction: "" } },
        retained,
      ] } });
  });

  it("autosaves a changed page after 60 seconds and skips an untouched page", async () => {
    mockFoundContent({ id: "home", blocks: [storedHeadline], status: "draft", version: 1 });
    functionsMocks.cmsSaveContent.mockImplementationOnce(async (_token, request) => ({
      success: true, collection: "cmsPages", id: "home", created: false,
      document: { ...request.document, id: "home", status: "draft", version: 2 },
    }));
    vi.useFakeTimers();
    try {
      render(
        <ContentTab
          principal={editor}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />,
      );
      await act(async () => { await vi.dynamicImportSettled(); });
      const headline = screen.getByDisplayValue("Existing headline");

      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(functionsMocks.cmsSaveContent).not.toHaveBeenCalled();

      fireEvent.change(headline, {
        target: { value: "Autosaved headline" },
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
      expect(functionsMocks.cmsSaveContent).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });

      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1);
      expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({
        collection: "cmsPages",
        id: "home",
        document: {
          blocks: [
            expect.objectContaining({
              id: "srv-headline",
              data: expect.objectContaining({ text: "Autosaved headline" }),
            }),
          ],
        },
      });
      expect(screen.getByText("Draft autosaved.")).toBeTruthy();
      fireEvent.change(screen.getByDisplayValue("Autosaved headline"), {
        target: { value: "Another edit" },
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(screen.queryByText("Draft autosaved.")).toBeNull();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("keeps the legacy manual shelf on unmarked Home", async () => {
    const storedBlocks = [storedHeadline, storedPromotionShelf];
    mockFoundContent({
      id: "home",
      blocks: storedBlocks,
      createdBy: editor.id,
      status: "draft",
      version: 3,
    });
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPages",
      id: "home",
      created: false,
      mintedIds: {},
      document: { id: "home", blocks: storedBlocks, version: 4 },
    });

    render(<ProductionContentTab principal={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Home page" }));

    expect(await screen.findByRole("button", {
      name: "Enable Home editing",
    })).toBeEnabled();
    expect(screen.queryByDisplayValue("Existing headline")).toBeNull();
    expect(screen.getByRole("region", {
      name: /Manual content shelf/i,
    })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({
      collection: "cmsPages",
      id: "home",
      baseVersion: 3,
      document: {
        template: "home",
        blocks: storedBlocks,
      },
    });
  });

  it("sends only the version-checked Home conversion and reads back the canonical draft", async () => {
    const legacy = legacyHomeDocument();
    const canonical = markedHomeDocument();
    functionsMocks.cmsGetContent
      .mockResolvedValueOnce(foundContentResponse(legacy))
      .mockResolvedValue(foundContentResponse(canonical));
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPages",
      id: "home",
      created: false,
      mintedIds: {},
      document: canonical,
    });

    render(
      <ProductionContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", {
      name: "Enable Home editing",
    }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );

    const [idToken, request] = functionsMocks.cmsSaveContent.mock.calls[0]!;
    expect(typeof request.convertHome).toBe("string");
    expect(idToken).toBe("id-token");
    expect(request).toEqual({
      collection: "cmsPages",
      id: "home",
      baseVersion: 3,
      convertHome: request.convertHome,
      document: { blocks: homeCompositionDefaults() },
    });
    await waitFor(() =>
      expect(functionsMocks.cmsGetContent).toHaveBeenCalledTimes(3),
    );
    expect(functionsMocks.cmsGetContent.mock.calls[1]).toEqual([
      "id-token",
      { collection: "cmsPages", id: "home" },
    ]);
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Edit Passport",
    })).toBeEnabled());
    expect(functionsMocks.cmsPublish).not.toHaveBeenCalled();
  });

  it("adopts a marked Home readback when the conversion response is uncertain", async () => {
    const canonical = markedHomeDocument();
    functionsMocks.cmsGetContent
      .mockResolvedValueOnce(foundContentResponse(legacyHomeDocument()))
      .mockResolvedValue(foundContentResponse(canonical));
    functionsMocks.cmsSaveContent.mockRejectedValueOnce(
      new TypeError("The response was lost."),
    );

    render(
      <ProductionContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", {
      name: "Enable Home editing",
    }));

    await waitFor(() => expect(screen.getByRole("button", {
      name: "Edit Passport",
    })).toBeEnabled());
    expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1);
    expect(functionsMocks.cmsGetContent).toHaveBeenCalledTimes(3);
    expect(functionsMocks.cmsGetContent.mock.calls[1]).toEqual([
      "id-token",
      { collection: "cmsPages", id: "home" },
    ]);
  });

  it("keeps uncertain conversion retryable when its canonical readback also fails", async () => {
    functionsMocks.cmsGetContent
      .mockResolvedValueOnce(foundContentResponse(legacyHomeDocument()))
      .mockRejectedValue(new Error("Canonical Home readback failed."));
    functionsMocks.cmsSaveContent.mockRejectedValue(
      new TypeError("The response was lost."),
    );

    render(
      <ProductionContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );
    const enable = await screen.findByRole("button", {
      name: "Enable Home editing",
    });
    fireEvent.click(enable);

    expect(await screen.findByText(
      "The page could not be loaded. Reload to try again.",
    )).toBeTruthy();
    expect(functionsMocks.cmsGetContent).toHaveBeenCalledTimes(2);
    const firstRequest = functionsMocks.cmsSaveContent.mock.calls[0]![1];
    fireEvent.click(screen.getByRole("button", {
      name: "Enable Home editing",
    }));

    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(functionsMocks.cmsGetContent).toHaveBeenCalledTimes(3),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[1]![1]).toEqual(firstRequest);
    expect(screen.getByRole("button", {
      name: "Enable Home editing",
    })).toBeEnabled();
  });

  it("does not adopt an advanced legacy readback or change its retry claim", async () => {
    functionsMocks.cmsGetContent
      .mockResolvedValueOnce(foundContentResponse(legacyHomeDocument(3)))
      .mockResolvedValue(foundContentResponse(legacyHomeDocument(4)));
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPages",
      id: "home",
      created: false,
      mintedIds: {},
      document: markedHomeDocument(),
    });

    render(
      <ProductionContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", {
      name: "Enable Home editing",
    }));

    expect(await screen.findByText(
      /Home changed before its converted draft could be loaded/,
    )).toBeTruthy();
    const firstRequest = functionsMocks.cmsSaveContent.mock.calls[0]![1];
    fireEvent.click(screen.getByRole("button", {
      name: "Enable Home editing",
    }));

    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[1]![1]).toEqual(firstRequest);
    expect(firstRequest).toMatchObject({
      baseVersion: 3,
      convertHome: expect.any(String),
    });
    expect(screen.queryByRole("button", { name: "Edit Passport" })).toBeNull();
    expect(screen.getByRole("button", { name: "Enable Home editing" })).toBeTruthy();
  });

  it("confirms editorial conversion, sends the exact base once, and reads back the saved v2 draft", async () => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "true");
    const original = { ...markedHomeDocument(), status: "published", version: 3 };
    const converted = { ...original, status: "draft", version: original.version + 1, homeCompositionVersion: 2 };
    functionsMocks.cmsGetContent.mockResolvedValueOnce(foundContentResponse(original)).mockResolvedValue(foundContentResponse(converted));
    functionsMocks.cmsSaveContent.mockResolvedValue({ success: true, document: converted });
    render(<ProductionContentTab principal={editor} surface={{ kind: "page", pageId: "home", section: "home" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use the editorial layout" }));
    const confirmation = screen.getByRole("group", { name: "Use the editorial layout?" });
    expect(confirmation).toHaveTextContent("The live homepage does not change until you press Publish.");
    expect(functionsMocks.cmsSaveContent).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Use the editorial layout" }));
    await waitFor(() => expect(functionsMocks.cmsSaveContent).toHaveBeenCalledOnce());
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toEqual({ collection: "cmsPages", id: "home", baseVersion: original.version, convertHomeV2: expect.any(String), document: {} });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use the editorial layout" })).toBeNull());
  });

  it("reuses the editorial request key after an uncertain response and keeps the draft available", async () => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "true");
    mockFoundContent(markedHomeDocument());
    functionsMocks.cmsSaveContent.mockRejectedValue(new TypeError("Connection interrupted"));
    render(<ProductionContentTab principal={editor} surface={{ kind: "page", pageId: "home", section: "home" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use the editorial layout" }));
    const confirm = () => within(screen.getByRole("group", { name: "Use the editorial layout?" })).getByRole("button", { name: "Use the editorial layout" });
    fireEvent.click(confirm());
    expect(await screen.findByText("Connection interrupted")).toBeVisible();
    fireEvent.click(confirm());
    await waitFor(() => expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2));
    expect(functionsMocks.cmsSaveContent.mock.calls[1]![1]).toEqual(functionsMocks.cmsSaveContent.mock.calls[0]![1]);
    expect(functionsMocks.cmsGetContent.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses conversion before acquiring a credential if the layout flag closes during confirmation", async () => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "true");
    mockFoundContent(markedHomeDocument());
    render(<ProductionContentTab principal={editor} surface={{ kind: "page", pageId: "home", section: "home" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Use the editorial layout" }));
    const credentialCalls = authMocks.getIdToken.mock.calls.length;
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    fireEvent.click(within(screen.getByRole("group", { name: "Use the editorial layout?" })).getByRole("button", { name: "Use the editorial layout" }));
    expect(await screen.findByText("Editorial Home editing is not enabled. Its saved draft has been preserved.")).toBeVisible();
    expect(functionsMocks.cmsSaveContent).not.toHaveBeenCalled();
    expect(authMocks.getIdToken).toHaveBeenCalledTimes(credentialCalls);
  });

  it.each(["publish", "schedule"])("sends a v2 Home %s through the saved-content boundary", async intent => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "true");
    const document = { ...markedHomeDocument(4), homeCompositionVersion: 2,
      blocks: [...homeCompositionDefaults(), createHomeNewsletterBlock("empty-newsletter")].map((block, order) => ({ ...block, order })) };
    mockFoundContent(document);
    functionsMocks.cmsSaveContent.mockResolvedValue({ success: true, document: { ...document, version: 5 },
      publication: intent === "publish" ? { queueId: "home-operation", status: "pending", transport: "page-no-build-v1" } : undefined });
    render(<ProductionContentTab principal={adminPrincipal} surface={{ kind: "page", pageId: "home", section: "home" }} />);
    await screen.findByLabelText("Search title");
    expect(screen.getByText("Publishing shows the standard newsletter band until a newsletter is chosen.")).toBeVisible();
    if (intent === "schedule") {
      fireEvent.click(screen.getByRole("button", { name: "Schedule publish" }));
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(tomorrow).replace(" ", "T");
      fireEvent.change(screen.getByLabelText("Publication time (New York)"), { target: { value: local } });
      fireEvent.click(screen.getByRole("button", { name: "Confirm schedule" }));
    } else fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(functionsMocks.cmsSaveContent).toHaveBeenCalledOnce());
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({ collection: "cmsPages", id: "home", baseVersion: 4, document: {},
      ...(intent === "publish" ? { publish: true } : { scheduleAt: expect.any(String) }) });
    expect(functionsMocks.cmsPublish).not.toHaveBeenCalled();
  });

  it.each(["flag off", "writer", "News editor"])("hides the editorial conversion for %s", async mode => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", mode === "flag off" ? "false" : "true");
    mockFoundContent(markedHomeDocument());
    const principal = mode === "writer" ? { id: "writer", grants: [{ role: "contributor" as const }] } : mode === "News editor" ? { id: "news", grants: [{ role: "editor" as const, sections: ["news"] }] } : editor;
    render(<ProductionContentTab principal={principal} surface={{ kind: "page", pageId: "home", section: "home" }} />);
    await screen.findByLabelText("Search title");
    expect(screen.queryByRole("button", { name: "Use the editorial layout" })).toBeNull();
    expect(functionsMocks.cmsSaveContent).not.toHaveBeenCalled();
  });

  it("refuses to misread a v2 Home as a legacy conversion or writable shelf", async () => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    mockFoundContent({ ...markedHomeDocument(), homeCompositionVersion: 2 });
    render(<ProductionContentTab principal={editor} surface={{ kind: "page", pageId: "home", section: "home" }} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Version 2 Home editing is not enabled. Its saved draft has been preserved.");
    expect(screen.queryByRole("button", { name: "Enable Home editing" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Passport" })).toBeNull();
    expect(functionsMocks.cmsSaveContent).not.toHaveBeenCalled();
  });

  it("refuses a v2 metadata write before requesting a write credential when its guard closes", async () => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "true");
    mockFoundContent({ ...markedHomeDocument(), homeCompositionVersion: 2 });
    render(<ProductionContentTab principal={editor} surface={{ kind: "page", pageId: "home", section: "home" }} />);
    const title = await screen.findByLabelText("Search title");
    const readTokenCalls = authMocks.getIdToken.mock.calls.length;
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    fireEvent.change(title, { target: { value: "Changed draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some(alert => alert.textContent?.includes("Version 2 Home editing is not enabled"))).toBe(true));
    expect(functionsMocks.cmsSaveContent).not.toHaveBeenCalled();
    expect(authMocks.getIdToken.mock.calls).toHaveLength(readTokenCalls);
  });

  it.each([1, 2] as const)("enables Home v%s publication and scheduling when layouts are on", async version => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "true");
    mockFoundContent({ ...markedHomeDocument(), homeCompositionVersion: version });
    render(<ProductionContentTab principal={adminPrincipal} surface={{ kind: "page", pageId: "home", section: "home" }} />);
    expect(await screen.findByLabelText("Search title")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save metadata" })).toBeEnabled();
    const publishingMenu = screen.queryByRole("button", { name: "Publishing" });
    if (publishingMenu) fireEvent.click(publishingMenu);
    const publish = screen.getByRole("button", { name: "Publish" });
    const schedule = screen.getByRole("button", { name: "Schedule publish" });
    expect(publish).toBeEnabled();
    expect(schedule).toBeEnabled();
    expect(functionsMocks.cmsSaveContent).not.toHaveBeenCalled();
    expect(functionsMocks.cmsPublish).not.toHaveBeenCalled();
  });

  it.each([1, 2] as const)("carries Home v%s through metadata and block saves with its saved order", async version => {
    if (version === 2) vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "true");
    // V2 puts the existing Passport group first. Legacy fixed ordering must not
    // rearrange it when the canonical response becomes the next save baseline.
    const blocks = version === 1 ? homeCompositionDefaults() as AdminBlock[]
      : [...v1Home.blocks.slice(3, 5), ...v1Home.blocks.slice(0, 3), ...v1Home.blocks.slice(5)]
          .map((block, order) => ({ ...block, order })) as AdminBlock[];
    mockFoundContent({
      id: "home",
      blocks,
      homeCompositionVersion: version,
      title: "Home",
      version: 3,
    });
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPages",
      id: "home",
      created: false,
      mintedIds: {},
      document: {
        id: "home",
        blocks,
        homeCompositionVersion: version,
        title: "Home",
        seo: { title: "NJ PBS Home" },
        version: 4,
      },
    });

    render(
      <ProductionContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    fireEvent.change(await screen.findByLabelText("Search title"), {
      target: { value: "NJ PBS Home" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    const metadataSave = functionsMocks.cmsSaveContent.mock.calls[0]![1];
    expect(metadataSave.baseVersion).toBe(3);
    expect(metadataSave.document).not.toHaveProperty("blocks");
    expect(metadataSave.document).not.toHaveProperty("homeCompositionVersion");

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );
    const blockSave = functionsMocks.cmsSaveContent.mock.calls[1]![1];
    expect(blockSave.baseVersion).toBe(4);
    expect(blockSave.document.blocks).toHaveLength(blocks.length);
    expect(blockSave.document.blocks.map((block: AdminBlock) => block.id)).toEqual(blocks.map(block => block.id));
    if (version === 2) expect(blockSave.document.blocks).toEqual(blocks);
    else expect(blockSave.document.blocks).toMatchObject(blocks);
    expect(blockSave.document).not.toHaveProperty("homeCompositionVersion");
  });

  it("refuses a marked metadata-only Home document", async () => {
    mockFoundContent({
      id: "home",
      homeCompositionVersion: 1,
      title: "Home",
      version: 3,
    });

    render(
      <ProductionContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /saved content can't be opened for editing/i,
    );
    expect(screen.queryByRole("button", { name: "Save page" })).toBeNull();
  });

  it("loads revision summaries for the stored page through the authenticated boundary", async () => {
    render(
      <ContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    expect(await screen.findByDisplayValue("Existing headline")).toBeTruthy();
    const revisionsToggle = screen.getByRole("button", {
      name: "Revision history",
    });
    if (revisionsToggle.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(revisionsToggle);
    }

    await waitFor(() =>
      expect(functionsMocks.cmsListRevisions).toHaveBeenCalledWith("id-token", {
        collection: "cmsPages",
        id: "home",
      }),
    );
    expect(screen.getByText("No revisions yet")).toBeTruthy();
  });

  it.each(["draft", "in_review"])("offers the configured Page Preview action to its Writer in %s", async status => {
    mockFoundContent({ id: "watch", blocks: [], status, title: "Watch NJ PBS",
      createdBy: "c", version: 2 });
    render(<ContentTab principal={siteWideContributor} previewConfigured
      surface={{ kind: "page", pageId: "watch", section: "programLanding" }} />);
    expect(await screen.findByDisplayValue("Watch NJ PBS")).toBeTruthy();
    const toggle = screen.getAllByRole("button", { name: "Preview" })
      .find(button => button.hasAttribute("aria-expanded"))!;
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
    expect(screen.getAllByRole("button", { name: "Preview" })
      .find(button => !button.hasAttribute("aria-expanded"))).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Build preview" })).toBeNull();
  });

  it.each(["draft", "in_review"])("offers the configured Post Preview action to its Writer in %s", async status => {
    mockFoundContent({ id: "post-1", type: "post", version: 2, createdBy: "c",
      section: "news", status, title: "Garden State update", date: "2026-10-08", tags: [], blocks: [] });
    render(<MemoryRouter><ContentTab principal={siteWideContributor} previewConfigured
      surface={{ kind: "record", record: "post", id: "post-1" }} /></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "Preview" })).toBeEnabled();
  });

  it("offers Preview to a News Editor opening their own Watch draft as a Writer", async () => {
    mockFoundContent({ id: "post-1", type: "post", version: 2, createdBy: "mixed-staff",
      section: "watch", status: "draft", title: "Watch update", date: "2026-10-08", tags: [], blocks: [] });
    const principal: Principal = { id: "mixed-staff", grants: [
      { role: "editor", sections: ["news"] }, { role: "contributor", sections: ["watch"] },
    ] };
    render(<MemoryRouter><ContentTab principal={principal} previewConfigured
      surface={{ kind: "record", record: "post", id: "post-1" }} /></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "Preview" })).toBeEnabled();
  });

  it("offers the configured Post Preview action to an editor without archive access", async () => {
    mockFoundContent({
      id: "post-1",
      type: "post",
      version: 2,
      createdBy: "another-editor",
      section: "news",
      status: "draft",
      title: "Garden State update",
      date: "2026-10-08",
      tags: [],
      blocks: [],
    });

    render(
      <MemoryRouter>
        <ContentTab
          principal={scopedEditor}
          previewConfigured
          surface={{ kind: "record", record: "post", id: "post-1" }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: "Preview" }),
    ).toBeEnabled();
  });

  it("offers the configured Page Preview action to an editor for that content area", async () => {
    const watchEditor: Principal = {
      id: "watch-editor",
      grants: [{ role: "editor", sections: ["watch"] }],
    };
    mockFoundContent({
      id: "watch",
      blocks: [],
      status: "draft",
      title: "Watch NJ PBS",
      version: 2,
    });

    render(
      <ContentTab
        principal={watchEditor}
        previewConfigured
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    expect(await screen.findByDisplayValue("Watch NJ PBS")).toBeTruthy();
    const toggle = screen
      .getAllByRole("button", { name: "Preview" })
      .find((button) => button.hasAttribute("aria-expanded"));
    if (!toggle) throw new Error("Expected the Page Preview menu toggle");
    if (toggle.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(toggle);
    }
    expect(
      screen
        .getAllByRole("button", { name: "Preview" })
        .find((button) => !button.hasAttribute("aria-expanded")),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Build preview" })).toBeNull();
  });

  it("does not give a contributor a media loader that the server will reject", async () => {
    const image: AdminBlock = {
      id: "image-1",
      type: "image",
      order: 0,
      visible: true,
      data: {
        assetId: "asset-news-desk",
        alt: "A presenter at the news desk",
        caption: "",
      },
    };
    mockFoundContent({ id: "home", createdBy: "c", blocks: [image] });

    render(
      <ContentTab
        principal={siteWideContributor}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    const imageRegion = await screen.findByRole("region", { name: "image" });
    const editImage = within(imageRegion).getByRole("button", { name: "Edit image 1" });
    await waitFor(() => expect(editImage).toBeEnabled());
    fireEvent.click(editImage);
    expect(
      within(imageRegion).getByText(
        "Media access is required to change this image.",
      ),
    ).toBeVisible();
    expect(
      within(imageRegion).queryByPlaceholderText("Asset id"),
    ).not.toBeInTheDocument();
    expect(functionsMocks.cmsListMedia).not.toHaveBeenCalled();
  });

  it("accepts the exact preview while session setup runs and waits before ready navigation", async () => {
    let finishSession!: () => void;
    staffSiteMocks.preparePrivatePreviewSession.mockImplementationOnce(() => new Promise<void>(resolve => { finishSession = resolve; }));
    mockFoundContent({ id: "home", blocks: [storedHeadline], title: "Home", status: "draft", version: 7 });
    const queueId = "abcdefghijklmnopqrst";
    const ready = { success: true, queueId, collection: "cmsPages", pageId: "home", pagePath: "/", status: "ready", sourceVersion: 7,
      rendererSha: "a".repeat(40), previewUrl: `https://preview.njpbs.org/p/${queueId}/` };
    functionsMocks.cmsRequestSavedPreview.mockResolvedValue(ready);
    const replace = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue({ closed: false, document: document.implementation.createHTMLDocument(),
      opener: null, close: vi.fn(), location: { replace } } as unknown as Window);
    render(<ContentTab canArchiveLibrary principal={adminPrincipal} previewConfigured
      surface={{ kind: "page", pageId: "home", section: "home" }} />);
    expect(await screen.findByDisplayValue("Existing headline", {}, { timeout: 5000 })).toBeTruthy();
    const toggle = screen.getAllByRole("button", { name: "Preview" }).find(button => button.hasAttribute("aria-expanded"))!;
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
    fireEvent.click(screen.getAllByRole("button", { name: "Preview" }).find(button => !button.hasAttribute("aria-expanded"))!);
    await waitFor(() => expect(functionsMocks.cmsRequestSavedPreview).toHaveBeenCalledWith("id-token", "cmsPages", "home", 7));
    expect(staffSiteMocks.preparePrivatePreviewSession).toHaveBeenCalledWith(expect.any(Promise));
    await expect(staffSiteMocks.preparePrivatePreviewSession.mock.calls[0][0]).resolves.toBe("id-token");
    expect(replace).not.toHaveBeenCalled();
    await act(async () => finishSession());
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`https://preview.njpbs.org/p/${queueId}/`));
    expect(screen.queryByRole("button", { name: "Refresh preview" })).toBeNull();
    open.mockRestore();
  });

  it.each(["denied", "network failure"])("navigates the existing valid preview after session %s", async (failure) => {
    const actual = await vi.importActual<typeof import("../src/lib/staff-site")>("../src/lib/staff-site");
    const fetch = vi.fn();
    if (failure === "denied") fetch.mockResolvedValue({ ok: false, status: 403 });
    else fetch.mockRejectedValue(new Error("Session network failure"));
    vi.stubGlobal("fetch", fetch);
    staffSiteMocks.preparePrivatePreviewSession.mockImplementationOnce(token => actual.preparePrivatePreviewSession(token));
    mockFoundContent({ id: "home", blocks: [storedHeadline], title: "Home", status: "draft", version: 7 });
    const queueId = "abcdefghijklmnopqrst";
    const previewUrl = `https://preview.njpbs.org/p/${queueId}/`;
    functionsMocks.cmsRequestSavedPreview.mockResolvedValue({ success: true, queueId, collection: "cmsPages", pageId: "home",
      pagePath: "/", status: "ready", sourceVersion: 7, rendererSha: "a".repeat(40), previewUrl });
    const replace = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue({ closed: false, document: document.implementation.createHTMLDocument(),
      opener: null, close: vi.fn(), location: { replace } } as unknown as Window);
    try {
      render(<ContentTab canArchiveLibrary principal={adminPrincipal} previewConfigured
        surface={{ kind: "page", pageId: "home", section: "home" }} />);
      await screen.findByDisplayValue("Existing headline", {}, { timeout: 5000 });
      const toggle = screen.getAllByRole("button", { name: "Preview" }).find(button => button.hasAttribute("aria-expanded"))!;
      if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
      fireEvent.click(screen.getAllByRole("button", { name: "Preview" }).find(button => !button.hasAttribute("aria-expanded"))!);
      await waitFor(() => expect(replace).toHaveBeenCalledWith(previewUrl));
      expect(fetch).toHaveBeenCalledWith("https://preview.njpbs.org/__cms-session", expect.objectContaining({ method: "POST" }));
      expect(functionsMocks.cmsRequestSavedPreview).toHaveBeenCalledWith("id-token", "cmsPages", "home", 7);
    } finally { open.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("keeps a contributor's submitted page composition and metadata read-only", async () => {
    mockFoundContent({
      id: "home",
      blocks: [storedHeadline],
      createdBy: "c",
      status: "in_review",
      title: "Home",
      version: 3,
    });

    render(
      <ContentTab
        principal={siteWideContributor}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    expect(await screen.findByDisplayValue("Existing headline")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save page" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save metadata" }),
    ).toBeDisabled();
    expect(
      screen.getAllByText(/select edit before changing reviewed content/i),
    ).not.toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    expect(functionsMocks.cmsSaveContent).not.toHaveBeenCalled();
  });

  it("hydrates and partially saves grouped page metadata without sending blocks", async () => {
    mockFoundContent({
      id: "home",
      blocks: [storedHeadline],
      version: 3,
      title: "Home",
      description: "Public media for New Jersey.",
      seo: {
        title: "NJ PBS Home",
        description: "Watch, learn, and support.",
        noindex: false,
      },
      social: {
        title: "NJ PBS",
        description: "New Jersey public media.",
        imageAssetId: "hero-1",
      },
    });
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPages",
      id: "home",
      created: false,
      document: {
        id: "home",
        blocks: [storedHeadline],
        version: 4,
        title: "Home",
        description: "Public media for New Jersey.",
        seo: {
          title: "NJ PBS: Watch and Learn",
          description: "Watch, learn, and support.",
          noindex: false,
        },
        social: {
          title: "NJ PBS",
          description: "New Jersey public media.",
          imageAssetId: "hero-1",
        },
      },
    });

    render(
      <ContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    expect(
      await screen.findByRole("group", { name: "Search" }, { timeout: 10_000 }),
    ).toBeTruthy();
    expect(screen.getByRole("article", { name: "Title and summary" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Social sharing" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Basics" })).toBeNull();
    expect(screen.getByDisplayValue("NJ PBS Home")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search title"), {
      target: { value: "NJ PBS: Watch and Learn" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));

    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({
      collection: "cmsPages",
      id: "home",
      baseVersion: 3,
      document: {
        template: "home",
        title: "Home",
        description: "Public media for New Jersey.",
        seo: {
          title: "NJ PBS: Watch and Learn",
          description: "Watch, learn, and support.",
          noindex: false,
        },
        social: {
          title: "NJ PBS",
          description: "New Jersey public media.",
          imageAssetId: "hero-1",
        },
      },
    });
    expect(
      functionsMocks.cmsSaveContent.mock.calls[0]![1].document.blocks,
    ).toBeUndefined();
  }, 20_000);

  it("keeps two pages that share a template on distinct stored documents", async () => {
    mockFoundContent({ id: "watch", blocks: [], template: "programLanding" });
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPages",
      id: "watch",
      created: false,
      document: { id: "watch", blocks: [], template: "programLanding" },
    });

    render(
      <ContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    expect(await screen.findByRole("button", { name: "Add content: position 1" })).toBeTruthy();
    expect(functionsMocks.cmsGetContent).toHaveBeenCalledWith("id-token", {
      collection: "cmsPages",
      id: "watch",
    });

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({
      collection: "cmsPages",
      id: "watch",
      document: { template: "programLanding", blocks: [] },
    });
  });

  it("seeds an unmigrated page from its legacy template document without saving back to it", async () => {
    functionsMocks.cmsGetContent
      .mockResolvedValueOnce({ success: true, found: false, document: null })
      .mockResolvedValueOnce({
        success: true,
        found: true,
        document: {
          id: "programLanding",
          blocks: [storedHeadline],
          version: 7,
          status: "published",
          title: "Legacy landing page",
          seo: { title: "Legacy SEO title" },
          published: { blocks: [storedHeadline], publishedBy: "legacy-editor" },
        },
      });
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPages",
      id: "watch",
      created: true,
      document: {
        id: "watch",
        blocks: [storedHeadline],
        template: "programLanding",
        version: 1,
      },
    });

    render(
      <ContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    expect(await screen.findByDisplayValue("Existing headline")).toBeTruthy();
    expect(functionsMocks.cmsGetContent).toHaveBeenNthCalledWith(
      1,
      "id-token",
      {
        collection: "cmsPages",
        id: "watch",
      },
    );
    expect(functionsMocks.cmsGetContent).toHaveBeenNthCalledWith(
      2,
      "id-token",
      {
        collection: "cmsPages",
        id: "programLanding",
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({
      collection: "cmsPages",
      id: "watch",
      document: { template: "programLanding" },
      baseVersion: undefined,
      createOnly: true,
      seedFromLegacyPage: { id: "programLanding", version: 7 },
    });
  });

  it("does not offer a contributor a create that would clone a published legacy status", async () => {
    functionsMocks.cmsGetContent
      .mockResolvedValueOnce({ success: true, found: false, document: null })
      .mockResolvedValueOnce({
        success: true,
        found: true,
        document: {
          id: "programLanding",
          blocks: [storedHeadline],
          version: 7,
          status: "published",
        },
      });

    render(
      <ContentTab
        principal={siteWideContributor}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Save page" }),
    ).toBeDisabled();
    expect(
      screen.getAllByText(
        /publish access is required to create this page from its legacy content/i,
      ),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    expect(functionsMocks.cmsSaveContent).not.toHaveBeenCalled();
  });

  it("creates an absent page without an unreadable legacy seed", async () => {
    functionsMocks.cmsGetContent
      .mockResolvedValueOnce({ success: true, found: false, document: null })
      .mockRejectedValueOnce(
        new HttpError(403, "You do not have permission to read this record."),
      );
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPages",
      id: "watch",
      created: true,
      document: {
        id: "watch",
        blocks: [],
        template: "programLanding",
        version: 1,
      },
    });

    render(
      <ContentTab
        principal={siteWideContributor}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Save page" }),
    ).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Watch NJ PBS", level: 1 })).toBeTruthy();
    expect(functionsMocks.cmsGetContent).toHaveBeenNthCalledWith(
      2,
      "id-token",
      {
        collection: "cmsPages",
        id: "programLanding",
      },
    );
    expect(
      screen.queryByText("You do not have permission to edit this page."),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({
      collection: "cmsPages",
      id: "watch",
      createOnly: true,
      seedFromLegacyPage: undefined,
    });
  });

  it("creates an absent page without a deleted legacy seed", async () => {
    functionsMocks.cmsGetContent
      .mockResolvedValueOnce({ success: true, found: false, document: null })
      .mockRejectedValueOnce(
        new HttpError(404, "This record is no longer available."),
      );
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPages",
      id: "watch",
      created: true,
      document: {
        id: "watch",
        blocks: [],
        template: "programLanding",
        version: 1,
      },
    });

    render(
      <ContentTab
        principal={siteWideContributor}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    expect(await screen.findByRole("button", { name: "Save page" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Watch NJ PBS", level: 1 })).toBeTruthy();
    expect(screen.queryByText("This page is no longer available.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({
      collection: "cmsPages",
      id: "watch",
      createOnly: true,
      seedFromLegacyPage: undefined,
    });
  });

  it("keeps transient optional legacy-seed failures retryable", async () => {
    functionsMocks.cmsGetContent
      .mockResolvedValueOnce({ success: true, found: false, document: null })
      .mockRejectedValueOnce(
        new HttpError(503, "Firestore is temporarily unavailable."),
      );

    render(
      <ContentTab
        principal={siteWideContributor}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The page could not be loaded. Reload to try again.",
    );
    expect(screen.queryByRole("button", { name: "Save page" })).toBeNull();
  });

  it("refuses to open a page stored against a different editor template", async () => {
    mockFoundContent({ id: "watch", blocks: [], template: "genericPage" });

    render(
      <ContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /saved editor template does not match the live-page registry/i,
    );
    expect(screen.queryByRole("button", { name: "Save page" })).toBeNull();
  });

  it("starts a never-created Home page with hero text defaults and no implied block frame", async () => {
    mockMissingContent();
    render(<ContentTab principal={editor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Home page" }, { timeout: 5_000 }));

    expect(
      await screen.findByRole("button", { name: "Add block: position 1" }),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("Home")).toBeTruthy();
    expect(screen.getByLabelText(/^Hero heading/)).toHaveValue("Your NJ PBS support is still needed.");
    expect(screen.queryByDisplayValue("Featured on NJ PBS")).toBeNull();
  });

  it("hydrates a never-created Watch page from its current public composition", async () => {
    mockMissingContent();

    render(
      <ContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    // These controls have explicit accessible labels; avoid scanning the full preview tree.
    expect(await screen.findByLabelText("Edit Hero actions", { selector: "button" }, { timeout: 10_000 })).toBeVisible();
    expect(screen.getByLabelText("Edit Watch introduction", { selector: "button" })).toBeTruthy();
    expect(screen.getByLabelText("Edit Watch destinations", { selector: "button" })).toBeTruthy();
    expect(screen.getByLabelText("Edit PBS service note", { selector: "button" })).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Edit Hero actions", { selector: "button" }));
    expect(openComponentEditor().getByRole("button", { name: "Open PBS video portal" })).toBeTruthy();
    fireEvent.click(textButton("Done", document.querySelector<HTMLDialogElement>(".component-editor-dialog[open]")!));
    fireEvent.click(screen.getByLabelText("Edit Watch introduction", { selector: "button" }));
    expect(
      screen.getByDisplayValue(
        "Find NJ PBS programs, PBS series, full episodes, specials, and Passport video on demand.",
      ),
    ).toBeTruthy();
    fireEvent.click(textButton("Done", document.querySelector<HTMLDialogElement>(".component-editor-dialog[open]")!));
    fireEvent.click(screen.getByLabelText("Edit Watch destinations", { selector: "button" }));
    expect(screen.getByDisplayValue("Programs on demand")).toBeTruthy();
    expect(screen.getByDisplayValue("PBS Passport")).toBeTruthy();
    expect(screen.getByDisplayValue("Livestream")).toBeTruthy();
    expect(screen.getByDisplayValue("PBS app")).toBeTruthy();
    fireEvent.click(textButton("Done", document.querySelector<HTMLDialogElement>(".component-editor-dialog[open]")!));
    fireEvent.click(textButton("Outline"));
    expect(await screen.findByText("4 blocks in outline")).toHaveClass("sr-only");
  }, 20_000);

  it.each<{
    pageId: PublicPageId;
    title: string;
    primaryAction: string;
    distinctiveCard?: string;
    blockCount: number;
  }>([
    {
      pageId: "live",
      title: "PBS Livestream",
      primaryAction: "Open PBS livestream",
      distinctiveCard: "Open PBS player",
      blockCount: 6,
    },
    {
      pageId: "kids",
      title: "Kids",
      primaryAction: "Open PBS Kids",
      distinctiveCard: "PBS Kids games",
      blockCount: 5,
    },
    {
      pageId: "support",
      title: "Support NJ PBS",
      primaryAction: "Donate",
      distinctiveCard: "Passport access",
      blockCount: 5,
    },
    {
      pageId: "give",
      title: "Give to NJ PBS",
      primaryAction: "Donate through PBS",
      distinctiveCard: "PBS donation form",
      blockCount: 6,
    },
    {
      pageId: "passport",
      title: "NJ PBS Passport",
      primaryAction: "Find Passport access",
      distinctiveCard: "PBS Passport help",
      blockCount: 6,
    },
    {
      pageId: "about",
      title: "About NJ PBS",
      primaryAction: "Support NJ PBS",
      blockCount: 10,
    },
  ])(
    "hydrates a never-created $pageId page from its recognizable public composition",
    async ({ pageId, title, primaryAction, distinctiveCard, blockCount }) => {
      mockMissingContent();
      functionsMocks.cmsSaveContent.mockImplementation(
        async (
          _idToken: string,
          request: { document: { blocks: AdminBlock[] } },
        ) => ({
          success: true,
          collection: "cmsPages",
          id: pageId,
          created: true,
          document: {
            id: pageId,
            ...request.document,
            blocks: request.document.blocks.map((block, index) => ({
              ...block,
              id: `srv-${pageId}-${index}`,
            })),
            version: 1,
          },
        }),
      );

      render(
        <ContentTab
          principal={editor}
          surface={{ kind: "page", pageId, section: "programLanding" }}
        />,
      );

      // These controls have explicit accessible labels; avoid scanning the full preview tree.
      expect(await screen.findByLabelText("Edit Hero actions", { selector: "button" }, { timeout: 10_000 })).toBeVisible();
      expect(screen.getByDisplayValue(title)).toBeTruthy();
      // About's ten-plank preview has a separate editing-control case below;
      // keep this journey focused on its complete seeded save.
      if (pageId !== "about") {
        fireEvent.click(screen.getByLabelText("Edit Hero actions", { selector: "button" }));
        expect(openComponentEditor().getByRole("button", { name: primaryAction })).toBeTruthy();
        fireEvent.click(textButton("Done", document.querySelector<HTMLDialogElement>(".component-editor-dialog[open]")!));
      }
      if (distinctiveCard) {
        fireEvent.click(screen.getByLabelText(/^Edit .* destinations$/, { selector: "button" }));
        expect(screen.getByDisplayValue(distinctiveCard)).toBeTruthy();
        fireEvent.click(textButton("Done", document.querySelector<HTMLDialogElement>(".component-editor-dialog[open]")!));
      } else {
        expect(screen.queryByLabelText(/^Edit .* destinations$/, { selector: "button" })).not.toBeInTheDocument();
      }
      fireEvent.click(textButton("Outline"));
      expect(await screen.findByText(`${blockCount} blocks in outline`)).toHaveClass("sr-only");
      fireEvent.click(textButton("Save page"));
      await waitFor(() =>
        expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
      );
      expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({
        collection: "cmsPages",
        id: pageId,
        createOnly: true,
        document: {
          template: "programLanding",
          blocks: expect.arrayContaining([
            expect.objectContaining({ id: `tmp-seed-${pageId}-hero-actions` }),
          ]),
        },
      });
      expect(
        functionsMocks.cmsSaveContent.mock.calls[0]![1].document.blocks,
      ).toHaveLength(blockCount);
      expect(await screen.findByText("Saved.")).toBeTruthy();
    },
    20_000,
  );

  it("opens the seeded About hero actions for editing", async () => {
    mockMissingContent();
    render(<ContentTab principal={editor} surface={{ kind: "page", pageId: "about", section: "programLanding" }} />);
    expect(await screen.findByLabelText("Edit Hero actions", { selector: "button" }, { timeout: 10_000 })).toBeVisible();
    expect(screen.getByDisplayValue("About NJ PBS")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Edit Hero actions", { selector: "button" }));
    expect(openComponentEditor().getByRole("button", { name: "Support NJ PBS" })).toBeTruthy();
    fireEvent.click(textButton("Done", document.querySelector<HTMLDialogElement>(".component-editor-dialog[open]")!));
    expect(document.querySelector(".component-editor-dialog[open]")).toBeNull();
  });

  it("respects an intentionally empty saved Watch draft instead of reapplying its seed", async () => {
    mockFoundContent({
      id: "watch",
      blocks: [],
      template: "programLanding",
      version: 3,
    });

    render(
      <ContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    expect(await screen.findByRole("button", { name: "Add content: position 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit Hero actions" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open PBS video portal" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({
      collection: "cmsPages",
      id: "watch",
      baseVersion: 3,
      document: { template: "programLanding", blocks: [] },
    });
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1].seedFromLegacyPage).toBeUndefined();
  });

  it.each([
    ["live", "Open PBS livestream"],
    ["kids", "Open PBS Kids"],
    ["support", "Donate"],
    ["give", "Donate through PBS"],
    ["passport", "Find Passport access"],
    ["about", "Support NJ PBS"],
  ] as const)(
    "respects an intentionally empty saved %s draft instead of reapplying its seed",
    async (pageId, primaryAction) => {
      mockFoundContent({
        id: pageId,
        blocks: [],
        template: "programLanding",
        version: 3,
      });

      render(
        <ContentTab
          principal={editor}
          surface={{ kind: "page", pageId, section: "programLanding" }}
        />,
      );

      if (pageId === "live") {
        expect(await screen.findByRole("button", { name: "Add content: position 1" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Add content: position 1" }));
        const picker = screen.getByRole("dialog", { name: "Add content" });
        expect(within(picker).getByRole("button", { name: "Add row" })).toBeVisible();
        fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("button", { name: primaryAction })).toBeNull();
        return;
      }

      expect(await screen.findByRole("button", { name: "Add content: position 1" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Edit Hero actions" })).toBeNull();
      expect(screen.queryByRole("button", { name: primaryAction })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Save page" }));
      await waitFor(() =>
        expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
      );
      expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({
        collection: "cmsPages",
        id: pageId,
        baseVersion: 3,
        document: { template: "programLanding", blocks: [] },
      });
      expect(functionsMocks.cmsSaveContent.mock.calls[0]![1].seedFromLegacyPage).toBeUndefined();
    },
  );

  it("keeps seeded Watch metadata as a fallback after blocks are saved and honors explicit blanks", async () => {
    mockFoundContent({
      id: "watch",
      blocks: [storedHeadline],
      template: "programLanding",
      version: 2,
      description: "",
      seo: { title: "Saved search title" },
    });

    render(
      <ContentTab
        principal={editor}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    expect(await screen.findByDisplayValue("Existing headline")).toBeTruthy();
    expect(screen.getByLabelText("Page summary")).toHaveValue("");
    expect(screen.getByLabelText("Search title")).toHaveValue(
      "Saved search title",
    );
    expect(screen.getByLabelText("Search description")).toHaveValue(
      "Browse NJ PBS programs and PBS series on demand.",
    );
  });

  it("translates a capability refusal into a permission message, not a load error", async () => {
    functionsMocks.cmsGetContent.mockRejectedValue(
      new HttpError(403, "You do not have permission to read this record."),
    );
    render(<ContentTab principal={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Home page" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "You do not have permission to edit this page.",
    );
    expect(alert).not.toHaveTextContent("Reload to try again");
    // No editor is exposed, so a denied user cannot save over the stored page.
    expect(screen.queryByRole("button", { name: "Save page" })).toBeNull();
  });

  it("surfaces the authenticated endpoint's deleted-page 404 as unavailable", async () => {
    functionsMocks.cmsGetContent.mockRejectedValue(
      new HttpError(404, "This record is no longer available."),
    );
    render(<ContentTab principal={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Home page" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This page is no longer available.");
    expect(alert).not.toHaveTextContent("Reload to try again");
    expect(screen.queryByRole("button", { name: "Save page" })).toBeNull();
  });

  it("keeps transient page endpoint failures retryable", async () => {
    functionsMocks.cmsGetContent.mockRejectedValue(
      new HttpError(503, "Firestore is temporarily unavailable."),
    );
    render(<ContentTab principal={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Home page" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The page could not be loaded. Reload to try again.",
    );
    expect(screen.queryByRole("button", { name: "Save page" })).toBeNull();
  });

  it("gives a denied record read an honest permission message", async () => {
    functionsMocks.cmsGetContent.mockRejectedValue(
      new HttpError(403, "You do not have permission to read this record."),
    );

    render(
      <MemoryRouter>
        <ContentTab
          principal={editor}
          surface={{ kind: "record", record: "event", id: "event-1" }}
        />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "You do not have permission to edit this record.",
    );
    expect(alert).not.toHaveTextContent("Reload to try again");
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("routes malformed stored blocks to the load-error state instead of crashing or wiping", async () => {
    // A stored value that fails block validation (drift or corruption). Mounting the editor on
    // it would crash on the bad shape; the read must refuse and route to the error state so a
    // save can never overwrite the stored page with an empty list.
    mockFoundContent({ id: "home", blocks: [null] });
    render(<ContentTab principal={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Home page" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Page editing unavailable");
    expect(alert).toHaveTextContent(
      /saved content can't be opened for editing/i,
    );
    expect(screen.queryByRole("button", { name: "Save page" })).toBeNull();
  });

  it("treats a non-array blocks value as invalid, not an empty page", async () => {
    // A non-array must not be silently read as an empty page (which a save would then persist
    // as [], wiping the stored content).
    mockFoundContent({ id: "home", blocks: "corrupt" });
    render(<ContentTab principal={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Home page" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /saved content can't be opened for editing/i,
    );
    expect(screen.queryByRole("button", { name: "Save page" })).toBeNull();
  });
});

describe("ContentTab records (cmsPosts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    functionsMocks.cmsListContent.mockResolvedValue(emptyLibrarySelection);
    functionsMocks.cmsBulkArchiveContent.mockResolvedValue({
      success: true,
      outcomes: [],
      counts: {
        archived: 0,
        already_archived: 0,
        conflict: 0,
        missing: 0,
        failed: 0,
      },
    });
  });

  it("loads the combined library through one authenticated server selection", async () => {
    render(
      <MemoryRouter initialEntries={["/content/library"]}>
        <ContentTab principal={siteWideEditor} surface={{ kind: "library" }} />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "All content" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(functionsMocks.cmsListContent).toHaveBeenCalledWith(
        "id-token",
        "status=draft&status=in_review&status=approved&status=scheduled&status=published&v=1",
      ),
    );
  });

  it("sends bulk archive through the authenticated version-guarded boundary", async () => {
    functionsMocks.cmsListContent.mockResolvedValue({
      ...emptyLibrarySelection,
      records: [
        {
          id: "post-1",
          kind: "post",
          title: "Shore report",
          status: "draft",
          version: 7,
        },
      ],
      total: 1,
      allCount: 1,
      mineCount: 1,
      statusCounts: { ...emptyLibrarySelection.statusCounts, draft: 1 },
    });
    functionsMocks.cmsBulkArchiveContent.mockResolvedValue({
      success: true,
      outcomes: [{ id: "post-1", status: "archived", version: 8 }],
      counts: {
        archived: 1,
        already_archived: 0,
        conflict: 0,
        missing: 0,
        failed: 0,
      },
    });
    render(
      <MemoryRouter initialEntries={["/content/library"]}>
        <ContentTab
          principal={adminPrincipal}
          canArchiveLibrary
          surface={{ kind: "library" }}
        />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: "Shore report" });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Shore report" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move selected to recycle bin" }));
    fireEvent.click(screen.getByRole("button", { name: "Move 1 record to Recycle bin" }));

    await waitFor(() =>
      expect(functionsMocks.cmsBulkArchiveContent).toHaveBeenCalledWith(
        "id-token",
        [{ id: "post-1", baseVersion: 7 }],
      ),
    );
  });

  it("does not offer bulk archive unless the admin-only backend boundary is confirmed", async () => {
    functionsMocks.cmsListContent.mockResolvedValue({
      ...emptyLibrarySelection,
      records: [
        {
          id: "post-1",
          kind: "post",
          title: "Shore report",
          status: "draft",
          version: 7,
        },
      ],
      total: 1,
      allCount: 1,
      statusCounts: { ...emptyLibrarySelection.statusCounts, draft: 1 },
    });
    render(
      <MemoryRouter initialEntries={["/content/library"]}>
        <ContentTab principal={siteWideEditor} surface={{ kind: "library" }} />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: "Shore report" });
    expect(
      screen.queryByRole("checkbox", { name: "Select Shore report" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Move selected to recycle bin" }),
    ).not.toBeInTheDocument();
    expect(functionsMocks.cmsBulkArchiveContent).not.toHaveBeenCalled();
  });

  it("lists one record type through the authenticated server selection", async () => {
    functionsMocks.cmsListContent.mockResolvedValue({
      ...emptyLibrarySelection,
      records: [
        {
          id: "spo-1",
          kind: "sponsor",
          title: "Acme Foundation",
          status: "draft",
          updatedAt: "2026-07-20T12:00:00.000Z",
        },
      ],
      total: 1,
      allCount: 1,
      pageCount: 1,
      statusCounts: { ...emptyLibrarySelection.statusCounts, draft: 1 },
    });

    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record-list", record: "sponsor" }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", { name: "Acme Foundation" }),
    ).toHaveAttribute("href", "/content/sponsor/spo-1/edit");
    expect(functionsMocks.cmsListContent).toHaveBeenCalledWith(
      "id-token",
      "type=sponsor&v=1",
    );
  });

  it("browses a typed record list one bounded page at a time", async () => {
    functionsMocks.cmsListContent.mockResolvedValue({
      ...emptyLibrarySelection,
      records: [
        {
          id: "spo-1",
          kind: "sponsor",
          title: "First sponsor",
          status: "draft",
        },
        {
          id: "spo-2",
          kind: "sponsor",
          title: "Second sponsor",
          status: "draft",
        },
      ],
      total: 2,
      allCount: 2,
    });

    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record-list", record: "sponsor" }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", { name: "First sponsor" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Second sponsor" })).toBeTruthy();
    expect(functionsMocks.cmsListContent).toHaveBeenCalledTimes(1);
    // The typed list rides the same paged, server-authorized query contract as the library.
    expect(functionsMocks.cmsListContent).toHaveBeenCalledWith(
      "id-token",
      "type=sponsor&v=1",
    );
  });

  it("asks the server for the typed page the URL addresses", async () => {
    functionsMocks.cmsListContent.mockResolvedValue({
      ...emptyLibrarySelection,
      records: [
        {
          id: "spo-51",
          kind: "sponsor",
          title: "Third page sponsor",
          status: "draft",
        },
      ],
      total: 63,
      allCount: 63,
      page: 3,
      pageCount: 3,
    });

    render(
      <MemoryRouter initialEntries={["/content/sponsor?page=3&v=1"]}>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record-list", record: "sponsor" }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", { name: "Third page sponsor" }),
    ).toBeTruthy();
    expect(functionsMocks.cmsListContent).toHaveBeenCalledWith(
      "id-token",
      "type=sponsor&page=3&v=1",
    );
    expect(screen.getByText("Page 3 of 3")).toBeTruthy();
  });

  it("shows a retryable list error separately from an empty list", async () => {
    functionsMocks.cmsListContent
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ...emptyLibrarySelection,
        records: [
          {
            id: "spo-1",
            kind: "sponsor",
            title: "Acme Foundation",
            status: "draft",
          },
        ],
        total: 1,
        allCount: 1,
      });
    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record-list", record: "sponsor" }}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The sponsor list could not be loaded",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Try loading sponsors again" }),
    );
    expect(
      await screen.findByRole("link", { name: "Acme Foundation" }),
    ).toBeTruthy();
  });

  it("shows the capability denial returned by the record-list boundary", async () => {
    functionsMocks.cmsListContent.mockRejectedValue(
      new HttpError(403, "You do not have permission to list content."),
    );
    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record-list", record: "sponsor" }}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You do not have permission to list content.",
    );
  });

  it("hydrates an addressed record, saves against its version, and adopts the next version", async () => {
    mockFoundContent({
      id: "spo-1",
      type: "sponsor",
      version: 3,
      name: "Acme Foundation",
      href: "https://acme.org",
    });
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPosts",
      id: "spo-1",
      created: false,
      document: {
        id: "spo-1",
        type: "sponsor",
        version: 4,
        name: "Acme Foundation",
        href: "https://acme.org",
      },
    });

    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record", record: "sponsor", id: "spo-1" }}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByDisplayValue("Acme Foundation")).toBeTruthy();
    expect(functionsMocks.cmsGetContent).toHaveBeenCalledWith("id-token", {
      collection: "cmsPosts",
      id: "spo-1",
    });
    expect(firestoreMocks.getDoc).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1]).toMatchObject({
      collection: "cmsPosts",
      id: "spo-1",
      baseVersion: 3,
    });
    expect(
      functionsMocks.cmsSaveContent.mock.calls[0]![1].document.version,
    ).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[1]![1].baseVersion).toBe(4);
  });

  it.each([
    ["post-no-build-v1", "The public site has not confirmed this version yet; no public build is needed."],
    ["public-context-no-build-v1", "The public site has not confirmed this version yet; no public build is needed."],
    ["release-pair-publication-v2", "The public site has not confirmed this version yet; no public build is needed."],
    ["serializer", "The saved version is queued for a public build."],
  ] as const)("retains the accepted %s transport in publication feedback", async (transport, message) => {
    const document = { id: "post-1", type: "post", version: 6, status: "approved",
      createdBy: "e", section: "news", title: "Garden State update",
      date: "2026-09-03", tags: [], blocks: [] };
    mockFoundContent(document);
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true, collection: "cmsPosts", id: "post-1", created: false,
      document: { ...document, status: "published", version: 7 },
      publication: { queueId: "operation-1", dispatched: false, status: "pending", transport },
    });
    render(<MemoryRouter><SuccessNoticeProvider routeKey="post-1"><ContentTab principal={siteWideEditor}
      surface={{ kind: "record", record: "post", id: "post-1" }} /></SuccessNoticeProvider></MemoryRouter>);
    await screen.findByRole("textbox", { name: /Post title/ });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText(`Publication requested. ${message}`)).toBeVisible();
    expect(functionsMocks.cmsPublish).not.toHaveBeenCalled();
  });

  it("keeps a confirmed pair publication out of the full-build fallback message", async () => {
    const document = { id: "post-1", type: "post", version: 6, status: "approved", createdBy: "e", section: "news",
      title: "Garden State update", date: "2026-09-03", tags: [], blocks: [] };
    mockFoundContent(document);
    functionsMocks.cmsSaveContent.mockResolvedValue({ success: true, collection: "cmsPosts", id: "post-1", created: false,
      document: { ...document, status: "published", version: 7 } });
    functionsMocks.cmsPublish.mockResolvedValue({ success: true, queueId: "pair-operation", dispatched: false, status: "success",
      transport: "release-pair-publication-v2", message: "Publication confirmed.",
      publicReceipt: { status: "confirmed", label: "Garden State update" } });
    render(<MemoryRouter><SuccessNoticeProvider routeKey="post-1"><ContentTab principal={siteWideEditor}
      surface={{ kind: "record", record: "post", id: "post-1" }} /></SuccessNoticeProvider></MemoryRouter>);
    await screen.findByRole("textbox", { name: /Post title/ });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("The saved version is published. Garden State update is confirmed on the public site; no public build was needed.")).toBeVisible();
    expect(functionsMocks.cmsPublish).toHaveBeenCalledOnce();
  });

  it.each([
    new HttpError(409, "Public deployment coordination is inactive.", {
      code: "media_publication_unavailable",
    }),
    new HttpError(500, "Publication service unavailable."),
    new TypeError("Failed to fetch"),
  ])("keeps a post-save publication failure visible with a reload action: %s", async (error) => {
    mockFoundContent({
      id: "post-1",
      type: "post",
      version: 6,
      status: "approved",
      createdBy: "e",
      section: "news",
      title: "Garden State update",
      date: "2026-09-03",
      tags: [],
      blocks: [],
    });
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPosts",
      id: "post-1",
      created: false,
      document: {
        id: "post-1",
        type: "post",
        version: 7,
        status: "published",
        title: "Garden State update",
        date: "2026-09-03",
        tags: [],
        blocks: [],
      },
    });
    functionsMocks.cmsPublish.mockRejectedValueOnce(error);

    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record", record: "post", id: "post-1" }}
        />
      </MemoryRouter>,
    );
    await screen.findByRole("textbox", { name: /Post title/ });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(
      await screen.findByText(
        `The version was saved as published, but its public update was not confirmed. ${error.message}`,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Reload published version" }),
    ).toBeVisible();
    expect(functionsMocks.cmsGetContent).toHaveBeenCalledOnce();
  });

  it("does not offer a record image picker to a contributor without media access", async () => {
    mockFoundContent({
      id: "post-1",
      type: "post",
      version: 2,
      createdBy: "c",
      title: "Garden State update",
      date: "2026-07-24",
      tags: [],
      blocks: [],
      heroImage: "asset-garden",
      heroImageAlt: "A reporter at the NJ PBS newsroom desk.",
      heroImageDecorative: false,
    });

    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideContributor}
          surface={{ kind: "record", record: "post", id: "post-1" }}
        />
      </MemoryRouter>,
    );

    const heroImage = await screen.findByRole("group", {
      name: "Hero image",
    }, { timeout: 5000 });
    expect(within(heroImage).queryByPlaceholderText("Asset id")).toBeNull();
    expect(
      within(heroImage).queryByRole("button", {
        name: /^(?:Choose|Change|Remove) lead image$/,
      }),
    ).toBeNull();
    expect(
      within(heroImage).getAllByText(
        "Media access is required to change this image.",
      ),
    ).toHaveLength(2);
    expect(functionsMocks.cmsListMedia).not.toHaveBeenCalled();
  });

  it("uploads a Post body image through the authenticated media boundary", async () => {
    const bodyImage: AdminBlock = {
      id: "image-1",
      type: "image",
      order: 0,
      visible: true,
      data: {
        assetId: "",
        alt: "",
        altDecorative: true,
        caption: "Unsaved caption",
      },
    };
    const asset = {
      id: "asset-field-report",
      name: "Field report",
      originalName: "field-report.png",
      category: "news",
      tags: [],
      description: null,
      altText: "A reporter interviewing a guest outdoors",
      license: "NJ PBS owned",
      credit: null,
      mimeType: "image/png",
      kind: "image" as const,
      sizeBytes: 2_048,
      width: 1_600,
      height: 900,
      url: "https://media.njpbs.org/field-report.png",
      lifecycle: "active" as const,
      version: 1,
      etag: '"media.YXNzZXQtZmllbGQtcmVwb3J0.1"',
      createdAt: "2026-08-19T12:00:00.000Z",
      createdBy: "e",
      updatedAt: "2026-08-19T12:00:00.000Z",
      updatedBy: "e",
    };
    mockFoundContent({
      id: "post-1",
      type: "post",
      version: 2,
      title: "Garden State update",
      date: "2026-08-19",
      tags: [],
      blocks: [bodyImage],
    });
    functionsMocks.cmsListMedia.mockResolvedValue({
      success: true,
      records: [asset],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    });
    functionsMocks.cmsUploadMedia.mockResolvedValue({
      success: true,
      asset,
    });

    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record", record: "post", id: "post-1" }}
        />
      </MemoryRouter>,
    );

    const imageRegion = await screen.findByRole(
      "region",
      { name: "image" },
      { timeout: 10_000 },
    );
    const editImage = within(imageRegion).getByRole("button", { name: "Edit image 1" });
    await waitFor(() => expect(editImage).toBeEnabled());
    fireEvent.click(editImage);
    fireEvent.click(
      within(imageRegion).getByRole("button", { name: "Choose image" }),
    );
    await screen.findByRole("button", { name: /^Field report/ });
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload image" }),
    );
    const file = new File(["image bytes"], "field-report.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText(/File/), {
      target: { files: [file] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );

    expect(await screen.findByDisplayValue("Field report")).toBeVisible();
    expect(screen.getByDisplayValue("Unsaved caption")).toBeVisible();
    expect(functionsMocks.cmsUploadMedia).toHaveBeenCalledWith(
      "id-token",
      file,
      expect.objectContaining({
        category: "news",
        license: "NJ PBS owned",
      }),
      expect.any(AbortSignal),
    );
  });

  it("shows event times without discarding stored instants on an unrelated save", async () => {
    const description = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Community screening details." }],
        },
      ],
    };
    mockFoundContent({
      id: "event-1",
      type: "event",
      version: 2,
      title: "Community screening",
      startsAt: {
        _seconds: Date.parse("2026-08-01T17:00:00.000Z") / 1_000,
        _nanoseconds: 0,
      },
      endsAt: {
        _seconds: Date.parse("2026-08-01T19:00:00.000Z") / 1_000,
        _nanoseconds: 0,
      },
      description,
    });
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPosts",
      id: "event-1",
      created: false,
      document: {
        id: "event-1",
        type: "event",
        version: 3,
        title: "Updated community screening",
        startsAt: "2026-08-01T17:00:00.000Z",
        endsAt: "2026-08-01T19:00:00.000Z",
        description,
      },
    });

    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record", record: "event", id: "event-1" }}
        />
      </MemoryRouter>,
    );
    // A JSON-serialized Timestamp reaches the control as station-local wall time, so an
    // editor sees 1 PM to 3 PM rather than a bare day with the hours hidden.
    expect(
      (await screen.findByLabelText(/^Starts/)) as HTMLInputElement,
    ).toHaveValue("2026-08-01T13:00");
    expect(
      (await screen.findByLabelText(/^Ends/)) as HTMLInputElement,
    ).toHaveValue("2026-08-01T15:00");
    fireEvent.change(await screen.findByLabelText(/^Title/), {
      target: { value: "Updated community screening" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    expect(
      functionsMocks.cmsSaveContent.mock.calls[0]![1].document,
    ).toMatchObject({
      startsAt: "2026-08-01T17:00:00.000Z",
      endsAt: "2026-08-01T19:00:00.000Z",
    });
  });

  it("migrates a space-separated legacy post date on an unrelated save", async () => {
    const date = "2026-07-24 23:30:00-04:00";
    mockFoundContent({
      id: "post-1",
      type: "post",
      version: 2,
      title: "Garden State update",
      date,
      blocks: [],
    });
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPosts",
      id: "post-1",
      created: false,
      document: {
        id: "post-1",
        type: "post",
        version: 3,
        title: "Updated Garden State update",
        date: "2026-07-24",
        blocks: [],
      },
    });

    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record", record: "post", id: "post-1" }}
        />
      </MemoryRouter>,
    );
    expect(
      (await screen.findByLabelText(/^Editorial date shown with the post/)) as HTMLInputElement,
    ).toHaveValue("2026-07-24");
    fireEvent.change(await screen.findByRole("textbox", { name: "Post title" }), {
      target: { value: "Updated Garden State update" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1].document.date).toBe(
      "2026-07-24",
    );
  });

  it("reviews the latest saved record before explicitly saving the local edits at that exact version", async () => {
    mockFoundContent({
      id: "spo-1",
      type: "sponsor",
      version: 3,
      name: "Acme Foundation",
      href: "https://acme.org",
    });
    functionsMocks.cmsSaveContent
      .mockRejectedValueOnce(
        new HttpError(409, "This document changed since you opened it."),
      )
      .mockResolvedValueOnce({
        success: true,
        collection: "cmsPosts",
        id: "spo-1",
        created: false,
        document: {
          id: "spo-1",
          type: "sponsor",
          version: 5,
          name: "Acme Foundation",
          href: "https://acme.org",
        },
      });

    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record", record: "sponsor", id: "spo-1" }}
        />
      </MemoryRouter>,
    );
    await screen.findByDisplayValue("Acme Foundation");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(
      await screen.findByText(
        /Someone else saved this record while you were editing it/,
      ),
    ).toBeTruthy();

    mockFoundContent({ id: "spo-1", type: "sponsor", version: 4, name: "Another editor's title", href: "https://acme.org" });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    );
    const review = await screen.findByRole("dialog", { name: "This content changed while you were editing" });
    expect(within(review).getByText("Another editor's title")).toBeTruthy();
    expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue("Acme Foundation")).toBeTruthy();
    fireEvent.click(within(review).getByRole("button", { name: "Save my changes over this version" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );
    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1].baseVersion).toBe(3);
    expect(
      functionsMocks.cmsSaveContent.mock.calls[1]![1].baseVersion,
    ).toBe(4);
  });

  it.each(["draft", "published"] as const)("keeps local Post text when the latest %s became a live blog", async location => {
    const original = { id: "post-1", type: "post", title: "Original Post", date: "2026-11-04", status: "draft", blocks: [], version: 3 };
    mockFoundContent(original);
    functionsMocks.cmsSaveContent.mockRejectedValue(new HttpError(409, "This document changed since you opened it.", { versionConflict: true }));
    render(<MemoryRouter><ContentTab principal={siteWideEditor} surface={{ kind: "record", record: "post", id: "post-1" }} /></MemoryRouter>);
    fireEvent.change(await screen.findByRole("textbox", { name: "Post title" }), { target: { value: "Local Post words to keep" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/Someone else saved this record/);
    const liveBlog = { state: "open", entries: [] };
    mockFoundContent({ ...original, version: 4, ...(location === "draft" ? { liveBlog } : { published: { metadata: { liveBlog } } }) });
    fireEvent.click(screen.getByRole("button", { name: "Save anyway, overwriting their changes" }));
    await screen.findByText(/This content needs to be reopened before saving/);
    expect(screen.getByRole("textbox", { name: "Post title" })).toHaveValue("Local Post words to keep");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1);
  });

  it("keeps record text after canceling review and after another writer wins during review", async () => {
    mockFoundContent({ id: "spo-1", type: "sponsor", version: 3, name: "Original name", href: "https://acme.org" });
    functionsMocks.cmsSaveContent.mockRejectedValue(new HttpError(409, "This document changed since you opened it.", { versionConflict: true }));
    render(<MemoryRouter><ContentTab principal={siteWideEditor} surface={{ kind: "record", record: "sponsor", id: "spo-1" }} /></MemoryRouter>);
    fireEvent.change(await screen.findByDisplayValue("Original name"), { target: { value: "Local words to keep" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/Someone else saved this record/);
    mockFoundContent({ id: "spo-1", type: "sponsor", version: 4, name: "Remote name", href: "https://acme.org" });
    fireEvent.click(screen.getByRole("button", { name: "Save anyway, overwriting their changes" }));
    let review = await screen.findByRole("dialog");
    fireEvent.click(within(review).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByDisplayValue("Local words to keep")).toBeTruthy();
    expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save anyway, overwriting their changes" }));
    review = await screen.findByRole("dialog");
    fireEvent.click(within(review).getByRole("button", { name: "Save my changes over this version" }));
    await waitFor(() => expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2));
    expect(functionsMocks.cmsSaveContent.mock.calls[1]![1]).toMatchObject({ baseVersion: 4, document: { name: "Local words to keep" } });
    expect(await screen.findByDisplayValue("Local words to keep")).toBeTruthy();
    expect(screen.getByText(/Someone else saved this record/)).toBeTruthy();
    mockFoundContent({ id: "spo-1", type: "sponsor", version: 5, name: "Newer remote name", href: "https://acme.org" });
    fireEvent.click(screen.getByRole("button", { name: "Save anyway, overwriting their changes" }));
    review = await screen.findByRole("dialog");
    expect(within(review).getByText("Newer remote name")).toBeTruthy();
    fireEvent.click(within(review).getByRole("button", { name: "Save my changes over this version" }));
    await waitFor(() => expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(3));
    expect(functionsMocks.cmsSaveContent.mock.calls[2]![1].baseVersion).toBe(5);
  });

  it("does not offer a review or write after the editor closes during the fresh read", async () => {
    mockFoundContent({ id: "spo-1", type: "sponsor", version: 3, name: "Local name", href: "https://acme.org" });
    functionsMocks.cmsSaveContent.mockRejectedValue(new HttpError(409, "This document changed since you opened it."));
    const view = render(<MemoryRouter><ContentTab principal={siteWideEditor} surface={{ kind: "record", record: "sponsor", id: "spo-1" }} /></MemoryRouter>);
    await screen.findByDisplayValue("Local name");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/Someone else saved this record/);
    let resolveRead!: (value: unknown) => void;
    functionsMocks.cmsGetContent.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Save anyway, overwriting their changes" }));
    await waitFor(() => expect(resolveRead).toBeTypeOf("function"));
    view.unmount();
    await act(async () => { resolveRead({ success: true, found: true, document: { type: "sponsor", name: "Remote", version: 4 } }); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit legacy-zero claim through record conflict recovery", async () => {
    mockFoundContent({ id: "spo-1", type: "sponsor", name: "Legacy sponsor", href: "https://acme.org" });
    functionsMocks.cmsSaveContent.mockRejectedValueOnce(new HttpError(409, "This document changed since you opened it."))
      .mockResolvedValueOnce({ success: true, document: { id: "spo-1", type: "sponsor", name: "Legacy sponsor", href: "https://acme.org", version: 1 } });
    render(<MemoryRouter><ContentTab principal={siteWideEditor} surface={{ kind: "record", record: "sponsor", id: "spo-1" }} /></MemoryRouter>);
    await screen.findByDisplayValue("Legacy sponsor");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/Someone else saved this record/);
    fireEvent.click(screen.getByRole("button", { name: "Save anyway, overwriting their changes" }));
    const review = await screen.findByRole("dialog");
    fireEvent.click(within(review).getByRole("button", { name: "Save my changes over this version" }));
    await waitFor(() => expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2));
    expect(functionsMocks.cmsSaveContent.mock.calls.map(call => call[1].baseVersion)).toEqual([0, 0]);
  });

  it.each([
    ["missing", { success: true, found: false, document: null }],
    [
      "wrong type",
      {
        success: true,
        found: true,
        document: { id: "spo-1", type: "article" },
      },
    ],
  ])(
    "never exposes a save form for a %s addressed record",
    async (_case, response) => {
      functionsMocks.cmsGetContent.mockResolvedValue(response);
      render(
        <MemoryRouter>
          <ContentTab
            principal={siteWideEditor}
            surface={{ kind: "record", record: "sponsor", id: "spo-1" }}
          />
        </MemoryRouter>,
      );

      expect(
        await screen.findByText(
          /could not be found|was deleted|cannot be opened/i,
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    },
  );

  it("maps the authenticated endpoint's deleted-record 404 without exposing a save form", async () => {
    functionsMocks.cmsGetContent.mockRejectedValue(
      new HttpError(404, "This record is no longer available."),
    );
    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record", record: "sponsor", id: "spo-1" }}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/was deleted/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("keeps transient addressed-record endpoint failures retryable", async () => {
    functionsMocks.cmsGetContent.mockRejectedValue(
      new HttpError(503, "Firestore is temporarily unavailable."),
    );
    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record", record: "sponsor", id: "spo-1" }}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The record could not be loaded. Reload to try again.",
    );
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  // Every record create now has to name the desk it is created into (#845). The picker is
  // required and immutable afterwards, so a create-path test chooses one the same way an
  // editor does, and the assertions below check it leaves as the request envelope's
  // `section` rather than as a content field.
  function chooseRecordSection(section = "watch") {
    fireEvent.change(screen.getByLabelText(/^Area/), {
      target: { value: section },
    });
  }

  it("creates a record, adopts the server-minted id, and updates by it on the next save", async () => {
    // The record analogue of the page save loop. A record has no id on create, so the server
    // mints one; the client must adopt it so the next save updates that record instead of
    // creating a duplicate (#515 record-id adoption). Sponsor is the one kind with no rich-text
    // field, so it fills through plain inputs.
    functionsMocks.cmsSaveContent
      .mockResolvedValueOnce({
        success: true,
        collection: "cmsPosts",
        id: "spo-1",
        created: true,
        document: {
          id: "spo-1",
          type: "sponsor",
          name: "WNET",
          href: "https://www.wnet.org",
        },
      })
      .mockResolvedValueOnce({
        success: true,
        collection: "cmsPosts",
        id: "spo-1",
        created: false,
        document: {
          id: "spo-1",
          type: "sponsor",
          name: "WNET",
          href: "https://www.wnet.org",
        },
      });

    render(<ContentTab principal={siteWideEditor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "WNET" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://www.wnet.org" },
    });
    chooseRecordSection();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    // The create posts to cmsPosts with no id; the kind is stamped as the type discriminator,
    // and the client id (there is none yet) is addressed via the request id, never as a
    // content field.
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    const [idToken, createBody] = functionsMocks.cmsSaveContent.mock.calls[0]!;
    expect(idToken).toBe("id-token");
    expect(createBody.collection).toBe("cmsPosts");
    expect(createBody.id).toBeUndefined();
    expect(createBody.document).toMatchObject({
      type: "sponsor",
      name: "WNET",
      href: "https://www.wnet.org",
    });
    expect(createBody.document.id).toBeUndefined();
    // A create also carries a nonce the server derives the new id from (#542).
    expect(typeof createBody.idempotencyKey).toBe("string");
    // The chosen desk rides the envelope, never the document (#845). Sent as content it
    // would be stripped by the save boundary and the create refused for having no section.
    expect(createBody.section).toBe("watch");
    expect(createBody.document.section).toBeUndefined();
    expect(await screen.findByText("Saved.")).toBeTruthy();

    // Saving again reuses the adopted server id, so the second write updates rather than
    // minting a duplicate.
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );
    const updateBody = functionsMocks.cmsSaveContent.mock.calls[1]![1];
    expect(updateBody.collection).toBe("cmsPosts");
    expect(updateBody.id).toBe("spo-1");
    expect(updateBody.document).toMatchObject({ type: "sponsor" });
    expect(updateBody.document.id).toBeUndefined();
    // An update is addressed by its own id, so it must not carry a create nonce: the server
    // rejects the pair, and a nonce held past the create would address the wrong document.
    expect(updateBody.idempotencyKey).toBeUndefined();
    // A record's desk is fixed by the create. The update neither restates it nor offers a
    // new one, so an ordinary save can never move a record out of the desk that scopes it.
    expect(updateBody.section).toBeUndefined();
    expect(updateBody.document.section).toBeUndefined();
  });

  it("retries a failed record create under the same nonce", async () => {
    // The case #542 exists for. When the first attempt's response is lost the editor cannot tell
    // a write that never happened from one that did, so the retry has to reuse the nonce: the
    // server then lands it on the document the first attempt created rather than minting a
    // second copy of the same draft.
    functionsMocks.cmsSaveContent
      .mockRejectedValueOnce(new Error("Request failed with 500"))
      .mockResolvedValueOnce({
        success: true,
        collection: "cmsPosts",
        id: "spo-1",
        created: true,
        replayed: true,
        document: {
          id: "spo-1",
          type: "sponsor",
          name: "WNET",
          href: "https://www.wnet.org",
        },
      });

    render(<ContentTab principal={siteWideEditor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "WNET" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://www.wnet.org" },
    });
    chooseRecordSection();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1),
    );
    await screen.findByText("Request failed with 500");

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );

    const first = functionsMocks.cmsSaveContent.mock.calls[0]![1];
    const retry = functionsMocks.cmsSaveContent.mock.calls[1]![1];
    expect(typeof first.idempotencyKey).toBe("string");
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.id).toBeUndefined();
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("keeps a failed create nonce with its draft while another draft saves", async () => {
    functionsMocks.cmsSaveContent
      .mockRejectedValueOnce(new Error("Request failed with 500"))
      .mockResolvedValueOnce({
        success: true,
        collection: "cmsPosts",
        id: "post-1",
        created: true,
        document: {
          id: "post-1",
          type: "post",
          title: "Station update",
          date: "2026-08-06",
          blocks: [],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        collection: "cmsPosts",
        id: "spo-1",
        created: true,
        replayed: true,
        document: {
          id: "spo-1",
          type: "sponsor",
          name: "WNET",
          href: "https://www.wnet.org",
        },
      });

    render(<ContentTab principal={siteWideEditor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sponsor" }, { timeout: 10_000 }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "WNET" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://www.wnet.org" },
    });
    chooseRecordSection();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Request failed with 500");

    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Post title" }), {
      target: { value: "Station update" },
    });
    fireEvent.change(screen.getByLabelText(/^Editorial date shown with the post/), {
      target: { value: "2026-08-06" },
    });
    chooseRecordSection("station");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sponsor" }, { timeout: 10_000 }));
    expect(await screen.findByDisplayValue("WNET")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(3),
    );

    const sponsorAttempt = functionsMocks.cmsSaveContent.mock.calls[0]![1];
    const postAttempt = functionsMocks.cmsSaveContent.mock.calls[1]![1];
    const sponsorRetry = functionsMocks.cmsSaveContent.mock.calls[2]![1];
    expect(postAttempt.idempotencyKey).not.toBe(sponsorAttempt.idempotencyKey);
    expect(sponsorRetry.idempotencyKey).toBe(sponsorAttempt.idempotencyKey);
  }, 15_000);

  it("opens the saved record when a create replay finds an advanced version", async () => {
    functionsMocks.cmsSaveContent.mockRejectedValueOnce(
      Object.assign(
        new HttpError(
          409,
          "This record changed after it was created. Reload before saving it again.",
        ),
        {
          data: {
            conflict: "create-replay-advanced",
            recordId: "spo-1",
          },
        },
      ),
    );
    const onNavigateSurface = vi.fn();

    render(
      <MemoryRouter>
        <ContentTab
          principal={siteWideEditor}
          surface={{ kind: "record", record: "sponsor", id: null }}
          onNavigateSurface={onNavigateSurface}
        />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "WNET" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://www.wnet.org" },
    });
    chooseRecordSection();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open saved record, discarding this draft",
      }),
    );

    expect(onNavigateSurface).toHaveBeenCalledWith(
      { kind: "record", record: "sponsor", id: "spo-1" },
      { replace: true, committed: true },
    );
  });

  it("surfaces a rejected record save and does not confirm it as saved", async () => {
    // A server refusal must read as a failure the editor can retry from, not a silent success.
    functionsMocks.cmsSaveContent.mockRejectedValueOnce(
      new Error("Unknown record id (omit id to create)."),
    );

    render(<ContentTab principal={siteWideEditor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "WNET" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://www.wnet.org" },
    });
    chooseRecordSection();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(
      await screen.findByText("Unknown record id (omit id to create)."),
    ).toBeTruthy();
    expect(screen.queryByText("Saved.")).toBeNull();
  });
});

describe("ContentTab page version echo (#530, #563)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function storedPage(fields: Record<string, unknown>) {
    mockFoundContent({ id: "home", blocks: [storedHeadline], ...fields });
  }

  function savedPage(document: Record<string, unknown>) {
    functionsMocks.cmsSaveContent.mockResolvedValue({
      success: true,
      collection: "cmsPages",
      id: "home",
      created: false,
      document: { id: "home", blocks: [storedHeadline], ...document },
    });
  }

  async function openHomeAndSave() {
    render(<ContentTab principal={editor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Home page" }));
    await screen.findByDisplayValue("Existing headline");
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalled(),
    );
  }

  it("claims the version it read the page at", async () => {
    // The version has to come from the same response the blocks did, or the claim describes
    // content the person was never shown.
    storedPage({ version: 3 });
    savedPage({ version: 4 });
    await openHomeAndSave();

    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1].baseVersion).toBe(3);
  });

  it.each(["blocks", "metadata"] as const)("reviews the current Page before resubmitting local %s at its exact version", async panel => {
    storedPage({ version: 3, title: "Original title", seo: { title: "Original search title" } });
    functionsMocks.cmsSaveContent.mockRejectedValueOnce(new HttpError(409, "This document changed since you opened it."));
    render(<ContentTab principal={editor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Home page" }));
    await screen.findByDisplayValue("Existing headline");
    const field = panel === "blocks" ? screen.getByDisplayValue("Existing headline") : screen.getByLabelText("Search title");
    fireEvent.change(field, { target: { value: "Local text to keep" } });
    const action = panel === "blocks" ? "Save page" : "Save metadata";
    fireEvent.click(screen.getByRole("button", { name: action }));
    await screen.findByText(/Someone else saved this page/);
    const remoteBlocks = [{ ...storedHeadline, data: { ...storedHeadline.data, text: "Remote headline" } }];
    const current = { id: "home", version: 4, title: "Latest saved Page", blocks: remoteBlocks, seo: { title: "Remote search title" } };
    mockFoundContent(current);
    functionsMocks.cmsSaveContent.mockImplementationOnce(async (_token, body) => ({ success: true, document: { ...current, ...body.document, version: 5 } }));
    fireEvent.click(screen.getByRole("button", { name: "Save anyway, overwriting their changes" }));
    const review = await screen.findByRole("dialog");
    expect(within(review).getByText("Latest saved Page")).toBeTruthy();
    expect(within(review).getByText(panel === "blocks" ? "Content planks, text and media" : "Search title")).toBeTruthy();
    expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(1);
    fireEvent.click(within(review).getByRole("button", { name: "Save my changes over this version" }));
    await waitFor(() => expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2));
    const submitted = functionsMocks.cmsSaveContent.mock.calls[1]![1];
    expect(submitted.baseVersion).toBe(4);
    if (panel === "blocks") expect(submitted.document.blocks[0].data.text).toBe("Local text to keep");
    else expect(submitted.document.seo.title).toBe("Local text to keep");
    expect(await screen.findByDisplayValue("Local text to keep")).toBeTruthy();
  });


  it("explicitly claims zero for an existing legacy page stored without a version", async () => {
    storedPage({});
    savedPage({ version: 1 });
    await openHomeAndSave();

    expect(
      functionsMocks.cmsSaveContent.mock.calls[0]![1].baseVersion,
    ).toBe(0);
  });

  it("retains a legacy Page's zero claim after an unchanged save response", async () => {
    storedPage({});
    savedPage({});
    await openHomeAndSave();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save page" })).not.toBeDisabled());
    savedPage({ version: 1 });
    fireEvent.change(screen.getByDisplayValue("Existing headline"), { target: { value: "First legacy edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2));
    expect(functionsMocks.cmsSaveContent.mock.calls.map(call => call[1].baseVersion)).toEqual([0, 0]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // A malformed stored value never authorizes an unclaimed overwrite.
  //
  // A case each, not a loop: every one hydrates and saves a fresh studio, and five of those in
  // one test runs past Vitest's 5s default on a loaded runner.
  it.each([0, -1, 2.5, "3", null])(
    "does not claim a version that drifted out of the shape the server would accept (%j)",
    async (drifted) => {
      storedPage({ version: drifted });
      savedPage({ version: 1 });
      render(<ContentTab principal={editor} />);
      fireEvent.click(screen.getByRole("button", { name: "Home page" }));
      await screen.findByDisplayValue("Existing headline");
      fireEvent.click(screen.getByRole("button", { name: "Save page" }));
      await screen.findByText("The latest saved version could not be checked. Your edits are still here.");
      expect(functionsMocks.cmsSaveContent).not.toHaveBeenCalled();
    },
  );

  it("claims the version the save returned on the next save", async () => {
    storedPage({ version: 3 });
    savedPage({ version: 4 });
    await openHomeAndSave();

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() =>
      expect(functionsMocks.cmsSaveContent).toHaveBeenCalledTimes(2),
    );

    expect(functionsMocks.cmsSaveContent.mock.calls[0]![1].baseVersion).toBe(3);
    expect(functionsMocks.cmsSaveContent.mock.calls[1]![1].baseVersion).toBe(4);
  });

  it("turns the server's 409 into the conflict choice, end to end", async () => {
    // The whole point of the wiring: a real refusal from the real error shape reaches the
    // person as a question rather than as a save that quietly did not happen.
    storedPage({ version: 3 });
    functionsMocks.cmsSaveContent.mockRejectedValue(
      new HttpError(409, "This document changed since you opened it."),
    );
    render(<ContentTab principal={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Home page" }));
    await screen.findByDisplayValue("Existing headline");
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));

    expect(
      await screen.findByText(
        /Someone else saved this page while you were editing it/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save page" })).toBeDisabled();
  });
});
