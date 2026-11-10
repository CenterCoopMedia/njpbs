import { StrictMode } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
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
import {
  EditorWorkspace,
  type PageContent,
} from "../src/components/EditorWorkspace";
import { WorkspaceActionsProvider } from "../src/components/WorkspaceActions";
import { PublicContentStatusProvider } from "../src/context/PublicContentStatusContext";
import type { AdminBlock } from "../src/lib/block-factory";
import type {
  RecordKind,
  SectionId,
} from "../../packages/content-core/src/editor-admin";
import type { PublicPageId } from "../../packages/content-core/src/public-pages";
import type { Principal } from "../../packages/content-core/src/rbac";
import type {
  GetRevisionResponse,
  ListRevisionsResponse,
  RestoreRevisionResponse,
  TransitionContentResponse,
  BylineAuthorsResponse,
} from "../src/lib/functions";
import {
  EDITOR_LOCK_HEARTBEAT_MS,
  EDITOR_LOCK_LEASE_MS,
  type EditorLock,
  type EditorLockActor,
  type EditorLockClaim,
  type EditorLockClient,
} from "../src/lib/editor-locks";

// These flows include modal editing, save receipts, and surface navigation.
vi.setConfig({ testTimeout: 10_000 });

afterEach(cleanup);
// The bento arrangement persists to localStorage; clear it between tests so a rearrange in one
// test cannot leak its layout into the next.
afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    // No storage in this environment; nothing to clear.
  }
});

// A deterministic id generator so the page editor does not depend on crypto.randomUUID.
function counterIds() {
  let n = 0;
  return () => `b${++n}`;
}

function closeComponentEditor() {
  const dialog = screen.queryAllByRole("dialog").find(element => element.classList.contains("component-editor-dialog"));
  if (dialog) fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
}

function headingField() {
  const visible = screen.queryByRole("textbox", { name: "Heading" });
  if (visible) return visible;
  fireEvent.click(screen.getByRole("button", { name: /^Edit heading / }));
  return screen.getByRole("textbox", { name: "Heading" });
}

async function findHeadingField() {
  const visible = screen.queryByRole("textbox", { name: "Heading" });
  if (visible) return visible;
  fireEvent.click(await screen.findByRole("button", { name: /^Edit heading / }));
  return screen.getByRole("textbox", { name: "Heading" });
}

function clickWorkspaceAction(name: string) {
  closeComponentEditor();
  fireEvent.click(screen.getByRole("button", { name }));
}

function openInsertedBlock(name: string) {
  if (screen.queryAllByRole("dialog").some(element => element.classList.contains("component-editor-dialog"))) return;
  const edit = screen.getAllByRole("button", { name: new RegExp(`^Edit ${name} [0-9]+$`) }).at(-1)!;
  fireEvent.click(edit);
}

function addBlock(name: string) {
  closeComponentEditor();
  const contentTrigger = screen
    .queryAllByRole("button", { name: /^Add content(?:: position \d+)?$/ })
    .at(-1);
  if (contentTrigger) {
    const position = contentTrigger
      .getAttribute("aria-label")
      ?.match(/position (\d+)/)?.[1];
    fireEvent.click(contentTrigger);
    const picker = screen.getByRole("radiogroup", {
      name: position ? `Content types at position ${position}` : "Content types",
    });
    fireEvent.click(within(picker).getByRole("radio", { name }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));
    openInsertedBlock(name);
    return;
  }
  const trigger = screen
    .getAllByRole("button", { name: /Add block: position/ })
    .at(-1);
  if (!trigger) throw new Error("Missing block insertion control");
  const position = trigger
    .getAttribute("aria-label")
    ?.match(/position (\d+)/)?.[1];
  if (!position) throw new Error("Missing block insertion position");
  fireEvent.click(trigger);
  fireEvent.click(
    within(
      screen.getByRole("group", {
        name: `Blocks to insert at position ${position}`,
      }),
    ).getByRole("button", { name }),
  );
  openInsertedBlock(name);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

// CMS content records do not carry an editorial section yet, so the shipped studio admits
// site-wide grants. Use that real boundary for general editor behavior and reserve the scoped
// fixture for tests that deliberately prove an unsectioned resource is denied.
const editor: Principal = { id: "e", grants: [{ role: "editor" }] };
const scopedEditor: Principal = {
  id: "e",
  grants: [{ role: "editor", sections: ["news"] }],
};
const contributor: Principal = {
  id: "c",
  grants: [{ role: "contributor", sections: ["news"] }],
};
const siteWideEditor: Principal = { id: "e", grants: [{ role: "editor" }] };
const siteWideContributor: Principal = {
  id: "c",
  grants: [{ role: "contributor" }],
};
const readOnly: Principal = { id: "x", grants: [] };
const admin: Principal = { id: "admin", grants: [{ role: "admin" }] };

const lockActor: EditorLockActor = { id: "admin", name: "Al Admin" };

function courtesyLock(
  ownerId: string,
  ownerName: string,
  sessionId = "remote-session",
  heartbeatAtMs = Date.now(),
): EditorLock {
  return {
    surfaceKey: "cmsPages:home",
    ownerId,
    ownerName,
    sessionId,
    acquiredAtMs: heartbeatAtMs - 1_000,
    heartbeatAtMs,
    observedAtMs: globalThis.performance.now(),
  };
}

function fakeEditorLockClient(initialLock: EditorLock | null = null) {
  let current = initialLock;
  const listeners = new Set<(lock: EditorLock | null) => void>();
  const client: EditorLockClient = {
    subscribe: vi.fn((_surfaceKey, onLock) => {
      listeners.add(onLock);
      onLock(current);
      return () => listeners.delete(onLock);
    }),
    claim: vi.fn(async (surfaceKey, actor, sessionId, options) => {
      if (
        current &&
        options?.force !== true &&
        options?.observedStale !== true
      ) {
        return { status: "blocked" as const, lock: current };
      }
      const acquired: EditorLock = {
        surfaceKey,
        ownerId: actor.id,
        ownerName: actor.name,
        sessionId,
        acquiredAtMs: Date.now(),
        heartbeatAtMs: Date.now(),
        observedAtMs: globalThis.performance.now(),
      };
      current = acquired;
      for (const listener of listeners) listener(acquired);
      return { status: "acquired" as const, lock: acquired };
    }),
    heartbeat: vi.fn(async () => true),
    release: vi.fn(async (_surfaceKey, actorId, sessionId) => {
      const held = current;
      if (held && held.ownerId === actorId && held.sessionId === sessionId) {
        current = null;
        for (const listener of listeners) listener(null);
      }
    }),
    requestTakeover: vi.fn(async (_surfaceKey, requester, ownerSessionId) => {
      if (!current || current.sessionId !== ownerSessionId) return false;
      current = {
        ...current,
        request: { byId: requester.id, byName: requester.name, atMs: Date.now() },
      };
      for (const listener of listeners) listener(current);
      return true;
    }),
    clearRequest: vi.fn(async (_surfaceKey, actorId, sessionId) => {
      const held = current;
      if (!held || held.ownerId !== actorId || held.sessionId !== sessionId) return;
      const { request: _request, ...rest } = held;
      current = rest;
      for (const listener of listeners) listener(rest);
    }),
  };
  return {
    client,
    currentLock() {
      return current;
    },
    emit(lock: EditorLock | null) {
      current = lock;
      for (const listener of listeners) listener(lock);
    },
  };
}

describe("EditorWorkspace surfaces", () => {
  it("opens on the home page block editor with the isolated component picker", () => {
    // The home page is the default surface, so the inline block editor is what a person
    // sees on arrival rather than a form they have to leave. Opening on a record form hid
    // page composition behind a rail click nobody knew to make.
    render(<EditorWorkspace principal={editor} />);
    expect(
      screen.getByRole("button", { name: /^Add (?:block|content): position 1$/ }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Component surface picker")).toBeTruthy();
  });

  it.each([
    {
      label: "eligible scoped creator",
      principal: contributor,
      expected: true,
    },
    {
      label: "account without create authority",
      principal: readOnly,
      expected: false,
    },
  ])("shows Post duplication only to an $label", async ({ principal, expected }) => {
    const actionsTarget = document.createElement("div");
    document.body.append(actionsTarget);
    const duplicatePost = vi.fn();
    render(
      <MemoryRouter>
        <WorkspaceActionsProvider target={actionsTarget}>
          <EditorWorkspace
            principal={principal}
            duplicatePost={duplicatePost}
            loadRecord={async () => ({
              status: "ready",
              record: {
                id: "post-1",
                type: "post",
                title: "Station update",
                tags: [],
                blocks: [],
                status: "draft",
                version: 2,
                createdBy: "c",
                section: "news",
              },
            })}
            surface={{ kind: "record", record: "post", id: "post-1" }}
          />
        </WorkspaceActionsProvider>
      </MemoryRouter>,
    );

    await screen.findByRole("textbox", { name: "Post title" });
    if (expected) {
      fireEvent.click(await screen.findByRole("button", { name: "Post actions" }));
      expect(screen.getByRole("button", { name: "Duplicate post" })).toBeVisible();
    } else {
      expect(screen.getByText("Post actions", { selector: "summary" })).not.toBeVisible();
    }
    actionsTarget.remove();
  });

  it("switches to the event record form", () => {
    render(<EditorWorkspace principal={editor} />);
    clickWorkspaceAction("Event");
    // The event form's location field is present once its form is the surface.
    expect(screen.getByLabelText(/^Location/)).toBeTruthy();
  });

  it("puts a post title and editable body in the main writing column", async () => {
    const saveRecord = vi.fn(
      async (_kind: RecordKind, record: Record<string, unknown>) => ({
        ...record,
        id: "post-1",
        version: 1,
      }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        newId={counterIds()}
        saveRecord={saveRecord}
        surface={{ kind: "record", record: "post", id: null }}
      />,
    );

    const writingColumn = screen.getByRole("region", { name: "Main area" });
    expect(
      within(writingColumn).getByRole("textbox", { name: "Post title" }),
    ).toBeVisible();
    expect(
      within(writingColumn).getByRole("article", { name: "Post body" }),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Side panel" })).queryByRole(
        "article",
        { name: "Lifecycle" },
      ),
    ).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), {
      target: { value: "Garden State update" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Dates" }));
    fireEvent.change(screen.getByLabelText(/^Editorial date shown with the post/), {
      target: { value: "2026-08-14" },
    });
    addBlock("text");
    const body = screen.getByRole("textbox", { name: "Body" });
    await act(async () => {
      body.innerHTML = "<p>Local reporting from across New Jersey.</p>";
      fireEvent.input(body);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    clickWorkspaceAction("Save draft");

    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));
    expect(saveRecord.mock.calls[0]![1]).toMatchObject({
      title: "Garden State update",
      blocks: [expect.objectContaining({ type: "prose" })],
    });
  });

  it("keeps post workflow details in Publication and actions in the header", async () => {
    const actionsTarget = document.createElement("div");
    document.body.append(actionsTarget);
    const loadAssignableUsers = vi.fn(async () => [
      { id: "editor-2", label: "Evan Editor" },
    ]);
    const { container } = render(
      <MemoryRouter>
        <WorkspaceActionsProvider target={actionsTarget}>
          <EditorWorkspace
            canAssignRecords
            loadAssignableUsers={loadAssignableUsers}
            loadRecord={async () => ({
              status: "ready",
              record: {
                id: "post-1",
                type: "post",
                title: "Station update",
                date: "2026-08-13",
                tags: [],
                slug: "station-update",
                previousSlugs: [],
                locale: "en",
                status: "draft",
                version: 12,
                publiclyVisible: true,
                published: { sourceVersion: 8 },
              },
            })}
            principal={admin}
            surface={{ kind: "record", record: "post", id: "post-1" }}
            transitionContent={vi.fn()}
          />
        </WorkspaceActionsProvider>
      </MemoryRouter>,
    );

    const bento = await screen.findByRole("group", {
      name: "Post editor sections",
    });
    const writing = within(bento).getByRole("region", { name: "Main area" });
    const settings = within(bento).getByRole("region", { name: "Side panel" });
    const publication = within(settings).getByRole("article", {
      name: "Lifecycle",
    });
    expect(
      writing.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const editorialDate = within(settings).getByLabelText(
      /^Editorial date shown with the post/,
    );
    expect(editorialDate).not.toBeVisible();
    fireEvent.click(within(settings).getByRole("button", { name: "Dates" }));
    expect(editorialDate).toBeVisible();
    expect(
      within(publication).getByRole("combobox", {
        name: "Assigned staff member",
      }),
    ).toBeVisible();
    expect(within(publication).getByRole("heading", { name: "Lifecycle" })).toBeVisible();
    expect(within(publication).getByText("Version 12")).toBeVisible();
    expect(within(publication).getByText("A published copy was last recorded")).toBeVisible();
    expect(
      within(publication).getByText("Working version 12"),
    ).toBeVisible();
    expect(
      within(publication).queryByRole("button", { name: "Submit for review" }),
    ).toBeNull();
    fireEvent.click(within(actionsTarget).getByRole("button", { name: "Publishing" }));
    expect(screen.getByRole("button", { name: "Submit for review" })).toBeVisible();
    expect(container.querySelectorAll(".assignment-panel")).toHaveLength(1);
    expect(container.querySelectorAll(".lifecycle-actions")).toHaveLength(1);

    actionsTarget.remove();
  });

  it("reveals collapsed Publication before a header lifecycle confirmation", async () => {
    const actionsTarget = document.createElement("div");
    document.body.append(actionsTarget);
    render(
      <MemoryRouter>
        <WorkspaceActionsProvider target={actionsTarget}>
          <EditorWorkspace
            loadRecord={async () => ({
              status: "ready",
              record: {
                id: "post-1",
                type: "post",
                title: "Station update",
                date: "2026-08-13",
                tags: [],
                slug: "station-update",
                previousSlugs: [],
                locale: "en",
                status: "draft",
                version: 4,
              },
            })}
            principal={admin}
            surface={{ kind: "record", record: "post", id: "post-1" }}
            transitionContent={vi.fn()}
          />
        </WorkspaceActionsProvider>
      </MemoryRouter>,
    );

    const publication = await screen.findByRole("article", {
      name: "Lifecycle",
    });
    const publicationToggle = within(publication).getByRole("button", {
      name: "Lifecycle",
    });
    fireEvent.click(publicationToggle);
    expect(publicationToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(within(actionsTarget).getByRole("button", { name: "Publishing" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));

    const confirmation = screen.getByRole("group", {
      name: "Confirm submission",
    });
    expect(publicationToggle).toHaveAttribute("aria-expanded", "true");
    expect(confirmation).toBeVisible();
    expect(publicationToggle).toHaveFocus();
    expect(
      JSON.parse(localStorage.getItem("njpbs.admin.editor-bento.v2.post") ?? "[]"),
    ).toContainEqual({ id: "publication", zone: "side", collapsed: false });

    actionsTarget.remove();
  });

  it("reveals Publication after a failed header restore", async () => {
    const actionsTarget = document.createElement("div");
    document.body.append(actionsTarget);
    render(
      <MemoryRouter>
        <WorkspaceActionsProvider target={actionsTarget}>
          <EditorWorkspace
            loadRecord={async () => ({
              status: "ready",
              record: {
                id: "post-1",
                type: "post",
                title: "Archived update",
                date: "2026-08-13",
                tags: [],
                slug: "archived-update",
                previousSlugs: [],
                locale: "en",
                status: "archived",
                version: 5,
              },
            })}
            principal={admin}
            surface={{ kind: "record", record: "post", id: "post-1" }}
            transitionContent={vi.fn(async () => {
              throw new Error("Restore is temporarily unavailable.");
            })}
          />
        </WorkspaceActionsProvider>
      </MemoryRouter>,
    );

    const publication = await screen.findByRole("article", {
      name: "Lifecycle",
    });
    const publicationToggle = within(publication).getByRole("button", {
      name: "Lifecycle",
    });
    fireEvent.click(publicationToggle);
    expect(publicationToggle).toHaveAttribute("aria-expanded", "false");

    const restore = within(actionsTarget).getByRole("button", {
      name: "Restore to draft",
    });
    fireEvent.click(restore);
    expect(publicationToggle).toHaveAttribute("aria-expanded", "false");
    const confirmation = within(actionsTarget).getByRole("group", {
      name: "Confirm restore",
    });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Confirm restore" }),
    );

    const alert = await screen.findByRole("alert");
    expect(publicationToggle).toHaveAttribute("aria-expanded", "true");
    expect(within(publication).getByRole("alert")).toBe(alert);
    expect(alert).toHaveTextContent("Content was not restored");
    expect(alert).toHaveTextContent("Restore is temporarily unavailable.");
    expect(
      JSON.parse(localStorage.getItem("njpbs.admin.editor-bento.v2.post") ?? "[]"),
    ).toContainEqual({ id: "publication", zone: "side", collapsed: false });

    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(restore).toHaveFocus();
    publicationToggle.focus();
    fireEvent.click(publicationToggle);
    expect(publicationToggle).toHaveAttribute("aria-expanded", "false");
    expect(publicationToggle).toHaveFocus();

    actionsTarget.remove();
  });

  it("keeps post assignment feedback and focus while adopting the new version", async () => {
    const storedPost = {
      id: "post-1",
      type: "post",
      title: "Station update",
      date: "2026-08-13",
      tags: [],
      slug: "station-update",
      previousSlugs: [],
      locale: "en",
      status: "draft",
      assignee: "editor-1",
      blocks: [],
      version: 4,
    };
    const assignRecord = vi.fn(async () => ({
      ...storedPost,
      assignee: "editor-2",
      version: 5,
    }));
    const saveRecord = vi.fn(
      async (_kind: RecordKind, record: Record<string, unknown>) => ({
        ...record,
        version: 6,
      }),
    );
    const loadAssignableUsers = vi.fn(async () => [
      { id: "editor-1", label: "Alex Editor" },
      { id: "editor-2", label: "Bailey Producer" },
    ]);
    render(
      <MemoryRouter>
        <EditorWorkspace
          assignRecord={assignRecord}
          canAssignRecords
          loadAssignableUsers={loadAssignableUsers}
          loadRecord={async () => ({ status: "ready", record: storedPost })}
          principal={admin}
          saveRecord={saveRecord}
          surface={{ kind: "record", record: "post", id: "post-1" }}
        />
      </MemoryRouter>,
    );

    fireEvent.change(
      await screen.findByRole("combobox", {
        name: "Assigned staff member",
      }),
      { target: { value: "editor-2" } },
    );
    const assignButton = screen.getByRole("button", {
      name: "Update assignment",
    });
    assignButton.focus();
    fireEvent.click(assignButton);

    expect(await screen.findByText("Assignment updated")).toBeVisible();
    expect(assignButton).toHaveFocus();

    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), {
      target: { value: "Updated station report" },
    });
    clickWorkspaceAction("Save draft");

    await waitFor(() => expect(saveRecord).toHaveBeenCalledOnce());
    expect(saveRecord.mock.calls[0]![1]).toMatchObject({
      title: "Updated station report",
      assignee: "editor-2",
      version: 5,
    });
  });

  it("does not save a post when Enter is pressed in the schedule time", async () => {
    const actionsTarget = document.createElement("div");
    document.body.append(actionsTarget);
    const saveRecord = vi.fn(
      async (_kind: RecordKind, record: Record<string, unknown>) => record,
    );
    render(
      <MemoryRouter>
        <WorkspaceActionsProvider target={actionsTarget}>
          <EditorWorkspace
            loadRecord={async () => ({
              status: "ready",
              record: {
                id: "post-1",
                type: "post",
                title: "Approved station update",
                date: "2026-08-13",
                tags: [],
                slug: "approved-station-update",
                previousSlugs: [],
                locale: "en",
                status: "approved",
                blocks: [],
                version: 4,
              },
            })}
            principal={admin}
            saveRecord={saveRecord}
            scheduleContent={vi.fn()}
            surface={{ kind: "record", record: "post", id: "post-1" }}
            transitionContent={vi.fn()}
          />
        </WorkspaceActionsProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await within(actionsTarget).findByText("Publishing", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Schedule publish" }));
    const scheduleAt = screen.getByLabelText("Publication time (New York)");
    fireEvent.change(scheduleAt, { target: { value: "2030-09-01T10:30" } });

    expect(
      scheduleAt.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).toBe(false);
    expect(saveRecord).not.toHaveBeenCalled();

    actionsTarget.remove();
  });

  it.each(["draft", "approved"])("offers the current Post editing action for a %s", async (status) => {
    const actionsTarget = document.createElement("div");
    document.body.append(actionsTarget);
    render(
      <MemoryRouter>
        <WorkspaceActionsProvider target={actionsTarget}>
          <EditorWorkspace
            loadRecord={async () => ({
              status: "ready",
              record: {
                id: "post-1", type: "post", title: "Station update",
                date: "2026-08-13", tags: [], slug: "station-update",
                previousSlugs: [], locale: "en", status, version: 4,
              },
            })}
            principal={admin}
            publishContent={vi.fn()}
            saveRecord={vi.fn()}
            transitionContent={vi.fn()}
            surface={{ kind: "record", record: "post", id: "post-1" }}
          />
        </WorkspaceActionsProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await within(actionsTarget).findByText("Publishing", { selector: "summary" }));
    const publish = screen.getByRole("button", { name: "Publish" });
    const editing = within(actionsTarget).getByRole("button", {
      name: status === "draft" ? "Save draft" : "Edit",
    });
    expect(editing).toBeEnabled();
    expect(editing.compareDocumentPosition(publish) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    if (status === "approved") {
      expect(within(actionsTarget).queryByRole("button", { name: "Save draft" })).toBeNull();
    }
  });

  it("edits a published Post locally and saves without a lifecycle transition on open", async () => {
    const actionsTarget = document.createElement("div");
    document.body.append(actionsTarget);
    const saveRecord = vi.fn(
      async (_kind: RecordKind, record: Record<string, unknown>) => ({
        ...record,
        id: "post-1",
        status: "draft",
        version: 5,
        contentVersion: 3,
      }),
    );
    const transitionContent = vi.fn();
    render(
      <MemoryRouter>
        <WorkspaceActionsProvider target={actionsTarget}>
          <EditorWorkspace
            loadRecord={async () => ({
              status: "ready",
              record: {
                id: "post-1", type: "post", title: "Published station update",
                date: "2026-08-13", tags: [], blocks: [], slug: "station-update",
                previousSlugs: [], locale: "en", status: "published", version: 4,
                contentVersion: 2,
              },
            })}
            principal={admin}
            saveRecord={saveRecord}
            transitionContent={transitionContent}
            surface={{ kind: "record", record: "post", id: "post-1" }}
          />
        </WorkspaceActionsProvider>
      </MemoryRouter>,
    );

    const title = await screen.findByRole("textbox", { name: /^Post title$/ });
    const save = within(actionsTarget).getByRole("button", { name: "Save draft" });
    expect(title).toBeEnabled();
    expect(save).toBeEnabled();
    expect(within(actionsTarget).queryByRole("button", { name: "Edit" }))
      .not.toBeInTheDocument();
    expect(saveRecord).not.toHaveBeenCalled();
    expect(transitionContent).not.toHaveBeenCalled();

    fireEvent.change(title, { target: { value: "Updated published station report" } });
    fireEvent.click(save);

    await waitFor(() => expect(saveRecord).toHaveBeenCalledOnce());
    expect(saveRecord.mock.calls[0]![1]).toMatchObject({
      title: "Updated published station report",
    });
    expect(transitionContent).not.toHaveBeenCalled();
    actionsTarget.remove();
  });

  it("keeps approved Post panels and lifecycle actions operable", async () => {
    const actionsTarget = document.createElement("div");
    document.body.append(actionsTarget);
    const publishContent = vi.fn(async () => ({
      document: { id: "post-1", status: "published", version: 5 },
    }));
    const scheduleContent = vi.fn(async () => ({
      document: { id: "post-1", status: "scheduled", version: 5 },
    }));
    const transitionContent = vi.fn();
    render(
      <MemoryRouter>
        <WorkspaceActionsProvider target={actionsTarget}>
          <EditorWorkspace
            loadRecord={async () => ({
              status: "ready",
              record: {
                id: "post-1",
                type: "post",
                title: "Approved station update",
                date: "2026-08-13",
                tags: [],
                blocks: [],
                slug: "approved-station-update",
                previousSlugs: [],
                locale: "en",
                status: "approved",
                version: 4,
              },
            })}
            principal={admin}
            publishContent={publishContent}
            scheduleContent={scheduleContent}
            surface={{ kind: "record", record: "post", id: "post-1" }}
            transitionContent={transitionContent}
          />
        </WorkspaceActionsProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await within(actionsTarget).findByText("Publishing", { selector: "summary" }));
    const publish = screen.getByRole("button", { name: "Publish" });
    const schedule = screen.getByRole("button", {
      name: "Schedule publish",
    });
    const edit = within(actionsTarget).getByRole("button", {
      name: "Edit",
    });
    const publication = screen.getByRole("article", {
      name: "Lifecycle",
    });
    const publicationToggle = within(publication).getByRole("button", {
      name: "Lifecycle",
    });
    const metadataToggle = screen.getByRole("button", { name: "Metadata" });
    expect(screen.getAllByText("This post is approved")).toHaveLength(1);
    expect(screen.queryByText("Restoring this version")).not.toBeInTheDocument();
    for (const action of [publish, schedule, edit]) {
      expect(action).toBeEnabled();
      expect(action.closest("fieldset")).toBeNull();
    }

    publicationToggle.focus();
    fireEvent.click(publicationToggle);
    expect(publicationToggle).toHaveAttribute("aria-expanded", "false");
    for (const action of [publish, schedule, edit]) expect(action).toBeEnabled();
    expect(publicationToggle).toBeEnabled();
    expect(publicationToggle).toHaveFocus();
    expect(publicationToggle.closest("fieldset")).toBeNull();
    expect(metadataToggle).toBeEnabled();
    expect(metadataToggle.closest("fieldset")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: /^Post title$/ }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Excerpt")).toBeDisabled();
    fireEvent.click(publicationToggle);
    expect(publicationToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(publicationToggle);
    expect(publicationToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(schedule);
    expect(publicationToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      within(publication).getByRole("button", { name: "Confirm schedule" }),
    ).toBeDisabled();
    fireEvent.click(within(publication).getByRole("button", { name: "Cancel" }));

    fireEvent.click(within(actionsTarget).getByText("Publishing", { selector: "summary" }));
    fireEvent.click(publish);
    await waitFor(() => expect(publishContent).toHaveBeenCalledWith(
      "cmsPosts",
      "post-1",
      4,
      expect.objectContaining({ onProgress: expect.any(Function) }),
    ));

    actionsTarget.remove();
  });

  it("keeps record and page choices available to isolated component tests without a nav landmark", () => {
    render(<EditorWorkspace principal={editor} />);

    const picker = screen.getByLabelText("Component surface picker");
    expect(screen.getByRole("button", { name: "Home page" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(picker).toHaveTextContent("Event");
    expect(picker).toHaveTextContent("Home page");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("persists a record through the injected saveRecord, stamped with its kind", async () => {
    // A record save runs through cmsSaveContent (the injected saveRecord), passing the surface's
    // record kind so ContentTab can stamp it as the type discriminator. Production always injects
    // it, so this mirrors it. Sponsor is the one kind with no rich-text field, so it fills
    // through plain inputs.
    const saveRecord = vi.fn(
      async (_kind: RecordKind, record: Record<string, unknown>) => ({
        ...record,
        id: "spo-1",
      }),
    );
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");

    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));
    expect(saveRecord.mock.calls[0]![0]).toBe("sponsor");
    expect(saveRecord.mock.calls[0]![1]).toMatchObject({
      name: "Acme Foundation",
      href: "https://acme.org",
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("holds navigation while a record save is in flight so the editor cannot be orphaned", async () => {
    // The record analogue of the page save-lock. If navigation stayed live during a record save,
    // leaving would unmount the form and a later rejection would land on the unmounted child —
    // hiding the failure and losing the record. The rail is disabled until the save settles.
    let resolveSave: () => void = () => {};
    const saveRecord = vi.fn(
      (_kind: RecordKind, record: Record<string, unknown>) =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveSave = () => resolve({ ...record, id: "spo-1" });
        }),
    );
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");

    // Saving is in flight: the button relabels and the whole content-type rail is disabled.
    expect(await screen.findByRole("button", { name: /^.+: Saving…$/ })).toBeTruthy();
    const eventButton = screen.getByRole("button", {
      name: "Event",
    }) as HTMLButtonElement;
    expect(eventButton.disabled).toBe(true);
    // A click cannot navigate away; the sponsor form stays mounted.
    fireEvent.click(eventButton);
    expect(screen.getByLabelText(/^Website/)).toBeTruthy();

    // Once the save settles, navigation frees up again.
    await act(async () => {
      resolveSave();
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Event" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("edits a published page locally and saves without a lifecycle transition on open", async () => {
    // The page surface hydrates from loadPage, then calls the injected savePage with its
    // public page id, editor template, and edited blocks, and adopts the canonical blocks
    // (BlockEditor shows "Saved."). Production always injects both, so this mirrors it.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [],
        createdBy: "admin",
        status: "published",
        version: 4,
        contentVersion: 2,
      }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) => ({
        blocks: blocks.map((block) => ({ ...block, id: `srv-${block.id}` })),
        status: "draft",
        version: 5,
        contentVersion: 3,
      }),
    );
    const transitionContent = vi.fn();
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
        transitionContent={transitionContent}
      />,
    );
    clickWorkspaceAction("Home page");
    // The palette appears only after hydration resolves.
    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    expect(screen.getByRole("button", { name: "Save page" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(savePage).not.toHaveBeenCalled();
    expect(transitionContent).not.toHaveBeenCalled();
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });
    clickWorkspaceAction("Save page");

    expect(await screen.findByText("Saved.")).toBeTruthy();
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    expect(loadPage).toHaveBeenCalledWith("home", "home");
    expect(savePage.mock.calls[0]![0]).toBe("home");
    expect(savePage.mock.calls[0]![1]).toBe("home");
    expect(savePage.mock.calls[0]![2][0]).toMatchObject({ type: "headline" });
    expect(transitionContent).not.toHaveBeenCalled();
    // A page save does not fall through to the record mock preview.
    expect(screen.queryByText(/Last saved:/)).toBeNull();
  });

  it("loads and saves Home hero copy through page metadata", async () => {
    const savePageMetadata = vi.fn(async (_pageId, _section, metadata) => ({
      blocks: [], metadata, version: 2,
    }));
    render(<EditorWorkspace
      principal={editor}
      loadPage={async () => ({ blocks: [], metadata: { title: "Home" }, version: 1 })}
      savePageMetadata={savePageMetadata}
    />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Home hero" }));
    const heading = await screen.findByLabelText(/^Hero heading/);
    expect(heading).toHaveValue("Your NJ PBS support is still needed.");
    fireEvent.change(heading, { target: { value: "Your NJ PBS" } });
    fireEvent.change(screen.getByLabelText(/^Hero subtitle/), {
      target: { value: "Stories across New Jersey.\n\nWatch across the state." },
    });
    clickWorkspaceAction("Save metadata");
    await waitFor(() => expect(savePageMetadata).toHaveBeenCalledWith(
      "home", "home", expect.objectContaining({
        title: "Home", homeHeroTitle: "Your NJ PBS", homeHeroSubtitle: "Stories across New Jersey.\n\nWatch across the state.",
      }), 1, undefined, undefined, undefined,
    ));
  });

  it("offers the existing upload flow in Page block and metadata image pickers", async () => {
    const loadMedia = vi.fn(async () => ({
      success: true as const,
      records: [],
      total: 0,
      allCount: 0,
      page: 1,
      pageCount: 1,
      categoryCounts: { newsroom: 0 },
      kindCounts: { image: 0, document: 0 },
    }));
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={async () => ({
          blocks: [],
          metadata: { title: "Home" },
          version: 1,
        })}
        loadMedia={loadMedia}
        uploadMedia={vi.fn()}
        mediaCategories={[
          {
            id: "newsroom",
            label: "Newsroom",
            description: "Newsroom media",
            order: 10,
            active: true,
            reserved: false,
            version: 1,
            etag: '"media-category.bmV3c3Jvb20.1"',
            canUpload: true,
            canManage: false,
            createdAt: null,
            createdBy: null,
            updatedAt: null,
            updatedBy: null,
          },
        ]}
        defaultUploadCategory="newsroom"
        canUploadCategory={(category) => category === "newsroom"}
        newId={counterIds()}
      />,
    );

    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("image");
    fireEvent.click(screen.getByRole("button", { name: "Choose image" }));
    expect(
      await screen.findByRole("button", { name: "Upload image" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Choose an image" })).toBeNull(),
    );

    closeComponentEditor();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose social image" }),
    );
    expect(
      await screen.findByRole("button", { name: "Upload image" }),
    ).toBeVisible();
  });

  it("does not claim page metadata was saved when metadata persistence is absent", async () => {
    const loadPage = vi.fn(async (): Promise<PageContent> => ({
      blocks: [],
      metadata: { title: "Home" },
    }));
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) => ({ blocks }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        savePage={savePage}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    expect(
      await screen.findByText(
        "Metadata saving is not connected in this workspace.",
      ),
    ).toBeTruthy();
    const saveMetadata = screen.getByRole("button", { name: "Save metadata" });
    expect(saveMetadata).toBeDisabled();
    fireEvent.click(saveMetadata);
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("saves through the page's own save before it builds a preview to open (#1042)", async () => {
    // The preview panel's save gate is the workspace's page-save sequence, not a second one: what
    // opens in the new tab is the revision that sequence actually persisted.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({ blocks: [] }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) => ({ blocks, version: 1 }),
    );
    const requestPagePreview = vi.fn(async () => ({
      success: true as const,
      queueId: "queue123",
      pageId: "home" as PublicPageId,
      sourceVersion: 1,
      dispatched: true,
      status: "building" as const,
    }));
    const loadPagePreviewStatus = vi.fn(async () => ({
      success: true as const,
      queueId: "queue123",
      status: "ready" as const,
      pageId: "home" as PublicPageId,
      sourceVersion: 1,
      previewUrl: "https://abc123.njpbs-preview.pages.dev",
      error: null,
      requestedAt: "2026-08-20T12:00:00.000Z",
      completedAt: "2026-08-20T12:01:00.000Z",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }));

    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        requestPagePreview={requestPagePreview}
        loadPagePreviewStatus={loadPagePreviewStatus}
        newId={counterIds()}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });
    // One Preview click reveals the save gate because this page has unsaved work.
    clickWorkspaceAction("Preview");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Save and preview",
      }),
    );

    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestPagePreview).toHaveBeenCalledWith("home"));
    // The accepted build reports the version that was just persisted, and the save that produced
    // it is not repeated. What the finished artifact then offers is the panel's own contract,
    // covered where the poll interval can be controlled (admin/tests/PagePreview.test.tsx).
    expect(await screen.findByText(/Building saved version 1/)).toBeTruthy();
    expect(savePage).toHaveBeenCalledTimes(1);
  });

  it("builds the preview from a write that landed while a new edit was being typed (#1042)", async () => {
    // The editor stays editable while a save is in flight, so typing during the save leaves the
    // page dirty again the moment the write lands. That is a true statement about the editor and
    // a false one about the store: the snapshot was accepted, and the preview builds the stored
    // revision. Suppressing the build here would tell someone their changes were not saved when
    // the page had in fact just been written.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({ blocks: [] }),
    );
    const persist = deferred<PageContent>();
    let sentBlocks: AdminBlock[] = [];
    const savePage = vi.fn(
      (_pageId: PublicPageId, _section: SectionId, blocks: AdminBlock[]) => {
        sentBlocks = blocks;
        return persist.promise;
      },
    );
    const requestPagePreview = vi.fn(async () => ({
      success: true as const,
      queueId: "queue123",
      pageId: "home" as PublicPageId,
      sourceVersion: 1,
      dispatched: true,
      status: "building" as const,
    }));

    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        requestPagePreview={requestPagePreview}
        loadPagePreviewStatus={vi.fn()}
        newId={counterIds()}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("heading");
    const heading = headingField();
    fireEvent.change(heading, { target: { value: "Tonight on NJ PBS" } });
    clickWorkspaceAction("Preview");

    fireEvent.click(
      await screen.findByRole("button", { name: "Save and preview" }),
    );
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    // Typed while the write is still in flight.
    expect(headingField()).toBe(heading);
    fireEvent.change(heading, { target: { value: "Tonight on NJ PBS, at 8" } });
    await act(async () => {
      persist.resolve({ blocks: sentBlocks, version: 1 });
    });

    await waitFor(() => expect(requestPagePreview).toHaveBeenCalledWith("home"));
    // And the later edit is still unsaved, so the gate is back rather than silently cleared.
    expect(
      await screen.findByRole("button", { name: "Save and preview" }),
    ).toBeInTheDocument();
  });

  it("discards unsaved page work from the preview gate and re-reads the stored page (#1042)", async () => {
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({ blocks: [] }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) => ({ blocks, version: 1 }),
    );
    const requestPagePreview = vi.fn(async () => ({
      success: true as const,
      queueId: "queue123",
      pageId: "home" as PublicPageId,
      sourceVersion: 1,
      dispatched: true,
      status: "building" as const,
    }));
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        requestPagePreview={requestPagePreview}
        loadPagePreviewStatus={vi.fn()}
        newId={counterIds()}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });
    clickWorkspaceAction("Preview");

    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Discard unsaved changes" }),
    );

    // The stored page is read again, the unsaved heading is gone, and nothing was saved.
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Heading" })).toBeNull(),
    );
    expect(savePage).not.toHaveBeenCalled();
    expect(requestPagePreview).toHaveBeenCalledWith("home");
    expect(await screen.findByText(/Building saved version 1/)).toBeTruthy();
  });

  it("keeps unsaved page edits when a bento card moves to the other zone", async () => {
    // The editor body stays mounted while its card shell moves between zones. The draft lives in
    // a ref and only the first edit re-renders the workspace, so the typed heading below is also a
    // regression check that the move does not replace the live editor from an older render.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({ blocks: [] }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) => ({
        blocks,
        version: 1,
      }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    clickWorkspaceAction("Home page");
    // Edit 1 (adds a block): flips the dirty flag and re-renders the workspace.
    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("heading");
    // Edit 2 (types into the block): updates the draft ref without re-rendering the workspace.
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });

    closeComponentEditor();
    // Add a second card to the main area, then reorder Page content within its allowed zone.
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Move section: Page metadata" }),
      { key: "ArrowLeft" },
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Move section: Page content" }), { key: "ArrowDown" });

    // The same editor kept the second edit rather than reverting to the pre-type snapshot.
    expect(
      (headingField() as HTMLInputElement)
        .value,
    ).toBe("Tonight on NJ PBS");
  });
});

describe("EditorWorkspace lifecycle actions", () => {
  it("retries an accepted card approval without validating or saving the later private draft", async () => {
    const record = { id: "spo-1", type: "sponsor", name: "", href: "not-a-url", tier: "community",
      status: "draft", createdBy: "admin", version: 4 };
    const transitionContent = vi.fn(async (request) => ({ success: true as const, ...request,
      fromStatus: "draft", toStatus: "draft", version: 4, document: record }));
    const saveRecord = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, found: true,
      publication: { workingVersion: 4, workingStatus: "draft", publishedSourceVersion: 3,
        publicSourceVersion: 3, publiclyVisible: true, publicUpdatePending: true,
        publicBuildQueueId: "accepted-card", queueStatus: "failed",
        libraryCardPublication: { queueId: "accepted-card", sourceVersion: 3, action: "approve",
          withdrawal: false, status: "pending", missingConsumers: ["posts"], warning: "Use Retry card update." } } }),
    { status: 200, headers: { "Content-Type": "application/json" } })));
    try {
      render(<MemoryRouter><PublicContentStatusProvider getIdToken={async () => "test-token"}>
        <EditorWorkspace loadRecord={async () => ({ status: "ready", record })} principal={admin}
          saveRecord={saveRecord} surface={{ kind: "record", record: "sponsor", id: "spo-1" }}
          transitionContent={transitionContent} />
      </PublicContentStatusProvider></MemoryRouter>);
      fireEvent.click(await screen.findByRole("button", { name: "Retry card update" }));
      await waitFor(() => expect(transitionContent).toHaveBeenCalledWith({ collection: "cmsPosts", id: "spo-1",
        action: "approve", baseVersion: 2 }));
      expect(saveRecord).not.toHaveBeenCalled();
      expect(screen.getByLabelText(/^Name/)).toHaveValue("");
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it.each(["post", "program"] as const)("shows the scheduled publication failure stored on a %s without expanding controls", async (kind) => {
    render(
      <MemoryRouter>
        <EditorWorkspace
          loadRecord={async () => ({
            status: "ready",
            record: {
              id: "post-1",
              type: kind,
              title: "Station update",
              date: "2026-08-13",
              tags: [],
              slug: "station-update",
              previousSlugs: [],
              locale: "en",
              status: "approved",
              version: 4,
              scheduledPublishFailure: {
                failedAt: "2026-08-13T18:30:00.000Z",
                failedBy: "system:scheduler",
                reason: "The lead image is not available.",
              },
            },
          })}
          principal={admin}
          publishContent={vi.fn()}
          scheduleContent={vi.fn()}
          surface={{ kind: "record", record: kind, id: "post-1" }}
          transitionContent={vi.fn()}
        />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toBeVisible();
    expect(alert).toHaveTextContent(
      "The lead image is not available.",
    );
  });

  it("shows the scheduled publication failure loaded with a page", async () => {
    render(
      <EditorWorkspace
        loadPage={async () => ({
          blocks: [],
          metadata: { title: "Watch" },
          status: "approved",
          version: 4,
          scheduledPublishFailure: {
            failedAt: "2026-08-13T18:30:00.000Z",
            failedBy: "system:scheduler",
            reason: "The page is too large to publish.",
          },
        })}
        principal={admin}
        publishContent={vi.fn()}
        scheduleContent={vi.fn()}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
        transitionContent={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The page is too large to publish.",
    );
  });

  it("shows card approval guidance without routed Sponsor publication", async () => {
    const publishContent = vi.fn(async () => ({
      document: { id: "spo-1", status: "published", version: 4 },
    }));
    render(
      <MemoryRouter>
        <EditorWorkspace
          loadRecord={async () => ({
            status: "ready",
            record: {
              id: "spo-1",
              type: "sponsor",
              name: "Acme Foundation",
              href: "https://example.com",
              tier: "community",
              status: "approved",
              createdBy: "admin",
              version: 3,
            },
          })}
          principal={admin}
          publishContent={publishContent}
          surface={{ kind: "record", record: "sponsor", id: "spo-1" }}
          transitionContent={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("Approve publishes this card. Unpublish or Archive removes it. Draft edits stay private."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Publish" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Schedule publish" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit" }),
    ).toBeEnabled();
    expect(publishContent).not.toHaveBeenCalled();
  });

  it("offers publication to an approved program, now that it has a public route", async () => {
    // The other half of the library-only case above. Program is the first
    // non-post record kind with a reviewed /programs/{slug}/ route (#923), so its
    // approved state gets the same Publish and Schedule controls a post has,
    // and none of the library-only explanatory copy.
    const publishContent = vi.fn(async () => ({
      document: { id: "prog-1", status: "published", version: 4 },
    }));
    render(
      <MemoryRouter>
        <EditorWorkspace
          loadRecord={async () => ({
            status: "ready",
            record: {
              id: "prog-1",
              type: "program",
              title: "Due Process",
              genre: "public affairs",
              description: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "A weekly look at law." }],
                  },
                ],
              },
              status: "approved",
              createdBy: "admin",
              version: 3,
            },
          })}
          principal={admin}
          publishContent={publishContent}
          scheduleContent={vi.fn()}
          surface={{ kind: "record", record: "program", id: "prog-1" }}
          transitionContent={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: "Publish" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Schedule publish" })).toBeEnabled();
    expect(
      screen.queryByText(/available under All content/i),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(publishContent).toHaveBeenCalledWith("cmsPosts", "prog-1", 3, expect.objectContaining({ onProgress: expect.any(Function) })),
    );
  });

  it("unpublishes an exact record version and freezes the form while it settles", async () => {
    const request = deferred<TransitionContentResponse>();
    const transitionContent = vi.fn(() => request.promise);
    let record = {
      id: "spo-1",
      type: "sponsor",
      name: "Acme Foundation",
      href: "https://example.com",
      tier: "community",
      status: "published",
      createdBy: "admin",
      version: 3,
    };
    const loadRecord = vi.fn(async () => ({
      status: "ready" as const,
      record,
    }));
    render(
      <MemoryRouter>
        <EditorWorkspace
          loadRecord={loadRecord}
          principal={admin}
          surface={{ kind: "record", record: "sponsor", id: "spo-1" }}
          transitionContent={transitionContent}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unpublish" }));

    await waitFor(() =>
      expect(transitionContent).toHaveBeenCalledWith({
        collection: "cmsPosts",
        id: "spo-1",
        action: "unpublish",
        baseVersion: 3,
      }),
    );
    expect(screen.getByLabelText(/^Name/)).toBeDisabled();

    record = { ...record, status: "draft", version: 4 };
    request.resolve({
      success: true,
      collection: "cmsPosts",
      id: "spo-1",
      action: "unpublish",
      fromStatus: "published",
      toStatus: "draft",
      version: 4,
      document: record,
    });

    await waitFor(() => expect(loadRecord).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText(/^Name/)).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Unpublish" }),
    ).not.toBeInTheDocument();
  });

  it("restores an archived canonical page through its bento lifecycle panel", async () => {
    let page: PageContent = {
      blocks: [],
      metadata: { title: "Watch" },
      createdBy: "admin",
      status: "archived",
      version: 7,
    };
    const loadPage = vi.fn(async () => page);
    const transitionContent = vi.fn(async () => {
      page = { ...page, status: "draft", version: 8 };
      return {
        success: true as const,
        collection: "cmsPages" as const,
        id: "watch",
        action: "restore" as const,
        fromStatus: "archived" as const,
        toStatus: "draft" as const,
        version: 8,
        document: { id: "watch", status: "draft", version: 8 },
      };
    });
    render(
      <EditorWorkspace
        loadPage={loadPage}
        principal={admin}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
        transitionContent={transitionContent}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Restore to draft" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));

    await waitFor(() =>
      expect(transitionContent).toHaveBeenCalledWith({
        collection: "cmsPages",
        id: "watch",
        action: "restore",
        baseVersion: 7,
      }),
    );
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByRole("button", { name: "Restore to draft" }),
    ).not.toBeInTheDocument();
  });
});

describe("EditorWorkspace record assignment", () => {
  const surface = {
    kind: "record" as const,
    record: "sponsor" as const,
    id: "spo-1",
  };
  const storedSponsor = {
    id: "spo-1",
    type: "sponsor",
    name: "Acme Foundation",
    href: "https://acme.example",
    status: "draft",
    assignee: "editor-1",
    version: 3,
  };
  const loadAssignableUsers = vi.fn(async () => [
    { id: "editor-1", label: "Alex Editor" },
    { id: "editor-2", label: "Bailey Producer" },
  ]);

  it("does not load or render admin-only assignment controls for an editor grant", async () => {
    const restrictedLoader = vi.fn(async () => [
      { id: "editor-1", label: "Alex Editor" },
    ]);
    render(
      <MemoryRouter>
        <EditorWorkspace
          loadAssignableUsers={restrictedLoader}
          loadRecord={async () => ({ status: "ready", record: storedSponsor })}
          principal={siteWideEditor}
          surface={surface}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText(/^Name/)).toBeInTheDocument();
    expect(restrictedLoader).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Workflow assignment" }),
    ).toBeNull();
  });

  it("adopts the assignment response version before the next content save", async () => {
    const assignRecord = vi.fn(async () => ({
      ...storedSponsor,
      assignee: "editor-2",
      updatedBy: "admin",
      version: 4,
    }));
    const saveRecord = vi.fn(
      async (_kind: RecordKind, record: Record<string, unknown>) => ({
        ...record,
        version: 5,
      }),
    );
    render(
      <MemoryRouter>
        <EditorWorkspace
          assignRecord={assignRecord}
          canAssignRecords
          loadAssignableUsers={loadAssignableUsers}
          loadRecord={async () => ({ status: "ready", record: storedSponsor })}
          principal={admin}
          saveRecord={saveRecord}
          surface={surface}
        />
      </MemoryRouter>,
    );

    const assignment = await screen.findByRole("combobox", {
      name: "Assigned staff member",
    });
    fireEvent.change(assignment, { target: { value: "editor-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Update assignment" }));
    await waitFor(() =>
      expect(assignRecord).toHaveBeenCalledWith({
        id: "spo-1",
        baseVersion: 3,
        assignee: "editor-2",
      }),
    );

    fireEvent.change(await screen.findByLabelText(/^Name/), {
      target: { value: "Acme Foundation and Partners" },
    });
    clickWorkspaceAction("Save draft");

    await waitFor(() => expect(saveRecord).toHaveBeenCalledOnce());
    expect(saveRecord.mock.calls[0]![1]).toMatchObject({
      id: "spo-1",
      assignee: "editor-2",
      version: 4,
    });
  });

  it("normalizes callable Timestamp JSON before assignment remounts the record form", async () => {
    const eventSurface = {
      kind: "record" as const,
      record: "event" as const,
      id: "event-1",
    };
    const description = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "What to expect." }],
        },
      ],
    };
    const storedEvent = {
      id: "event-1",
      type: "event",
      title: "Shore screening",
      description,
      startsAt: "2026-07-24T15:30:00.000Z",
      status: "draft",
      assignee: "editor-1",
      version: 3,
    };
    const assignRecord = vi.fn(async () => ({
      ...storedEvent,
      startsAt: {
        _seconds: Date.parse("2026-07-24T15:30:00.000Z") / 1_000,
        _nanoseconds: 0,
      },
      assignee: "editor-2",
      version: 4,
    }));
    const saveRecord = vi.fn(
      async (_kind: RecordKind, record: Record<string, unknown>) => ({
        ...record,
        version: 5,
      }),
    );
    render(
      <MemoryRouter>
        <EditorWorkspace
          assignRecord={assignRecord}
          canAssignRecords
          loadAssignableUsers={loadAssignableUsers}
          loadRecord={async () => ({ status: "ready", record: storedEvent })}
          principal={admin}
          saveRecord={saveRecord}
          surface={eventSurface}
        />
      </MemoryRouter>,
    );

    const assignment = await screen.findByRole("combobox", {
      name: "Assigned staff member",
    });
    fireEvent.change(assignment, { target: { value: "editor-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Update assignment" }));

    expect(await screen.findByText("Assignment updated")).toBeTruthy();
    // Station-local wall time for the stored 15:30 UTC instant, unchanged by the
    // assignment remount.
    expect(
      (await screen.findByLabelText(/^Starts/)) as HTMLInputElement,
    ).toHaveValue("2026-07-24T11:30");
    fireEvent.change(await screen.findByLabelText(/^Title/), {
      target: { value: "Updated shore screening" },
    });
    clickWorkspaceAction("Save draft");

    await waitFor(() => expect(saveRecord).toHaveBeenCalledOnce());
    expect(saveRecord.mock.calls[0]![1]).toMatchObject({
      startsAt: "2026-07-24T15:30:00.000Z",
      assignee: "editor-2",
      version: 4,
    });
  });

  it("adopts the content save response version before the next assignment", async () => {
    const saveRecord = vi.fn(
      async (_kind: RecordKind, record: Record<string, unknown>) => ({
        ...record,
        updatedBy: "admin",
        version: 4,
      }),
    );
    const assignRecord = vi.fn(async () => ({
      ...storedSponsor,
      name: "Acme Foundation and Partners",
      assignee: "editor-2",
      updatedBy: "admin",
      version: 5,
    }));
    render(
      <MemoryRouter>
        <EditorWorkspace
          assignRecord={assignRecord}
          canAssignRecords
          loadAssignableUsers={loadAssignableUsers}
          loadRecord={async () => ({ status: "ready", record: storedSponsor })}
          principal={admin}
          saveRecord={saveRecord}
          surface={surface}
        />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText(/^Name/), {
      target: { value: "Acme Foundation and Partners" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledOnce());
    expect(await screen.findByText("Saved.")).toBeTruthy();

    const assignment = screen.getByRole("combobox", {
      name: "Assigned staff member",
    });
    fireEvent.change(assignment, { target: { value: "editor-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Update assignment" }));

    await waitFor(() =>
      expect(assignRecord).toHaveBeenCalledWith({
        id: "spo-1",
        baseVersion: 4,
        assignee: "editor-2",
      }),
    );
  });

  it("does not let assignment remount a form with unsaved work", async () => {
    const assignRecord = vi.fn();
    render(
      <MemoryRouter>
        <EditorWorkspace
          assignRecord={assignRecord}
          canAssignRecords
          loadAssignableUsers={loadAssignableUsers}
          loadRecord={async () => ({ status: "ready", record: storedSponsor })}
          principal={admin}
          surface={surface}
        />
      </MemoryRouter>,
    );

    const assignment = await screen.findByRole("combobox", {
      name: "Assigned staff member",
    });
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Unsaved sponsor name" },
    });

    expect(
      await screen.findByText(
        "Save or revert your content edits before changing assignment.",
      ),
    ).toBeInTheDocument();
    expect(assignment).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Update assignment" }),
    ).toBeDisabled();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Unsaved sponsor name");
    expect(assignRecord).not.toHaveBeenCalled();
  });

  it("explains why archived records cannot be reassigned", async () => {
    const assignRecord = vi.fn();
    render(
      <MemoryRouter>
        <EditorWorkspace
          assignRecord={assignRecord}
          canAssignRecords
          loadAssignableUsers={loadAssignableUsers}
          loadRecord={async () => ({
            status: "ready",
            record: { ...storedSponsor, status: "archived" },
          })}
          principal={admin}
          surface={surface}
        />
      </MemoryRouter>,
    );

    const assignment = await screen.findByRole("combobox", {
      name: "Assigned staff member",
    });
    expect(assignment).toBeDisabled();
    expect(
      screen.getByText("Restore this record before changing its assignment."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Update assignment" }),
    ).toBeDisabled();
    expect(assignRecord).not.toHaveBeenCalled();
  });
});

describe("EditorWorkspace page hydration (#515 data-loss guard)", () => {
  // A stored headline the page already holds. The editor must load it so a save composes over
  // the live composition rather than overwriting it from a blank editor.
  const storedHeadline: AdminBlock = {
    id: "srv-headline",
    type: "headline",
    order: 0,
    visible: true,
    data: { text: "Existing headline", level: 2 },
  } as AdminBlock;

  it("hydrates the page from loadPage so a save sends the whole stored composition", async () => {
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({ blocks: [storedHeadline] }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) => ({ blocks }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    clickWorkspaceAction("Home page");

    // The stored headline is seeded into the editor once hydration resolves.
    expect(await screen.findByDisplayValue("Existing headline")).toBeTruthy();
    // Add a second block, then save: the payload carries both, not just the new one.
    addBlock("divider");
    clickWorkspaceAction("Save page");

    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    const savedBlocks = savePage.mock.calls[0]![2];
    expect(savedBlocks).toHaveLength(2);
    expect(savedBlocks[0]).toMatchObject({
      id: "srv-headline",
      type: "headline",
    });
    expect(savedBlocks[1]).toMatchObject({ type: "divider" });
  });

  it("shows a loading state and no save affordance while the page is loading", async () => {
    // A loadPage that never resolves within the test keeps the editor in its loading state.
    let resolveLoad: (page: PageContent) => void = () => {};
    const loadPage = vi.fn(
      (_pageId: PublicPageId, _section: SectionId) =>
        new Promise<PageContent>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    clickWorkspaceAction("Home page");

    expect(screen.getByRole("status")).toHaveTextContent("Loading the page");
    // No editor is rendered, so there is nothing to save from a blank editor.
    expect(screen.queryByRole("button", { name: "Save page" })).toBeNull();

    await act(async () => {
      resolveLoad({ blocks: [] });
    });
    expect(
      await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ }),
    ).toBeTruthy();
  });

  it("shows an error and disables editing when the page fails to load", async () => {
    // A rejected load must not fall through to a blank editor: editing stays disabled so a
    // save can never overwrite the stored page with an empty one.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => {
        throw new Error("Missing or insufficient permissions.");
      },
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    clickWorkspaceAction("Home page");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("page-load-error");
    expect(alert).toHaveTextContent("Page editing unavailable");
    expect(alert).toHaveTextContent("Missing or insufficient permissions.");
    // The editor never mounts, so there is no save button and no palette to edit from.
    expect(screen.queryByRole("button", { name: "Save page" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Add (?:block|content): position/ }),
    ).toBeNull();
  });

  it("offers a way back to the page when the conflict reload's re-read fails", async () => {
    // #574. Reloading discards the unsaved blocks by unmounting the editor, and that is what
    // the person asked for -- the button names the cost and they took it. What they did not
    // agree to is losing the page they traded the blocks for: a rejected re-read used to land
    // on "Page editing unavailable" with nothing to do next, which forecloses both answers to
    // the conflict at once, because "Save anyway" needed the blocks that are now gone.
    let load: () => Promise<PageContent> = async () => ({ blocks: [] });
    const loadPage = vi.fn(async (_pageId: PublicPageId, _section: SectionId) =>
      load(),
    );
    const savePage = vi.fn(async (): Promise<PageContent> => {
      throw Object.assign(new Error("Conflict"), { status: 409 });
    });
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        savePage={savePage}
        newId={counterIds()}
      />,
    );
    clickWorkspaceAction("Home page");
    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("divider");
    clickWorkspaceAction("Save page");
    await screen.findByText(/Someone else saved this page/);

    load = async () => {
      throw new Error("Network request failed.");
    };
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reload the page, discarding your changes",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Page editing unavailable",
    );

    // Asking again is the way forward. It does not give the blocks back -- those went by
    // consent -- it completes the trade that failed halfway.
    load = async () => ({ blocks: [] });
    fireEvent.click(
      screen.getByRole("button", { name: "Try loading the page again" }),
    );
    expect(
      await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ }),
    ).toBeTruthy();
  });

  it("offers the same way back when a page fails to load on navigation", async () => {
    // The retry sits on the error state, which a surface change reaches through the same
    // hydration effect as a reload does. #574 asked whether a fix should cover this path;
    // it does, because there is one read to repeat and one dead end to leave.
    let load: () => Promise<PageContent> = async () => {
      throw new Error("Network request failed.");
    };
    const loadPage = vi.fn(async (_pageId: PublicPageId, _section: SectionId) =>
      load(),
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    clickWorkspaceAction("Home page");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Page editing unavailable",
    );

    load = async () => ({ blocks: [] });
    fireEvent.click(
      screen.getByRole("button", { name: "Try loading the page again" }),
    );
    expect(
      await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ }),
    ).toBeTruthy();
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("keeps the retry available when the retry itself fails", async () => {
    // A dead end that only opens once is still a dead end. The read can fail again -- an
    // outage does not clear on cue -- and the person must not be worse off for having asked.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => {
        throw new Error("Network request failed.");
      },
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    clickWorkspaceAction("Home page");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Page editing unavailable",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Try loading the page again" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Page editing unavailable",
    );
    expect(
      await screen.findByRole("button", { name: "Try loading the page again" }),
    ).toBeEnabled();
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("re-hydrates when switching from one page to another", async () => {
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        section: SectionId,
      ): Promise<PageContent> => ({
        blocks: section === "home" ? [storedHeadline] : [],
      }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );

    clickWorkspaceAction("Home page");
    expect(await screen.findByDisplayValue("Existing headline")).toBeTruthy();

    clickWorkspaceAction("Watch NJ PBS");
    // The program landing page loads empty, so the home headline is gone.
    await waitFor(() =>
      expect(screen.queryByDisplayValue("Existing headline")).toBeNull(),
    );
    expect(loadPage).toHaveBeenCalledWith("home", "home");
    expect(loadPage).toHaveBeenCalledWith("watch", "programLanding");

    clickWorkspaceAction("Staff");
    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    expect(loadPage).toHaveBeenCalledWith("staff", "genericPage");
  });

  it("keeps pages that share a template as distinct editor surfaces and drafts", async () => {
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [],
        version: 1,
      }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );

    clickWorkspaceAction("Watch NJ PBS");
    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Watch draft" },
    });

    clickWorkspaceAction("PBS Livestream");
    await waitFor(() =>
      expect(screen.queryByDisplayValue("Watch draft")).toBeNull(),
    );
    await screen.findByRole("button", { name: /Add content: position/ });
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Livestream draft" },
    });

    clickWorkspaceAction("Watch NJ PBS");
    expect(await screen.findByDisplayValue("Watch draft")).toBeTruthy();
    expect(screen.queryByDisplayValue("Livestream draft")).toBeNull();
    expect(loadPage).toHaveBeenCalledWith("watch", "programLanding");
    expect(loadPage).toHaveBeenCalledWith("live", "programLanding");
  });
});

describe("EditorWorkspace navigation safety (#515 lifecycle guards)", () => {
  it("treats reselecting the active page as a no-op so unsaved edits survive", async () => {
    // Every rail click builds a fresh Surface object. Without a no-op guard, clicking the
    // already-selected page would change the surface identity, re-run hydration, and wipe the
    // unsaved edits. Reselecting must not reload.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({ blocks: [] }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) => ({ blocks }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    clickWorkspaceAction("Home page");
    // Hydrate, then add an unsaved block.
    await screen.findByRole("button", { name: /Add (?:block|content): position/ });
    addBlock("divider");
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(await screen.findByText("1 block in outline")).toHaveClass("sr-only");
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(loadPage).toHaveBeenCalledTimes(1);

    // Reselect the already-active Home page: no reload, and the unsaved divider stays.
    clickWorkspaceAction("Home page");
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("1 block in outline")).toHaveClass("sr-only");
  });

  it("holds navigation while a page save is in flight so the editor cannot be orphaned", async () => {
    // If navigation stayed live during a save, leaving would unmount the editor and a later
    // rejection would land on the unmounted child — hiding the failure and losing the edits.
    // The rail is disabled until the save settles.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({ blocks: [] }),
    );
    let resolveSave: () => void = () => {};
    const savePage = vi.fn(
      (_pageId: PublicPageId, _section: SectionId, blocks: AdminBlock[]) =>
        new Promise<PageContent>((resolve) => {
          resolveSave = () => resolve({ blocks });
        }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    clickWorkspaceAction("Home page");
    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Live tonight" },
    });
    clickWorkspaceAction("Save page");

    // Saving is in flight: the button relabels and the rail is disabled.
    expect(await screen.findByRole("button", { name: /^.+: Saving…$/ })).toBeTruthy();
    const eventButton = screen.getByRole("button", {
      name: "Event",
    }) as HTMLButtonElement;
    expect(eventButton.disabled).toBe(true);
    // A click cannot navigate away; the page editor stays mounted.
    fireEvent.click(eventButton);
    expect(headingField()).toBeTruthy();

    // Once the save settles, navigation frees up again.
    await act(async () => {
      resolveSave();
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Event" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("holds navigation until both page save controls have settled", async () => {
    // Page metadata and page composition can save independently. If they share one boolean,
    // whichever request settles first reports false and unlocks navigation while the sibling
    // request is still writing. Each control needs its own in-flight lifecycle contribution.
    const loadPage = vi.fn(async (): Promise<PageContent> => ({
      blocks: [],
      metadata: { title: "Home" },
      version: 1,
    }));
    let resolveMetadataSave: () => void = () => {};
    let resolveBlockSave: () => void = () => {};
    const savePageMetadata = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        metadata: Record<string, unknown>,
      ) =>
        new Promise<PageContent>((resolve) => {
          resolveMetadataSave = () =>
            resolve({ blocks: [], metadata, version: 2 });
        }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) =>
        new Promise<PageContent>((resolve) => {
          resolveBlockSave = () => resolve({ blocks, version: 3 });
        }),
    );

    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        savePage={savePage}
        savePageMetadata={savePageMetadata}
        newId={counterIds()}
      />,
    );

    fireEvent.change(await screen.findByLabelText(/^Page title/), {
      target: { value: "NJ PBS Home" },
    });
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });

    clickWorkspaceAction("Save metadata");
    clickWorkspaceAction("Save page");
    await waitFor(() => {
      expect(savePageMetadata).toHaveBeenCalledTimes(1);
      expect(savePage).toHaveBeenCalledTimes(1);
    });

    const eventButton = screen.getByRole("button", {
      name: "Event",
    }) as HTMLButtonElement;
    expect(eventButton.disabled).toBe(true);

    await act(async () => {
      resolveMetadataSave();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save metadata" }),
      ).toBeTruthy(),
    );

    // The composition save is still outstanding, so navigation must remain locked.
    expect(eventButton.disabled).toBe(true);

    await act(async () => {
      resolveBlockSave();
    });
    await waitFor(() => expect(eventButton.disabled).toBe(false));
  });
});

describe("EditorWorkspace RBAC gate", () => {
  it("does not repeat permission help in the editor header", () => {
    render(<EditorWorkspace principal={editor} />);
    expect(screen.queryByText("You can save and publish content.")).toBeNull();
    expect(screen.queryByText("Publish access")).toBeNull();
  });

  it("labels the save Save draft for a contributor who cannot publish", () => {
    // Asserts the record form's save label, so it selects the record surface rather than
    // leaning on whichever surface happens to be the default.
    render(<EditorWorkspace principal={contributor} />);
    clickWorkspaceAction("Event");
    expect(screen.queryByText(/You can save drafts/)).toBeNull();
    expect(screen.queryByText("Draft access")).toBeNull();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
  });

  it("disables save and marks content read-only for a role with no capability", () => {
    render(<EditorWorkspace principal={readOnly} />);
    clickWorkspaceAction("Event");
    expect(screen.queryByText(/read-only access to content/)).toBeNull();
    expect(screen.queryByText("Read only")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("Your role cannot save this record.")).toBeTruthy();
  });

  it("keeps a contributor's submitted record read-only", async () => {
    const saveRecord = vi.fn();
    const transitionContent = vi.fn();
    render(
      <MemoryRouter>
        <EditorWorkspace
          loadRecord={async () => ({
            status: "ready",
            record: {
              id: "post-1",
              type: "post",
              title: "Submitted post",
              status: "in_review",
              createdBy: "c",
              version: 2,
            },
          })}
          principal={siteWideContributor}
          saveRecord={saveRecord}
          surface={{ kind: "record", record: "post", id: "post-1" }}
          transitionContent={transitionContent}
        />
      </MemoryRouter>,
    );

    const editButton = await screen.findByRole("button", { name: "Edit" });
    expect(editButton).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Post title" })).toBeDisabled();
    expect(
      screen.getAllByText(/select edit before changing reviewed content/i),
    ).not.toHaveLength(0);
    expect(saveRecord).not.toHaveBeenCalled();
    expect(transitionContent).not.toHaveBeenCalled();
  });

  it.each(["published", "scheduled"] as const)(
    "keeps a %s legacy-seeded page read-only for a contributor",
    async (status) => {
      const savePage = vi.fn(
        async (
          _pageId: PublicPageId,
          _section: SectionId,
          blocks: AdminBlock[],
        ) => ({
          blocks,
          status,
          version: 1,
        }),
      );
      render(
        <EditorWorkspace
          loadPage={async () => ({
            blocks: [],
            expectedAbsent: true,
            seedFromLegacyPage: { id: "programLanding", version: 7 },
            status,
          })}
          principal={siteWideContributor}
          savePage={savePage}
          surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
        />,
      );

      const saveButton = await screen.findByRole("button", {
        name: "Save page",
      });
      expect(saveButton).toBeDisabled();
      expect(
        screen.getAllByText(
          /publish access is required to create this page from its legacy content/i,
        ),
      ).toHaveLength(2);
      fireEvent.click(saveButton);
      expect(savePage).not.toHaveBeenCalled();
    },
  );

  it("keeps an archived legacy-seeded page read-only without archive authority", async () => {
    const savePage = vi.fn();
    render(
      <EditorWorkspace
        loadPage={async () => ({
          blocks: [],
          expectedAbsent: true,
          seedFromLegacyPage: { id: "programLanding", version: 7 },
          status: "archived",
        })}
        principal={siteWideContributor}
        savePage={savePage}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    const saveButton = await screen.findByRole("button", { name: "Save page" });
    expect(saveButton).toBeDisabled();
    expect(
      screen.getAllByText(
        /unpublish access is required to create this archived page from its legacy content/i,
      ),
    ).toHaveLength(2);
    fireEvent.click(saveButton);
    expect(savePage).not.toHaveBeenCalled();
  });

  it.each(["draft", "in_review"] as const)(
    "allows a contributor to create from a %s legacy seed",
    async (status) => {
      render(
        <EditorWorkspace
          loadPage={async () => ({
            blocks: [],
            expectedAbsent: true,
            seedFromLegacyPage: { id: "programLanding", version: 7 },
            status,
          })}
          principal={siteWideContributor}
          savePage={async (_pageId, _section, blocks) => ({
            blocks,
            status,
            version: 1,
          })}
          surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
        />,
      );

      expect(
        await screen.findByRole("button", { name: "Save page" }),
      ).toBeEnabled();
    },
  );
});

describe("EditorWorkspace save conflict (#530, #563)", () => {
  const storedHeadline: AdminBlock = {
    id: "srv-headline",
    type: "headline",
    order: 0,
    visible: true,
    data: { text: "Existing headline", level: 2 },
  } as AdminBlock;

  function conflictRejection() {
    return Object.assign(
      new Error("This document changed since you opened it."),
      {
        status: 409,
      },
    );
  }

  // Hydrate the home page, then put an edit in the editor ready to save.
  async function openHomeAndEdit() {
    clickWorkspaceAction("Home page");
    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });
  }

  it("echoes the version the editor was seeded from", async () => {
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({ blocks: [], version: 7 }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _s: SectionId,
        blocks: AdminBlock[],
        _baseVersion?: number,
      ) => ({
        blocks,
        version: 8,
      }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await openHomeAndEdit();
    clickWorkspaceAction("Save page");

    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    // The claim is about what this person could see, so it has to be the version the blocks
    // they are looking at were read at.
    expect(savePage.mock.calls[0]![3]).toBe(7);
  });

  it("claims nothing for a page that has no stored version to claim", async () => {
    // A never-created page, and one written before `version` existed, both look like this.
    // There is no version to echo, so the save must not invent one. Production distinguishes
    // a truly absent document with the separate create-only claim (#567).
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({ blocks: [] }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _s: SectionId,
        blocks: AdminBlock[],
        _baseVersion?: number,
      ) => ({
        blocks,
        version: 1,
      }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await openHomeAndEdit();
    clickWorkspaceAction("Save page");

    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    expect(savePage.mock.calls[0]![3]).toBeUndefined();
  });

  it("takes the version a save returns as the base for the next one", async () => {
    // Without this the editor conflicts with itself: the second save would echo the version the
    // first had already superseded, and the server would refuse a save nobody else touched.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({ blocks: [], version: 4 }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _s: SectionId,
        blocks: AdminBlock[],
        _baseVersion?: number,
      ) => ({
        blocks,
        version: 5,
      }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await openHomeAndEdit();

    clickWorkspaceAction("Save page");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));

    fireEvent.change(headingField(), {
      target: { value: "Second edit" },
    });
    clickWorkspaceAction("Save page");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(2));

    expect(savePage.mock.calls[0]![3]).toBe(4);
    expect(savePage.mock.calls[1]![3]).toBe(5);
  });

  it("drops the claim when the person chooses to overwrite", async () => {
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({ blocks: [], version: 2 }),
    );
    const savePage = vi
      .fn()
      .mockRejectedValueOnce(conflictRejection())
      .mockImplementationOnce(
        async (_pageId: PublicPageId, _s: SectionId, blocks: AdminBlock[]) => ({
          blocks,
          version: 9,
        }),
      );
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await openHomeAndEdit();

    clickWorkspaceAction("Save page");
    await screen.findByText(/Someone else saved this page/);

    closeComponentEditor();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    );
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(2));

    // No claim means the server has nothing to refuse, so the write lands on whatever is
    // stored. That is exactly the overwrite the person asked for.
    expect(savePage.mock.calls[0]![3]).toBe(2);
    expect(savePage.mock.calls[1]![3]).toBeUndefined();
  });

  it("keeps the sibling block claim stale after metadata is force-overwritten", async () => {
    // Metadata and composition are partial saves against one page document. An ordinary save can
    // advance both claims because it proved the shared version current. A force-overwrite proves
    // the opposite: only the form whose overwrite the person confirmed may adopt the returned
    // version. If composition also adopted it, a later block save could silently replace remote
    // block changes the person never saw.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [],
        metadata: { title: "Home" },
        version: 1,
      }),
    );
    const savePageMetadata = vi
      .fn()
      .mockRejectedValueOnce(conflictRejection())
      .mockResolvedValueOnce({
        blocks: [],
        metadata: { title: "NJ PBS Home" },
        version: 3,
      });
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
        _baseVersion?: number,
      ) => ({
        blocks,
        version: 4,
      }),
    );

    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        savePage={savePage}
        savePageMetadata={savePageMetadata}
        newId={counterIds()}
      />,
    );

    fireEvent.change(await screen.findByLabelText(/^Page title/), {
      target: { value: "NJ PBS Home" },
    });
    clickWorkspaceAction("Save metadata");
    await screen.findByText(
      /Someone else saved this page while you were editing its metadata/,
    );
    closeComponentEditor();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    );
    await waitFor(() => expect(savePageMetadata).toHaveBeenCalledTimes(2));

    expect(savePageMetadata.mock.calls[0]![3]).toBe(1);
    expect(savePageMetadata.mock.calls[1]![3]).toBeUndefined();

    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });
    clickWorkspaceAction("Save page");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));

    // The force-saved metadata now claims version 3, but composition still claims the version 1
    // snapshot it was actually composed over and therefore remains protected by the server.
    expect(savePage.mock.calls[0]![3]).toBe(1);
  });

  it("leaves the sibling claim unset when the page was loaded without a version (#670)", async () => {
    // A legacy pre-version document loads with no version, so the save that lands sends no
    // baseVersion and the server checks nothing. That write proves the saved form's own new
    // base and nothing else. Stamping the returned version onto the sibling would hand data
    // that was never re-read a claim of currency it never earned, and the next sibling save
    // would then overwrite remote work while looking perfectly current.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [],
        metadata: { title: "Home" },
      }),
    );
    const savePage = vi
      .fn()
      .mockImplementationOnce(
        async (
          _pageId: PublicPageId,
          _section: SectionId,
          blocks: AdminBlock[],
        ): Promise<PageContent> => ({ blocks, version: 5 }),
      )
      .mockRejectedValueOnce(conflictRejection());
    const savePageMetadata = vi.fn().mockResolvedValue({
      blocks: [],
      metadata: { title: "NJ PBS Home" },
      version: 6,
    });

    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        savePage={savePage}
        savePageMetadata={savePageMetadata}
        newId={counterIds()}
      />,
    );

    await screen.findByLabelText(/^Page title/);
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });
    clickWorkspaceAction("Save page");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    expect(savePage.mock.calls[0]![3]).toBeUndefined();

    closeComponentEditor();
    fireEvent.change(screen.getByLabelText(/^Page title/), {
      target: { value: "NJ PBS Home" },
    });
    clickWorkspaceAction("Save metadata");
    await screen.findByText(/Someone else saved this page while you were editing its metadata/);
    expect(savePageMetadata).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save anyway, overwriting their changes" }));
    await waitFor(() => expect(savePageMetadata).toHaveBeenCalledTimes(1));

    // The explicitly confirmed overwrite still sends no version; the sibling never
    // borrows the composition save's version 5.
    expect(savePageMetadata.mock.calls[0]![3]).toBeUndefined();

    // ...and composition keeps the version its own write produced, so once the metadata save
    // advances the stored document the next block save is refused rather than silently
    // replacing what the metadata write landed on.
    fireEvent.change(headingField(), {
      target: { value: "Later tonight" },
    });
    clickWorkspaceAction("Save page");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(2));
    expect(savePage.mock.calls[1]![3]).toBe(5);
    expect(
      await screen.findByText(/Someone else saved this page/i),
    ).toBeTruthy();
    // Three saves and a conflict round: more work than the default budget reliably covers on a
    // loaded machine.
  }, 15000);

  it("does not restore a sibling's version onto a draft that deliberately claims none (#670)", async () => {
    // The unclaimed sibling has to survive a surface switch. Restoring a page reads each form's
    // claim from its own retained draft and falls back to the other only when a form has no
    // draft at all. A draft that exists while claiming nothing is the deliberate state this fix
    // creates, so treating its absent version as "ask the sibling" would hand the composition
    // the metadata save's version through the back door.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [],
        metadata: { title: "Home" },
      }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
        _baseVersion?: number,
        _createOnly?: boolean,
      ): Promise<PageContent> => ({ blocks, version: 7 }),
    );
    const savePageMetadata = vi.fn().mockResolvedValue({
      blocks: [],
      metadata: { title: "NJ PBS Home" },
      version: 6,
    });

    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        savePage={savePage}
        savePageMetadata={savePageMetadata}
        newId={counterIds()}
      />,
    );

    await screen.findByLabelText(/^Page title/);
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });
    closeComponentEditor();
    fireEvent.change(screen.getByLabelText(/^Page title/), {
      target: { value: "NJ PBS Home" },
    });
    clickWorkspaceAction("Save metadata");
    await waitFor(() => expect(savePageMetadata).toHaveBeenCalledTimes(1));

    // Leave metadata dirty again, so the retained metadata draft carries the version its save
    // earned while the composition draft beside it still carries none.
    closeComponentEditor();
    fireEvent.change(screen.getByLabelText(/^Page title/), {
      target: { value: "NJ PBS Home page" },
    });

    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");
    const heading = (await findHeadingField()) as HTMLTextAreaElement;
    expect(heading.value).toBe("Tonight on NJ PBS");

    clickWorkspaceAction("Save page");
    await screen.findByText(/Someone else saved this page/);
    expect(savePage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save anyway, overwriting their changes" }));
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    expect(savePage.mock.calls[0]![3]).toBeUndefined();
    // Two hydrations, a save, and a full editor remount: more work than the default budget
    // reliably covers on a loaded machine.
  }, 15000);

  it("advances both claims when an ordinary save proved a real version current", async () => {
    // The counterpart to the case above: a page that loaded with a version sends it, so the
    // server did check the whole document. That save is a proof about the page, and the
    // sibling form may adopt the returned version instead of raising a false conflict.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [],
        metadata: { title: "Home" },
        version: 1,
      }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
        _baseVersion?: number,
        _createOnly?: boolean,
      ): Promise<PageContent> => ({ blocks, version: 2 }),
    );
    const savePageMetadata = vi.fn().mockResolvedValue({
      blocks: [],
      metadata: { title: "NJ PBS Home" },
      version: 3,
    });

    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        savePage={savePage}
        savePageMetadata={savePageMetadata}
        newId={counterIds()}
      />,
    );

    await screen.findByLabelText(/^Page title/);
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });
    clickWorkspaceAction("Save page");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    expect(savePage.mock.calls[0]![3]).toBe(1);

    closeComponentEditor();
    fireEvent.change(screen.getByLabelText(/^Page title/), {
      target: { value: "NJ PBS Home" },
    });
    clickWorkspaceAction("Save metadata");
    await waitFor(() => expect(savePageMetadata).toHaveBeenCalledTimes(1));
    expect(savePageMetadata.mock.calls[0]![3]).toBe(2);
  });

  it("advances both claims after a create, which proved the page was absent (#670)", async () => {
    // A create sends no baseVersion either, but it is not unproven: the create-only claim made
    // the server refuse the write unless the page was still absent (#567). The returned
    // version therefore describes a document this session wrote, so the metadata form may
    // claim it and stays guarded on its own next save.
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [],
        metadata: { title: "Home" },
        expectedAbsent: true,
      }),
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
        _baseVersion?: number,
        _createOnly?: boolean,
      ): Promise<PageContent> => ({ blocks, version: 1 }),
    );
    const savePageMetadata = vi.fn().mockResolvedValue({
      blocks: [],
      metadata: { title: "NJ PBS Home" },
      version: 2,
    });

    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        savePage={savePage}
        savePageMetadata={savePageMetadata}
        newId={counterIds()}
      />,
    );

    await screen.findByLabelText(/^Page title/);
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });
    clickWorkspaceAction("Save page");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    expect(savePage.mock.calls[0]![3]).toBeUndefined();
    expect(savePage.mock.calls[0]![4]).toBe(true);

    closeComponentEditor();
    fireEvent.change(screen.getByLabelText(/^Page title/), {
      target: { value: "NJ PBS Home" },
    });
    clickWorkspaceAction("Save metadata");
    await waitFor(() => expect(savePageMetadata).toHaveBeenCalledTimes(1));
    expect(savePageMetadata.mock.calls[0]![3]).toBe(1);
    expect(savePageMetadata.mock.calls[0]![4]).toBeUndefined();
  });

  it("does not offer an overwrite after another editor creates a page that was absent on load", async () => {
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [],
        expectedAbsent: true,
      }),
    );
    const savePage = vi.fn().mockRejectedValue(conflictRejection());
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await openHomeAndEdit();

    clickWorkspaceAction("Save page");

    expect(
      await screen.findByText(
        /This page was created while you were editing it/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Reload the page, discarding your changes",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    ).toBeNull();
    expect(savePage).toHaveBeenCalledTimes(1);
    expect(savePage.mock.calls[0]![4]).toBe(true);
  });

  it("restores the normal overwrite choice after this editor successfully creates the page", async () => {
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [],
        expectedAbsent: true,
      }),
    );
    const savePage = vi
      .fn()
      .mockImplementationOnce(
        async (
          _pageId: PublicPageId,
          _section: SectionId,
          blocks: AdminBlock[],
        ): Promise<PageContent> => ({ blocks, version: 1 }),
      )
      .mockRejectedValueOnce(conflictRejection());
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await openHomeAndEdit();

    clickWorkspaceAction("Save page");
    expect(await screen.findByText("Saved.")).toBeTruthy();

    fireEvent.change(headingField(), {
      target: { value: "A second edit" },
    });
    clickWorkspaceAction("Save page");

    expect(
      await screen.findByText(
        /Someone else saved this page while you were editing it/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    ).toBeTruthy();
    expect(savePage.mock.calls[0]![4]).toBe(true);
    expect(savePage.mock.calls[1]![3]).toBe(1);
    expect(savePage.mock.calls[1]![4]).toBeUndefined();
  });

  it("re-reads the page and reseeds the editor when the person reloads", async () => {
    // The trap this guards: BlockEditor takes initialBlocks as useReducer's lazy-init argument,
    // so it is read once at mount. A reload that only swapped the prop would leave the person
    // looking at their own stale blocks while believing they had the current page. It works
    // because hydration goes back through `loading`, which unmounts the editor. Asserting the
    // new content is on screen is what keeps that true.
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ blocks: [], version: 1 })
      .mockResolvedValueOnce({ blocks: [storedHeadline], version: 2 });
    const savePage = vi.fn().mockRejectedValue(conflictRejection());
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await openHomeAndEdit();

    clickWorkspaceAction("Save page");
    await screen.findByText(/Someone else saved this page/);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Reload the page, discarding your changes",
      }),
    );

    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
    // The other editor's headline is on screen...
    expect(await screen.findByDisplayValue("Existing headline")).toBeTruthy();
    // ...and this person's unsaved edit is gone, which is what they were told reloading costs.
    expect(screen.queryByDisplayValue("Tonight on NJ PBS")).toBeNull();
    // The conflict went with the remount, so the page is savable again.
    expect(screen.queryByText(/Someone else saved this page/)).toBeNull();
  });

  it("claims the reloaded version, not the one it started from", async () => {
    // The whole point of reloading is to compose against what is stored now. Echoing the old
    // version afterwards would refuse a save that is no longer stale.
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ blocks: [], version: 1 })
      .mockResolvedValueOnce({ blocks: [storedHeadline], version: 2 });
    const savePage = vi
      .fn()
      .mockRejectedValueOnce(conflictRejection())
      .mockImplementation(
        async (_pageId: PublicPageId, _s: SectionId, blocks: AdminBlock[]) => ({
          blocks,
          version: 3,
        }),
      );
    render(
      <EditorWorkspace
        principal={editor}
        savePage={savePage}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await openHomeAndEdit();

    clickWorkspaceAction("Save page");
    await screen.findByText(/Someone else saved this page/);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reload the page, discarding your changes",
      }),
    );
    await screen.findByDisplayValue("Existing headline");

    fireEvent.change(headingField(), {
      target: { value: "Composed on their version" },
    });
    clickWorkspaceAction("Save page");

    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(2));
    expect(savePage.mock.calls[0]![3]).toBe(1);
    expect(savePage.mock.calls[1]![3]).toBe(2);
  });
});

// Leaving a surface must not destroy work in progress (#579). Both editors are keyed on the
// surface, so a switch unmounts them and their state goes with them: the record's fields live
// in RecordForm, the blocks in BlockEditor. Nothing guarded that. `saving` held navigation
// only while a request was in flight, which protects work the editor is writing but not work
// someone is still typing.
//
// The contract these pin: keep a dirty surface's work, re-read a clean one. An untouched page
// should still show someone else's change when you come back to it; a page you have edited
// should still be yours. The version echoed on save travels with the blocks it describes, so
// a preserved edit still saves against the version it was composed over (#530).
describe("EditorWorkspace unsaved work survives a surface switch (#579)", () => {
  it("keeps unsaved record fields when the surface is left and reselected", () => {
    render(<EditorWorkspace principal={editor} />);

    clickWorkspaceAction("Event");
    fireEvent.change(screen.getByLabelText(/^Location/), {
      target: { value: "Half-written location" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Program" }));
    clickWorkspaceAction("Event");

    expect((screen.getByLabelText(/^Location/) as HTMLInputElement).value).toBe(
      "Half-written location",
    );
  });

  it("keeps unsaved page blocks when the surface is left and reselected", async () => {
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [],
        version: 3,
      }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );

    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Tonight on NJ PBS" },
    });

    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");

    const heading = (await findHeadingField()) as HTMLTextAreaElement;
    expect(heading.value).toBe("Tonight on NJ PBS");
  });

  it("keeps the publication receipt with a retained page draft", async () => {
    const loadPage = vi.fn(async (): Promise<PageContent> => ({
      blocks: [],
      status: "draft",
      version: 12,
      publiclyVisible: true,
      publicSourceVersion: 8,
      publishedSourceVersion: 10,
      publishBuildPending: true,
      publishBuildQueueId: "queue-10",
    }));
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );

    await screen.findByText("A published copy was last recorded");
    expect(screen.getByText("Checking publication status.")).toBeInTheDocument();
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Retained home edit" },
    });

    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");

    expect(await findHeadingField()).toHaveValue("Retained home edit");
    expect(screen.getByText("A published copy was last recorded")).toBeInTheDocument();
    expect(screen.getByText("Checking publication status.")).toBeInTheDocument();
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("re-reads a clean page on return so someone else's change is visible", async () => {
    let read = 0;
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => {
        read += 1;
        return {
          blocks: [
            {
              id: "s1",
              type: "headline",
              order: 0,
              visible: true,
              data: {
                text:
                  read === 1 ? "Their first headline" : "Their newer headline",
              },
            } as AdminBlock,
          ],
          version: read,
        };
      },
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await screen.findByDisplayValue("Their first headline");

    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");

    await screen.findByDisplayValue("Their newer headline");
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  // A save with nothing typed while it was in flight makes the page clean again, so it must go
  // back to reading. Keeping the draft here would restore the snapshot the save produced and
  // hide a change someone else made afterwards, which is the "re-read a clean one" half of the
  // contract failing in the exact case that looks most like success.
  it("re-reads a page that was edited and then saved, rather than restoring it", async () => {
    let read = 0;
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => {
        read += 1;
        return { blocks: [], version: read };
      },
    );
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _s: SectionId,
        blocks: AdminBlock[],
        _baseVersion?: number,
      ) => ({
        blocks,
        version: 9,
      }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        savePage={savePage}
        newId={counterIds()}
      />,
    );

    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Saved and done" },
    });
    clickWorkspaceAction("Save page");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    await screen.findByText("Saved.");

    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");

    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
    expect(screen.queryByDisplayValue("Saved and done")).toBeNull();
  });

  // The other side of that boundary: an edit made while the save was in flight is still
  // unsaved, so the save must not be read as a blanket commit. Navigation is held during a
  // save, so this is only reachable after it settles -- and that is exactly when the draft has
  // to still be there.
  it("keeps a draft when the page was edited while its save was in flight", async () => {
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [],
        version: 1,
      }),
    );
    let release: (value: PageContent) => void = () => {};
    const savePage = vi.fn(
      (
        _pageId: PublicPageId,
        _s: SectionId,
        _blocks: AdminBlock[],
        _baseVersion?: number,
      ) =>
        new Promise<PageContent>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        savePage={savePage}
        newId={counterIds()}
      />,
    );

    await screen.findByRole("button", { name: /^Add (?:block|content): position 1$/ });
    addBlock("heading");
    fireEvent.change(headingField(), {
      target: { value: "Sent to the server" },
    });
    clickWorkspaceAction("Save page");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));

    // Typed while the save is still open. This is the edit the save never carried.
    fireEvent.change(headingField(), {
      target: { value: "Typed while saving" },
    });
    await act(async () => {
      release({ blocks: savePage.mock.calls[0]![2], version: 2 });
    });

    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");

    const heading = (await findHeadingField()) as HTMLTextAreaElement;
    expect(heading.value).toBe("Typed while saving");
    expect(loadPage).toHaveBeenCalledTimes(1);
  });
});

// The admin runs inside React StrictMode: `main.tsx` mounts it there, and so does the design
// gallery. StrictMode replays mount effects without resetting refs, so a draft guard that counts
// runs gets consumed by the first pass, and the replay reports an untouched surface as unsaved
// work -- after which the host restores that stale snapshot forever instead of re-reading. The
// rest of this suite mounts bare and structurally cannot see that, so these mount the way
// production does.
describe("EditorWorkspace draft reporting under StrictMode (#579)", () => {
  const headline = (text: string): AdminBlock =>
    ({
      id: "s1",
      type: "headline",
      order: 0,
      visible: true,
      data: { text, level: 2 },
    }) as AdminBlock;

  it("re-reads an untouched page when it is left and reselected", async () => {
    let read = 0;
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => {
        read += 1;
        return { blocks: [headline(`Read ${read}`)], version: read };
      },
    );

    render(
      <StrictMode>
        <EditorWorkspace principal={editor} loadPage={loadPage} />
      </StrictMode>,
    );
    await screen.findByDisplayValue(/^Read /);
    const afterMount = loadPage.mock.calls.length;

    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");

    // Nobody edited it, so returning must read the page again rather than restore the snapshot
    // the mount happened to leave behind.
    await waitFor(() =>
      expect(loadPage.mock.calls.length).toBe(afterMount + 1),
    );
  });

  it("still keeps an edited page when it is left and reselected", async () => {
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => ({
        blocks: [headline("Stored headline")],
        version: 1,
      }),
    );

    render(
      <StrictMode>
        <EditorWorkspace principal={editor} loadPage={loadPage} />
      </StrictMode>,
    );
    await screen.findByDisplayValue("Stored headline");
    fireEvent.change(headingField(), {
      target: { value: "Edited headline" },
    });
    const afterMount = loadPage.mock.calls.length;

    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");

    // The guard must not over-correct: real work still survives the round trip, and the page is
    // not re-read over it.
    expect(await screen.findByDisplayValue("Edited headline")).toBeTruthy();
    expect(loadPage.mock.calls.length).toBe(afterMount);
  });

  it("restores an edited page without rendering a loading state (#601)", async () => {
    const loadPage = vi.fn(async (): Promise<PageContent> => ({
      blocks: [headline("Stored headline")],
      version: 1,
    }));
    const { container } = render(
      <StrictMode>
        <EditorWorkspace principal={editor} loadPage={loadPage} />
      </StrictMode>,
    );
    await screen.findByDisplayValue("Stored headline");
    fireEvent.change(headingField(), {
      target: { value: "Edited headline" },
    });
    const afterMount = loadPage.mock.calls.length;
    clickWorkspaceAction("Event");

    // The loading node may be added and removed inside one React interaction, leaving no
    // queryable trace after fireEvent returns. Observe DOM additions so the test catches that
    // transient flash as well as a loading state that remains on screen.
    const addedText: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          addedText.push(node.textContent ?? "");
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true });

    clickWorkspaceAction("Home page");
    expect(await screen.findByDisplayValue("Edited headline")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    observer.disconnect();

    expect(addedText.some((text) => text.includes("Loading the page"))).toBe(
      false,
    );
    expect(loadPage).toHaveBeenCalledTimes(afterMount);
  });
});

// The record half of the same contract (#579). A page re-reads when clean; a record has no read
// to repeat, so its clean point shows up as a blank form. Getting this wrong costs more than a
// stale view: a restored saved record carries its id, and the next save writes to that id.
describe("EditorWorkspace record drafts settle on save (#579)", () => {
  const mintingSaveRecord = () =>
    vi.fn(async (_kind: RecordKind, record: Record<string, unknown>) => ({
      ...record,
      id: "spo-1",
    }));

  it("opens a blank form after a saved record is left and reselected", async () => {
    const saveRecord = mintingSaveRecord();
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));

    // It was saved, so there is no unsaved work to keep and nothing to restore.
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("");
  });

  // A typo fixed right after saving is the routine way to reach this: the record ends up holding
  // exactly what was saved, in a new object. Identity alone reads that as unsaved work.
  it("opens a blank form when an edit after a save is taken back", async () => {
    const saveRecord = mintingSaveRecord();
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundationn" },
    });
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });

    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));

    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("");
  });

  it("writes a new document after an edit is taken back rather than the one saved before it", async () => {
    const saveRecord = mintingSaveRecord();
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundationn" },
    });
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });

    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Bell Labs" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://bell.example" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(2));

    // Restoring the taken-back edit would carry spo-1 into this save and overwrite Acme with Bell.
    expect(saveRecord.mock.calls[1]![1]).toMatchObject({ name: "Bell Labs" });
    expect(saveRecord.mock.calls[1]![1].id).toBeUndefined();
  });

  // A save the test controls, so an edit can be composed while the request is still out. The
  // immediate-resolve helper above cannot reach that window: it lands before anything can be typed.
  const heldSaveRecord = () => {
    let land!: () => void;
    const landed = new Promise<void>((resolve) => {
      land = resolve;
    });
    const saveRecord = vi.fn(
      async (_kind: RecordKind, record: Record<string, unknown>) => {
        await landed;
        return { ...record, id: "spo-1" };
      },
    );
    return { saveRecord, land };
  };

  // The same taken-back edit, composed while the save was in flight rather than after it landed.
  // The save is still a clean point -- the server holds what was sent -- so an edit back onto that
  // content owes nothing, exactly as it would have a moment later.
  it("opens a blank form when an edit made during a save is taken back", async () => {
    const { saveRecord, land } = heldSaveRecord();
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    // Typed after the request left and before the server answered.
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundationn" },
    });
    await act(async () => {
      land();
    });
    // Taken back to exactly what the save persisted.
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });

    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));

    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("");
  });

  it("writes a new document after an edit made during a save is taken back", async () => {
    const { saveRecord, land } = heldSaveRecord();
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundationn" },
    });
    await act(async () => {
      land();
    });
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });

    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Bell Labs" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://bell.example" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(2));

    // A settle point left on the pre-save seed carries spo-1 into this save and overwrites Acme.
    expect(saveRecord.mock.calls[1]![1]).toMatchObject({ name: "Bell Labs" });
    expect(saveRecord.mock.calls[1]![1].id).toBeUndefined();
  });

  // The over-correction guard for the in-flight window: an edit composed during a save and *kept*
  // is real unsaved work on the saved document, so it survives the surface change with its id.
  it("keeps an edit made during a save, still addressed to the saved document", async () => {
    const { saveRecord, land } = heldSaveRecord();
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation Inc" },
    });
    await act(async () => {
      land();
    });

    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));

    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      "Acme Foundation Inc",
    );
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(2));
    expect(saveRecord.mock.calls[1]![1].id).toBe("spo-1");
  });

  // The inverse trap. A restored draft is unsaved work, so it is not a clean point to compare
  // against: an edit that lands back on it must stay stashed. Reading the seed as clean here would
  // turn the fix above into a worse bug — the host would drop the very work it just handed back.
  it("keeps a restored draft when an edit to it is taken back", async () => {
    render(
      <EditorWorkspace principal={editor} saveRecord={mintingSaveRecord()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Half-written" },
    });

    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      "Half-written",
    );

    // Edit the restored draft and take it back. Nothing was ever saved, so this is still work.
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Half-writtenn" },
    });
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Half-written" },
    });

    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      "Half-written",
    );
  });

  // The guard against over-correcting: a real edit after a save is work, and it is work on *that*
  // document, so it keeps its id and the next save updates the record rather than duplicating it.
  it("keeps a real edit made after a save, still addressed to the saved document", async () => {
    const saveRecord = mintingSaveRecord();
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation Inc" },
    });
    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));

    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      "Acme Foundation Inc",
    );
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(2));
    expect(saveRecord.mock.calls[1]![1].id).toBe("spo-1");
  });

  it("still keeps a record that was edited but never saved", async () => {
    const saveRecord = mintingSaveRecord();
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });

    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));

    // The settle must not over-correct. This is the whole point of #579: unsaved work survives.
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      "Acme Foundation",
    );
    expect(saveRecord).not.toHaveBeenCalled();
  });

  it("writes a new document rather than the one saved before it", async () => {
    const saveRecord = mintingSaveRecord();
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Bell Labs" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://bell.example" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(2));

    // Carrying spo-1 into this save would silently overwrite the sponsor saved a moment ago
    // with a different sponsor's details.
    expect(saveRecord.mock.calls[1]![1]).toMatchObject({ name: "Bell Labs" });
    expect(saveRecord.mock.calls[1]![1].id).toBeUndefined();
  });
});

// Content that changes and changes back is not unsaved work (#595). The page and record editors
// report a draft on array/object identity, which is cheap and right for the common cases, but an
// edit undone leaves a new object holding the loaded-or-saved content. Identity reads that as a
// draft; the host must compare content at the surface-switch boundary and treat a match as clean.
describe("EditorWorkspace treats reverted edits as clean (#595)", () => {
  it("re-reads after reverting an edit on a page whose headline level was normalized", async () => {
    let read = 0;
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => {
        read += 1;
        return {
          blocks: [
            {
              id: "s1",
              type: "headline",
              order: 0,
              visible: true,
              data: {
                text: `Headline read ${read}`,
                level: read === 1 ? 9 : 6,
              },
            } as AdminBlock,
          ],
          version: read,
        };
      },
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await screen.findByDisplayValue("Headline read 1");

    addBlock("divider");
    clickWorkspaceAction("Undo");
    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");

    await screen.findByDisplayValue("Headline read 2");
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("re-reads a page whose only edit was undone back to the loaded content", async () => {
    let read = 0;
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => {
        read += 1;
        return {
          blocks: [
            {
              id: "s1",
              type: "headline",
              order: 0,
              visible: true,
              data: {
                text:
                  read === 1 ? "Their first headline" : "Their newer headline",
              },
            } as AdminBlock,
          ],
          version: read,
        };
      },
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await screen.findByDisplayValue("Their first headline");

    // Add a block, then undo it: the page is back to exactly what was loaded, in a new array.
    addBlock("divider");
    clickWorkspaceAction("Undo");

    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");

    // No unsaved work, so it re-reads and shows the change made in the store meanwhile.
    await screen.findByDisplayValue("Their newer headline");
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("keeps a page whose edit really stands, and re-reads only once it is reverted", async () => {
    // The guard must not over-correct: a genuine edit still survives the round trip.
    let read = 0;
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => {
        read += 1;
        return {
          blocks: [
            {
              id: "s1",
              type: "headline",
              order: 0,
              visible: true,
              data: { text: "Loaded" },
            } as AdminBlock,
          ],
          version: read,
        };
      },
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await screen.findByDisplayValue("Loaded");

    // A standing edit: a divider added and not undone.
    addBlock("divider");
    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");
    // The draft is restored, not re-read.
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(await screen.findByText("2 blocks in outline")).toHaveClass("sr-only");
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("opens a blank form when an edit is taken back only after a remount", async () => {
    // The record editor's clean point does not survive its own unmount, so a takeback after a
    // remount can only be caught by the host holding the saved baseline beside the draft.
    const saveRecord = vi.fn(
      async (_kind: RecordKind, record: Record<string, unknown>) => ({
        ...record,
        id: "spo-1",
      }),
    );
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    // Edit after the save, then remount by leaving and returning BEFORE taking the edit back.
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundationn" },
    });
    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      "Acme Foundationn",
    );

    // Take the edit back on the remounted form, whose clean point did not survive the unmount.
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));

    // The content matches the saved record, so there is nothing to keep: a blank form.
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("");
  });

  it("writes a new document after an edit taken back only post-remount", async () => {
    const saveRecord = vi.fn(
      async (_kind: RecordKind, record: Record<string, unknown>) => ({
        ...record,
        id: "spo-1",
      }),
    );
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundationn" },
    });
    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));

    // Write a different sponsor. Carrying spo-1 back into this save would overwrite Acme.
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Bell Labs" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://bell.example" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(2));
    expect(saveRecord.mock.calls[1]![1]).toMatchObject({ name: "Bell Labs" });
    expect(saveRecord.mock.calls[1]![1].id).toBeUndefined();
  });

  // A clean-match on return must delete the draft, not just report it clean. The re-read it
  // triggers can bring back newer server content, which advances the page baseline; a surviving
  // draft would then no longer match that newer baseline and be restored as stale unsaved work on
  // the next visit -- hiding the current page and setting up an overwrite.
  it("does not restore a cleared page draft after the re-read advances the baseline", async () => {
    let read = 0;
    const loadPage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
      ): Promise<PageContent> => {
        read += 1;
        return {
          blocks: [
            {
              id: "s1",
              type: "headline",
              order: 0,
              visible: true,
              data: { text: `Headline read ${read}` },
            } as AdminBlock,
          ],
          version: read,
        };
      },
    );
    render(
      <EditorWorkspace
        principal={editor}
        loadPage={loadPage}
        newId={counterIds()}
      />,
    );
    await screen.findByDisplayValue("Headline read 1");

    // Add a block and undo it: the page is back to the loaded content, in a new array.
    addBlock("divider");
    clickWorkspaceAction("Undo");

    // First round trip: the clean draft re-reads, and the baseline advances to read 2.
    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");
    await screen.findByDisplayValue("Headline read 2");
    expect(loadPage).toHaveBeenCalledTimes(2);

    // Second round trip: the cleared draft must be gone, so this re-reads again rather than
    // restoring the stale first snapshot over the newer page.
    clickWorkspaceAction("Event");
    clickWorkspaceAction("Home page");
    await screen.findByDisplayValue("Headline read 3");
    expect(loadPage).toHaveBeenCalledTimes(3);
    expect(screen.queryByDisplayValue("Headline read 1")).toBeNull();
  });

  // The clean baseline for a record is the form-shaped record, not the raw server echo. Production
  // saveRecord returns the whole stored document -- type, status, timestamps, version -- but the
  // form only ever holds its own fields plus the server id. If the baseline kept those server-only
  // fields, a reverted edit (which carries only the form fields) would never match it, so the
  // id-bearing draft would be restored post-remount and the next save would update the saved
  // document instead of creating a new one.
  const echoingSaveRecord = () =>
    vi.fn(async (_kind: RecordKind, record: Record<string, unknown>) => ({
      ...record,
      id: "spo-1",
      type: "sponsor",
      status: "draft",
      createdAt: 1000,
      updatedAt: 2000,
      version: 1,
    }));

  it("opens a blank form when a saved record's edit is reverted post-remount, even when the server echo carries extra fields", async () => {
    const saveRecord = echoingSaveRecord();
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    // Edit after the save, remount, then revert to exactly the saved content on the remounted form.
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundationn" },
    });
    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));

    // The reverted content matches the saved record, so there is nothing to keep: a blank form.
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("");
  });

  it("writes a new document after a reverted edit against an extra-field server echo", async () => {
    const saveRecord = echoingSaveRecord();
    render(<EditorWorkspace principal={editor} saveRecord={saveRecord} />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://acme.org" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundationn" },
    });
    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Acme Foundation" },
    });
    clickWorkspaceAction("Event");
    fireEvent.click(screen.getByRole("button", { name: "Sponsor" }));

    // Write a different sponsor. Carrying spo-1 back into this save would overwrite Acme.
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Bell Labs" },
    });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://bell.example" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(saveRecord).toHaveBeenCalledTimes(2));
    expect(saveRecord.mock.calls[1]![1]).toMatchObject({ name: "Bell Labs" });
    expect(saveRecord.mock.calls[1]![1].id).toBeUndefined();
  });
});

describe("EditorWorkspace courtesy locks (#592)", () => {
  const storedPage = (): Promise<PageContent> =>
    Promise.resolve({
      blocks: [
        {
          id: "headline-1",
          type: "headline",
          order: 0,
          visible: true,
          data: { text: "Original headline", level: 2 },
        } as AdminBlock,
      ],
      metadata: { title: "Home" },
      createdBy: "admin",
      status: "draft",
      version: 4,
    });

  it("reserves a clean editor before a page lifecycle action", async () => {
    const locks = fakeEditorLockClient();
    let page: PageContent = {
      blocks: [],
      metadata: { title: "Home" },
      createdBy: "admin",
      status: "published",
      version: 4,
    };
    const loadPage = vi.fn(async () => page);
    const transitionContent = vi.fn(async () => {
      page = { ...page, status: "draft", version: 5 };
      return {
        success: true as const,
        collection: "cmsPages" as const,
        id: "home",
        action: "unpublish" as const,
        fromStatus: "published" as const,
        toStatus: "draft" as const,
        version: 5,
        document: { id: "home", status: "draft", version: 5 },
      };
    });

    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={loadPage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
          transitionContent={transitionContent}
        />
      </MemoryRouter>,
    );

    const unpublish = await screen.findByRole("button", { name: "Unpublish" });
    await waitFor(() => expect(unpublish).toBeEnabled());
    fireEvent.click(unpublish);
    fireEvent.click(screen.getByRole("button", { name: "Confirm unpublish" }));

    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(transitionContent).toHaveBeenCalledWith({
        collection: "cmsPages",
        id: "home",
        action: "unpublish",
        baseVersion: 4,
      }),
    );
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
  });

  it("reserves a clean editor for restore and freezes both page editors until reload", async () => {
    const locks = fakeEditorLockClient();
    const pendingRestore = deferred<RestoreRevisionResponse>();
    const loadRevisions = vi.fn(async (): Promise<ListRevisionsResponse> => ({
      success: true,
      nextCursor: null,
      entries: [
        {
          id: "revision-2",
          action: "update",
          actorUid: "editor-1",
          actorEmail: "editor@example.com",
          at: "2026-08-12T20:15:00.000Z",
          beforeVersion: 1,
          version: 2,
          beforeStatus: "draft",
          status: "draft",
          beforeBlockCount: 1,
          blockCount: 1,
          mediaReferenceCount: 0,
          mediaReferencesAdded: 0,
          mediaReferencesRemoved: 0,
          beforeTruncated: false,
          diffAvailable: true,
          changedFields: ["title"],
          changedFieldCount: 1,
          changedFieldsTruncated: false,
        },
      ],
    }));
    const loadRevision = vi.fn(async (): Promise<GetRevisionResponse> => ({
      success: true,
      revision: {
        id: "revision-2",
        collection: "cmsPages",
        documentId: "home",
        action: "update",
        actorUid: "editor-1",
        actorEmail: "editor@example.com",
        at: "2026-08-12T20:15:00.000Z",
        beforeTruncated: false,
        before: { title: "Earlier home", version: 1 },
        after: { title: "Historical home", version: 2 },
      },
    }));
    const restoreRevision = vi.fn(() => pendingRestore.promise);
    const loadPage = vi.fn(storedPage);

    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={loadPage}
          loadRevision={loadRevision}
          loadRevisions={loadRevisions}
          restoreRevision={restoreRevision}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>,
    );

    await screen.findByDisplayValue("Original headline");
    const pageTitle = await screen.findByLabelText(/^Page title/);
    fireEvent.click(screen.getByRole("button", { name: "Revision history" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Inspect version 2" }),
    );
    const restoreButton = await screen.findByRole("button", {
      name: "Restore version 2",
    });
    expect(restoreButton).toBeEnabled();
    fireEvent.click(restoreButton);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm restore of version 2" }),
    );

    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(restoreRevision).toHaveBeenCalledWith(
        "cmsPages",
        "home",
        "revision-2",
        4,
      ),
    );
    expect(screen.getByDisplayValue("Original headline")).toBeDisabled();
    expect(pageTitle).toBeDisabled();
    for (const trigger of screen.getAllByRole("button", {
      name: /Add (?:block|content): position/,
    })) {
      expect(trigger).toBeDisabled();
    }

    await act(async () => {
      pendingRestore.resolve({
        success: true,
        collection: "cmsPages",
        id: "home",
        revisionId: "revision-5",
        sourceRevisionId: "revision-2",
        sourceVersion: 2,
        version: 5,
        document: { title: "Historical home", version: 5 },
      });
    });
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
  });

  it("reserves the record on open, before any local change", async () => {
    // Opening an editor claims its lease before typing and retains it while clean (#1047).
    const locks = fakeEditorLockClient();
    render(
      <EditorWorkspace
        principal={admin}
        editorLockActor={lockActor}
        editorLockClient={locks.client}
        loadPage={storedPage}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    await screen.findByDisplayValue("Original headline");
    expect(locks.client.subscribe).toHaveBeenCalledWith(
      "cmsPages:home",
      expect.any(Function),
      expect.any(Function),
    );
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    expect(locks.client.claim).toHaveBeenCalledWith(
      "cmsPages:home",
      lockActor,
      expect.any(String),
      { force: false },
    );
    expect(locks.currentLock()).toMatchObject({ ownerId: lockActor.id });
  });

  it("does not reserve content for a principal without save access", async () => {
    const locks = fakeEditorLockClient();
    render(
      <EditorWorkspace
        principal={readOnly}
        editorLockActor={{ id: "viewer", name: "Vera Viewer" }}
        editorLockClient={locks.client}
        loadPage={storedPage}
        savePage={async (_pageId, _section, blocks) => ({ blocks, version: 5 })}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    fireEvent.change(await screen.findByDisplayValue("Original headline"), {
      target: { value: "A local read-only change" },
    });
    await act(async () => {});

    expect(locks.client.subscribe).not.toHaveBeenCalled();
    expect(locks.client.claim).not.toHaveBeenCalled();
    expect(
      screen.getAllByText("Your role cannot save this page."),
    ).toHaveLength(2);
  });

  it("explains a disabled combined Update action", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    render(
      <WorkspaceActionsProvider target={target}>
        <EditorWorkspace
          principal={readOnly}
          loadPage={storedPage}
          savePage={async (_pageId, _section, blocks) => ({
            blocks,
            version: 5,
          })}
          savePageMetadata={async (_pageId, _section, metadata) => ({
            blocks: [],
            metadata,
            version: 5,
          })}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </WorkspaceActionsProvider>,
    );

    const update = await screen.findByRole("button", {
      name: "Save draft",
    });
    const explanation = screen.getByRole("group", {
      name: "Save draft unavailable: Your role cannot save this page.",
    });
    expect(update).toBeDisabled();
    expect(explanation).toHaveAttribute(
      "title",
      "Your role cannot save this page.",
    );
    expect(explanation).toHaveAttribute("tabindex", "0");
    target.remove();
  });

  it("explains clean and saving states for the combined Update action", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const pendingSave = deferred<PageContent>();
    const savePage = vi.fn(
      (
        _pageId: PublicPageId,
        _section: SectionId,
        _blocks: AdminBlock[],
      ) => pendingSave.promise,
    );
    render(
      <WorkspaceActionsProvider target={target}>
        <EditorWorkspace
          principal={editor}
          loadPage={storedPage}
          savePage={savePage}
          savePageMetadata={async (_pageId, _section, metadata) => ({
            blocks: [],
            metadata,
            version: 5,
          })}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </WorkspaceActionsProvider>,
    );

    const update = await screen.findByRole("button", { name: "Save draft" });
    expect(update).toBeDisabled();
    expect(
      screen.getByRole("group", {
        name: "Save draft unavailable: There are no changes to save.",
      }),
    ).toHaveAttribute("title", "There are no changes to save.");

    fireEvent.change(await findHeadingField(), {
      target: { value: "Updated headline" },
    });
    await waitFor(() => expect(update).toBeEnabled());
    fireEvent.click(update);
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));

    expect(screen.getByRole("button", { name: /^.+: Saving…$/ }))
      .not.toBeDisabled();
    expect(screen.getByRole("button", { name: /^.+: Saving…$/ }))
      .toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByRole("group", {
        name: "Save draft unavailable: Wait for the current save to finish.",
      }),
    ).not.toBeInTheDocument();

    await act(async () => {
      pendingSave.resolve({
        blocks: savePage.mock.calls[0]![2],
        metadata: { title: "Home" },
        version: 5,
      });
    });
    target.remove();
  });

  it("keeps a collapsed panel closed when saving an unfinished draft", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    render(
      <WorkspaceActionsProvider target={target}>
        <EditorWorkspace
          principal={editor}
          loadPage={storedPage}
          savePage={async (_pageId, _section, blocks) => ({
            blocks,
            version: 5,
          })}
          savePageMetadata={async (_pageId, _section, metadata) => ({
            blocks: [],
            metadata,
            version: 5,
          })}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </WorkspaceActionsProvider>,
    );

    fireEvent.change(await screen.findByLabelText(/^Page title/), {
      target: { value: "" },
    });
    const metadataPanel = screen.getByRole("button", {
      name: "Page metadata",
    });
    fireEvent.click(metadataPanel);
    expect(metadataPanel).toHaveAttribute("aria-expanded", "false");

    clickWorkspaceAction("Save draft");

    await waitFor(() => expect(target).toHaveTextContent("Saved"));
    expect(metadataPanel).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Fix the highlighted fields/)).toBeNull();
    target.remove();
  });

  it("shows progress while a conflict overwrite runs from the combined page workspace", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const pendingOverwrite = deferred<PageContent>();
    const savePage = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("This document changed since you opened it."), {
          status: 409,
        }),
      )
      .mockImplementationOnce(() => pendingOverwrite.promise);
    render(
      <WorkspaceActionsProvider target={target}>
        <EditorWorkspace
          principal={editor}
          loadPage={storedPage}
          savePage={savePage}
          savePageMetadata={async (_pageId, _section, metadata) => ({
            blocks: [],
            metadata,
            version: 5,
          })}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </WorkspaceActionsProvider>,
    );

    fireEvent.change(await findHeadingField(), {
      target: { value: "Updated headline" },
    });
    clickWorkspaceAction("Save draft");
    await screen.findByText(/Someone else saved this page/);

    closeComponentEditor();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    );
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(2));

    const pending = screen.getByRole("button", {
      name: "Save anyway, overwriting their changes: Saving…",
    });
    expect(pending).toHaveTextContent("Saving…");
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("Saving…", { selector: ".block-editor-save-status" }),
    ).toHaveAttribute("role", "status");
    const conflictAlert = screen
      .getByText(/Someone else saved this page/)
      .closest("[role='alert']");
    expect(conflictAlert).not.toBeNull();
    expect(
      within(conflictAlert as HTMLElement).queryByRole("status"),
    ).toBeNull();
    fireEvent.click(pending);
    expect(savePage).toHaveBeenCalledTimes(2);
    expect(savePage.mock.calls[1]![3]).toBeUndefined();

    await act(async () => {
      pendingOverwrite.resolve({
        blocks: savePage.mock.calls[1]![2],
        version: 6,
      });
    });
    await waitFor(() =>
      expect(screen.queryByText(/Someone else saved this page/)).toBeNull(),
    );
    target.remove();
  });

  it("permits an unfinished draft during a conflict overwrite", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const savePage = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("This document changed since you opened it."), {
          status: 409,
        }),
      )
      .mockImplementationOnce(async (_pageId, _section, blocks) => ({
        blocks,
        version: 6,
      }));
    render(
      <WorkspaceActionsProvider target={target}>
        <EditorWorkspace
          principal={editor}
          loadPage={storedPage}
          savePage={savePage}
          savePageMetadata={async (_pageId, _section, metadata) => ({
            blocks: [],
            metadata,
            version: 5,
          })}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </WorkspaceActionsProvider>,
    );

    const heading = await screen.findByDisplayValue("Original headline");
    expect(headingField()).toBe(heading);
    fireEvent.change(heading, { target: { value: "Updated headline" } });
    clickWorkspaceAction("Save draft");
    await screen.findByText(/Someone else saved this page/);

    expect(headingField()).toBe(heading);
    fireEvent.change(heading, { target: { value: "" } });
    closeComponentEditor();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    );

    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(2));
    expect(savePage.mock.calls[1]![2][0].data.text).toBe("");
    expect(savePage.mock.calls[1]![3]).toBeUndefined();
    await waitFor(() =>
      expect(screen.queryByText(/Someone else saved this page/)).toBeNull(),
    );
    target.remove();
  });

  it("does not report Saved when a sibling editor changes during Update", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const pendingBlocks = deferred<PageContent>();
    const savePage = vi.fn(
      (
        _pageId: PublicPageId,
        _section: SectionId,
        _blocks: AdminBlock[],
      ) => pendingBlocks.promise,
    );
    const savePageMetadata = vi.fn(async (_pageId, _section, metadata) => ({
      blocks: [],
      metadata,
      version: 6,
    }));
    render(
      <WorkspaceActionsProvider target={target}>
        <EditorWorkspace
          principal={editor}
          loadPage={storedPage}
          savePage={savePage}
          savePageMetadata={savePageMetadata}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </WorkspaceActionsProvider>,
    );

    fireEvent.change(await findHeadingField(), {
      target: { value: "Updated blocks" },
    });
    clickWorkspaceAction("Save draft");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));

    closeComponentEditor();
    fireEvent.change(screen.getByLabelText(/^Page title/), {
      target: { value: "Metadata typed during the block save" },
    });
    await act(async () => {
      pendingBlocks.resolve({
        blocks: savePage.mock.calls[0]![2],
        metadata: { title: "Home" },
        version: 5,
      });
    });

    expect(savePageMetadata).not.toHaveBeenCalled();
    expect(target).not.toHaveTextContent("Saved.");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled(),
    );
    target.remove();
  });

  it("holds a fast save until the first-edit lease claim settles", async () => {
    const locks = fakeEditorLockClient();
    let settleClaim: (() => void) | undefined;
    locks.client.claim = vi.fn(
      (surfaceKey, actor, sessionId) =>
        new Promise<EditorLockClaim>((resolve) => {
          settleClaim = () => {
            const acquired: EditorLock = {
              surfaceKey,
              ownerId: actor.id,
              ownerName: actor.name,
              sessionId,
              acquiredAtMs: Date.now(),
              heartbeatAtMs: Date.now(),
              observedAtMs: globalThis.performance.now(),
            };
            locks.emit(acquired);
            resolve({ status: "acquired", lock: acquired });
          };
        }),
    );
    render(
      <EditorWorkspace
        principal={admin}
        editorLockActor={lockActor}
        editorLockClient={locks.client}
        loadPage={storedPage}
        savePage={async (_pageId, _section, blocks) => ({ blocks, version: 5 })}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    const heading = await screen.findByDisplayValue("Original headline");
    // The open-the-record claim now owns the gate. Save stays disabled while that claim is in
    // flight, so no write can start before this tab is known to hold the record.
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Save page" })).toBeDisabled();
    expect(screen.queryByText("Your role cannot save this page.")).toBeNull();

    await act(async () => settleClaim?.());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save page" })).toBeEnabled(),
    );

    expect(headingField()).toBe(heading);
    fireEvent.change(heading, { target: { value: "A fast local change" } });
    // A local change on a record this tab already holds never has to wait again.
    expect(screen.getByRole("button", { name: "Save page" })).toBeEnabled();
    expect(locks.client.claim).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(
        "Save is disabled until this tab reserves the editor.",
      ),
    ).toBeNull();
  });

  it("reserves before an unchanged seeded page is created", async () => {
    const locks = fakeEditorLockClient();
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) => ({
        blocks,
        version: 8,
      }),
    );
    render(
      <EditorWorkspace
        principal={admin}
        editorLockActor={lockActor}
        editorLockClient={locks.client}
        loadPage={async () => ({
          blocks: (await storedPage()).blocks,
          metadata: { title: "Watch NJ PBS" },
          version: 7,
          expectedAbsent: true,
          seedFromLegacyPage: { id: "programLanding", version: 7 },
        })}
        savePage={savePage}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    const save = await screen.findByRole("button", { name: "Save page" });
    await waitFor(() => expect(save).toBeEnabled());
    // Opening the seeded page already reserved it, so the create-only save writes under a lease
    // this tab holds rather than racing to acquire one.
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));

    fireEvent.click(save);
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    const claim = vi.mocked(locks.client.claim);
    expect(claim).toHaveBeenCalledWith(
      "cmsPages:watch",
      lockActor,
      expect.any(String),
      { force: false },
    );
    expect(claim.mock.invocationCallOrder[0]).toBeLessThan(
      savePage.mock.invocationCallOrder[0],
    );
    expect(savePage).toHaveBeenCalledWith(
      "watch",
      "programLanding",
      expect.any(Array),
      7,
      true,
      { id: "programLanding", version: 7 },
      undefined,
    );
  });

  it("keeps a dirty lease across an actor display-name refresh", async () => {
    const locks = fakeEditorLockClient();
    const surface = { kind: "page", pageId: "home", section: "home" } as const;
    const { rerender } = render(
      <EditorWorkspace
        principal={admin}
        editorLockActor={{ id: "admin", name: "Al Admin Updated" }}
        editorLockClient={locks.client}
        loadPage={storedPage}
        surface={surface}
      />,
    );

    fireEvent.change(await findHeadingField(), {
      target: { value: "A dirty headline" },
    });
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    expect(locks.client.subscribe).toHaveBeenCalledTimes(1);
    expect(locks.client.release).not.toHaveBeenCalled();

    rerender(
      <EditorWorkspace
        principal={admin}
        editorLockActor={{ id: "admin", name: "Al Admin" }}
        editorLockClient={locks.client}
        loadPage={storedPage}
        surface={surface}
      />,
    );
    await act(async () => {});

    expect(locks.client.subscribe).toHaveBeenCalledTimes(1);
    expect(locks.client.release).not.toHaveBeenCalled();
  });

  it("does not let a stale claim release a newer lease after returning", async () => {
    const locks = fakeEditorLockClient();
    const pendingClaims: Array<(publish?: boolean) => void> = [];
    locks.client.claim = vi.fn(
      (surfaceKey, actor, sessionId) =>
        new Promise<EditorLockClaim>((resolve) => {
          pendingClaims.push((publish = true) => {
            const acquired: EditorLock = {
              surfaceKey,
              ownerId: actor.id,
              ownerName: actor.name,
              sessionId,
              acquiredAtMs: Date.now(),
              heartbeatAtMs: Date.now(),
              observedAtMs: globalThis.performance.now(),
            };
            // A transaction result can be delivered after a newer subscription snapshot without
            // making the obsolete result current again. Firestore retries conflicting writes; the
            // stale promise response itself is what this hook must retire.
            if (publish) locks.emit(acquired);
            resolve({ status: "acquired", lock: acquired });
          });
        }),
    );
    const home = { kind: "page", pageId: "home", section: "home" } as const;
    const about = {
      kind: "page",
      pageId: "about",
      section: "genericPage",
    } as const;
    const workspace = (surface: typeof home | typeof about) => (
      <EditorWorkspace
        principal={admin}
        editorLockActor={lockActor}
        editorLockClient={locks.client}
        loadPage={storedPage}
        savePage={async (_pageId, _section, blocks) => ({ blocks, version: 5 })}
        surface={surface}
      />
    );
    const { rerender } = render(workspace(home));

    fireEvent.change(await findHeadingField(), {
      target: { value: "A draft that follows this tab" },
    });
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));

    rerender(workspace(about));
    await screen.findByDisplayValue("Original headline");
    rerender(workspace(home));
    expect(
      await screen.findByDisplayValue("A draft that follows this tab"),
    ).toBeTruthy();
    // One claim per surface visit: home, about, home again.
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(3));

    await act(async () => pendingClaims[2]?.());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save page" })).toBeEnabled(),
    );
    const claim = vi.mocked(locks.client.claim);
    const activeSession = claim.mock.calls[2]?.[2];
    const staleSession = claim.mock.calls[0]?.[2];
    expect(activeSession).not.toBe(staleSession);
    await act(async () => pendingClaims[0]?.(false));

    expect(locks.client.release).toHaveBeenCalledWith(
      "cmsPages:home",
      lockActor.id,
      staleSession,
    );
    expect(locks.currentLock()?.sessionId).toBe(activeSession);
    expect(screen.getByRole("button", { name: "Save page" })).toBeEnabled();
  });

  it("disables save and reclaims when a heartbeat confirms ownership was lost", async () => {
    const locks = fakeEditorLockClient();
    locks.client.heartbeat = vi.fn(async () => false);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    render(
      <EditorWorkspace
        principal={admin}
        editorLockActor={lockActor}
        editorLockClient={locks.client}
        loadPage={storedPage}
        savePage={async (_pageId, _section, blocks) => ({ blocks, version: 5 })}
      />,
    );

    fireEvent.change(await findHeadingField(), {
      target: { value: "A dirty heartbeat draft" },
    });
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save page" })).toBeEnabled(),
    );

    const recoveryClaim = vi.fn(() => new Promise<EditorLockClaim>(() => {}));
    locks.client.claim = recoveryClaim;
    const heartbeatTimer = setIntervalSpy.mock.calls.find(
      ([, delay]) => delay === EDITOR_LOCK_HEARTBEAT_MS,
    )?.[0];
    expect(heartbeatTimer).toBeTypeOf("function");
    await act(async () => {
      (heartbeatTimer as () => void)();
      await Promise.resolve();
    });

    await waitFor(() => expect(recoveryClaim).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Save page" })).toBeDisabled();
    setIntervalSpy.mockRestore();
  });

  it("names an active editor and requires an explicit role-gated takeover", async () => {
    const locks = fakeEditorLockClient(courtesyLock("fixture-editor", "Jordan Editor"));
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { unmount } = render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("Jordan Editor is editing this right now"),
    ).toBeTruthy();
    expect(screen.queryByDisplayValue("Original headline")).toBeNull();
    expect(screen.getByRole("link", { name: "Back out" })).toHaveAttribute(
      "href",
      "/content",
    );

    fireEvent.click(screen.getByRole("button", { name: "Take over editing" }));
    expect(await screen.findByDisplayValue("Original headline")).toBeTruthy();
    expect(locks.client.claim).toHaveBeenLastCalledWith(
      "cmsPages:home",
      lockActor,
      expect.any(String),
      { force: true },
    );
    expect(locks.client.release).not.toHaveBeenCalled();
    const heartbeatTimer = setIntervalSpy.mock.calls.find(
      ([, delay]) => delay === EDITOR_LOCK_HEARTBEAT_MS,
    )?.[0];
    expect(heartbeatTimer).toBeTypeOf("function");
    await act(async () => {
      (heartbeatTimer as () => void)();
    });
    expect(locks.client.heartbeat).toHaveBeenCalledWith(
      "cmsPages:home",
      lockActor.id,
      expect.any(String),
    );
    setIntervalSpy.mockRestore();

    unmount();
    await waitFor(() => expect(locks.client.release).toHaveBeenCalledTimes(1));
  });

  it("requests a server-checked stale claim only after a full observed lease window", async () => {
    const locks = fakeEditorLockClient({
      ...courtesyLock("fixture-editor", "Jordan Editor"),
      observedAtMs: globalThis.performance.now() - EDITOR_LOCK_LEASE_MS,
    });
    render(
      <EditorWorkspace
        principal={admin}
        editorLockActor={lockActor}
        editorLockClient={locks.client}
        loadPage={storedPage}
        surface={{ kind: "page", pageId: "home", section: "home" }}
      />,
    );

    fireEvent.change(await findHeadingField(), {
      target: { value: "Claim after observed expiry" },
    });

    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    expect(locks.client.claim).toHaveBeenCalledWith(
      "cmsPages:home",
      lockActor,
      expect.any(String),
      {
        force: false,
        observedStale: true,
        observedLock: expect.objectContaining({
          ownerId: "fixture-editor",
          sessionId: "remote-session",
        }),
      },
    );
  });

  it("does not offer another person's takeover to a role without edit-any access", async () => {
    const locks = fakeEditorLockClient(courtesyLock("fixture-editor", "Jordan Editor"));
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={contributor}
          editorLockActor={{ id: "c", name: "Casey Contributor" }}
          editorLockClient={locks.client}
          loadPage={storedPage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("Jordan Editor is editing this right now"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Take over editing" }),
    ).toBeNull();
    expect(
      screen.getByText(
        "Your role cannot take another editor’s active session, so asking is the way in.",
      ),
    ).toBeTruthy();
  });

  it("offers one Post Preview action without loading old exports", async () => {
    const target = document.createElement("div"); document.body.appendChild(target);
    const loadPagePreviewStatus = vi.fn();
    const requestSavedPreview = vi.fn();
    const view = render(<MemoryRouter><WorkspaceActionsProvider target={target}>
      <EditorWorkspace principal={admin} loadPagePreviewStatus={loadPagePreviewStatus} requestSavedPreview={requestSavedPreview}
        loadRecord={async () => ({ status: "ready", record: { id: "story-1", type: "post", title: "Story", slug: "story", status: "draft", version: 1 } })}
        surface={{ kind: "record", record: "post", id: "story-1" }} />
    </WorkspaceActionsProvider></MemoryRouter>);
    expect(await within(target).findByRole("button", { name: "Preview" })).toBeEnabled();
    expect(loadPagePreviewStatus).not.toHaveBeenCalled();
    expect(requestSavedPreview).not.toHaveBeenCalled();
    expect(within(target).queryByRole("link", { name: "Preview" })).toBeNull();
    view.unmount(); target.remove();
  });

  it.each(["page", "post"])("retries the unchanged failed %s draft after reconnect with its original version claim", async (kind) => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const network = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const savePage = vi.fn(async (_pageId: PublicPageId, _section: SectionId, blocks: AdminBlock[]): Promise<PageContent> => ({ blocks, status: "draft", version: 5 }))
      .mockRejectedValueOnce(new TypeError("Network error"));
    const saveRecord = vi.fn(async (_kind: RecordKind, record: Record<string, unknown>) => ({ ...record, version: 5 }))
      .mockRejectedValueOnce(new TypeError("Network error"));
    try {
      render(<MemoryRouter><EditorWorkspace principal={admin} autoSaveEnabled
        savePage={savePage} saveRecord={saveRecord}
        loadPage={async () => ({ status: "draft", version: 4, blocks: [{
          id: "s1", type: "headline", order: 0, visible: true, data: { text: "Original headline", level: 2 },
        }] })}
        loadRecord={async () => ({ status: "ready", record: { id: "story-1", type: "post", title: "Original title", slug: "story", status: "draft", version: 4 } })}
        surface={kind === "page" ? { kind: "page", pageId: "home", section: "home" } : { kind: "record", record: "post", id: "story-1" }}
      /></MemoryRouter>);
      const field = kind === "page" ? await findHeadingField() : await screen.findByRole("textbox", { name: "Post title" });
      fireEvent.change(field, { target: { value: "Retained unsaved work" } });
      const tick = intervals.mock.calls.find(([, delay]) => delay === 60_000)![0] as () => void;
      await act(async () => tick());
      const save = kind === "page" ? savePage : saveRecord;
      expect(save).toHaveBeenCalledTimes(1);
      expect(field).toHaveValue("Retained unsaved work");
      network.mockReturnValue(false);
      act(() => window.dispatchEvent(new Event("offline")));
      await act(async () => tick());
      expect(save).toHaveBeenCalledTimes(1);
      network.mockReturnValue(true);
      act(() => window.dispatchEvent(new Event("online")));
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => tick());
      expect(save).toHaveBeenCalledTimes(2);
      if (kind === "page") {
        expect(savePage.mock.calls[1]).toEqual(expect.arrayContaining([expect.arrayContaining([
          expect.objectContaining({ data: expect.objectContaining({ text: "Retained unsaved work" }) }),
        ]), 4]));
      } else {
        expect(saveRecord.mock.calls[1]![1]).toMatchObject({ title: "Retained unsaved work", version: 4 });
      }
      expect(await screen.findByText("Draft autosaved.")).toBeVisible();
    } finally {
      cleanup();
      intervals.mockRestore();
      network.mockRestore();
    }
  });

  it.each(["page", "post"])("does not autosave or build a preview for an archived %s", async (kind) => {
    const requestSavedPreview = vi.fn();
    const loadPagePreviewStatus = vi.fn().mockResolvedValue({ success: true, latest: null, ready: null });
    const saveRecord = vi.fn();
    const savePage = vi.fn();
    render(<MemoryRouter><EditorWorkspace principal={admin} autoSaveEnabled
      requestSavedPreview={requestSavedPreview} loadPagePreviewStatus={loadPagePreviewStatus}
      saveRecord={saveRecord} savePage={savePage}
      loadPage={async () => ({ blocks: [], status: "archived", version: 1 })}
      loadRecord={async () => ({ status: "ready", record: { id: "story-1", type: "post", title: "Story", slug: "story", status: "archived", version: 1 } })}
      surface={kind === "page" ? { kind: "page", pageId: "home", section: "home" } : { kind: "record", record: "post", id: "story-1" }}
    /></MemoryRouter>);
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(loadPagePreviewStatus).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      if (kind === "post") {
        fireEvent.change(
          screen.getByRole("textbox", { name: "Post title" }),
          { target: { value: "Archived edit" } },
        );
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(saveRecord).not.toHaveBeenCalled();
      expect(savePage).not.toHaveBeenCalled();
      expect(requestSavedPreview).not.toHaveBeenCalled();
    } finally { cleanup(); vi.useRealTimers(); }
  });

  it("authorizes a record takeover against the loaded record's section", async () => {
    const locks = fakeEditorLockClient({
      ...courtesyLock("fixture-editor", "Jordan Editor"),
      surfaceKey: "cmsPosts:story-1",
    });
    const newsEditor: Principal = {
      id: "news-editor",
      grants: [{ role: "editor", sections: ["news"] }],
    };
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={newsEditor}
          editorLockActor={{ id: "news-editor", name: "Nia News" }}
          editorLockClient={locks.client}
          loadRecord={async () => ({
            status: "ready",
            record: { id: "story-1", type: "post", section: "news" },
          })}
          surface={{ kind: "record", record: "post", id: "story-1" }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("Jordan Editor is editing this right now"),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Take over editing" }),
    ).toBeTruthy();
  });

  it("lets an unscoped admin take over a record whose stored section is absent", async () => {
    const locks = fakeEditorLockClient({
      ...courtesyLock("fixture-editor", "Jordan Editor"),
      surfaceKey: "cmsPosts:story-1",
    });
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadRecord={async () => ({
            status: "ready",
            record: { id: "story-1", type: "post" },
          })}
          surface={{ kind: "record", record: "post", id: "story-1" }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("Jordan Editor is editing this right now"),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Take over editing" }),
    ).toBeTruthy();
  });

  it("does not widen an unsectioned record takeover to a section-scoped editor", async () => {
    const locks = fakeEditorLockClient({
      ...courtesyLock("fixture-editor", "Jordan Editor"),
      surfaceKey: "cmsPosts:story-1",
    });
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={scopedEditor}
          editorLockActor={{ id: "e", name: "Eden Editor" }}
          editorLockClient={locks.client}
          loadRecord={async () => ({
            status: "ready",
            record: { id: "story-1", type: "post" },
          })}
          surface={{ kind: "record", record: "post", id: "story-1" }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("Jordan Editor is editing this right now"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Take over editing" }),
    ).toBeNull();
  });

  it.each([
    { status: "missing" as const, message: "This post could not be found" },
    { status: "deleted" as const, message: "This post was deleted" },
    { status: "invalid" as const, message: "This record cannot be opened" },
  ])(
    "does not let a lock mask a $status record",
    async ({ status, message }) => {
      const locks = fakeEditorLockClient({
        ...courtesyLock("fixture-editor", "Jordan Editor"),
        surfaceKey: "cmsPosts:story-1",
      });
      render(
        <MemoryRouter>
          <EditorWorkspace
            principal={admin}
            editorLockActor={lockActor}
            editorLockClient={locks.client}
            loadRecord={async () => ({ status })}
            surface={{ kind: "record", record: "post", id: "story-1" }}
          />
        </MemoryRouter>,
      );

      expect(await screen.findByText(message)).toBeTruthy();
      expect(
        screen.queryByText("Jordan Editor is editing this right now"),
      ).toBeNull();
    },
  );

  it("lets the same account recover its editor from another tab", async () => {
    const locks = fakeEditorLockClient(courtesyLock("c", "Casey Contributor"));
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={contributor}
          editorLockActor={{ id: "c", name: "Casey Contributor" }}
          editorLockClient={locks.client}
          loadPage={storedPage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("You are editing this in another tab or window"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Take over editing" }),
    ).toBeTruthy();
  });

  it("preserves a local draft when another editor takes over", async () => {
    const locks = fakeEditorLockClient();
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>,
    );

    fireEvent.change(await findHeadingField(), {
      target: { value: "Half-written local headline" },
    });
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));

    act(() => locks.emit(courtesyLock("fixture-editor", "Jordan Editor")));
    expect(
      await screen.findByText("Jordan Editor took over this record"),
    ).toBeTruthy();
    expect(
      screen.getByDisplayValue("Half-written local headline"),
    ).toBeTruthy();
    expect(
      screen.getByText(/your unsaved changes are still here/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Take the record back" }));
    expect(
      await screen.findByDisplayValue("Half-written local headline"),
    ).toBeTruthy();
  });

  it("keeps an in-flight editor mounted to settle a save after another takeover", async () => {
    const locks = fakeEditorLockClient();
    let rejectSave: ((error: Error) => void) | undefined;
    const savePage = vi.fn(
      () =>
        new Promise<PageContent>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          savePage={savePage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>,
    );

    fireEvent.change(await findHeadingField(), {
      target: { value: "Unsaved local headline" },
    });
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    clickWorkspaceAction("Save page");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));

    act(() => locks.emit(courtesyLock("fixture-editor", "Jordan Editor")));
    expect(
      await screen.findByText(
        /another session took over while this tab’s save is finishing/i,
      ),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("Unsaved local headline")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Take the record back" }),
    ).toBeDisabled();

    await act(async () => rejectSave?.(new Error("Network request failed.")));
    expect(await screen.findByText("Network request failed.")).toBeTruthy();
    expect(screen.getByDisplayValue("Unsaved local headline")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Take the record back" }),
    ).toBeEnabled();
  });

  it("keeps one reservation per surface visit across a reverted draft", async () => {
    const locks = fakeEditorLockClient();
    render(
      <EditorWorkspace
        principal={admin}
        editorLockActor={lockActor}
        editorLockClient={locks.client}
        loadPage={storedPage}
      />,
    );

    const heading = await screen.findByDisplayValue("Original headline");
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    expect(headingField()).toBe(heading);
    fireEvent.change(heading, { target: { value: "Changed then reverted" } });
    fireEvent.change(heading, { target: { value: "Original headline" } });
    await act(async () => {});
    // Editing and un-editing is not a lease event either way: the visit already holds it.
    expect(locks.client.claim).toHaveBeenCalledTimes(1);
    expect(locks.client.release).not.toHaveBeenCalled();

    clickWorkspaceAction("Event");
    await waitFor(() => expect(locks.client.release).toHaveBeenCalledTimes(1));
  });

  it("holds the record while the editor sits clean after a revert", async () => {
    const locks = fakeEditorLockClient();
    render(
      <EditorWorkspace
        principal={admin}
        editorLockActor={lockActor}
        editorLockClient={locks.client}
        loadPage={storedPage}
        savePage={async (_pageId, _section, blocks) => ({ blocks, version: 5 })}
      />,
    );

    const heading = await screen.findByDisplayValue("Original headline");
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    expect(headingField()).toBe(heading);
    fireEvent.change(heading, {
      target: { value: "Changed then reverted in place" },
    });
    fireEvent.change(heading, { target: { value: "Original headline" } });

    await act(async () => {});
    // Before #1047 a clean editor dropped its lease, which is what left a record that somebody
    // clearly had open showing no presence at all to the next person.
    expect(locks.client.release).not.toHaveBeenCalled();
    expect(locks.currentLock()?.ownerId).toBe(lockActor.id);
    expect(screen.getByRole("button", { name: "Save page" })).toBeEnabled();
  });

  it("keeps saving available across a save that leaves the editor clean", async () => {
    const locks = fakeEditorLockClient();
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) => ({
        blocks,
        version: 5,
      }),
    );
    render(
      <EditorWorkspace
        principal={admin}
        editorLockActor={lockActor}
        editorLockClient={locks.client}
        loadPage={storedPage}
        savePage={savePage}
      />,
    );

    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    fireEvent.change(await findHeadingField(), {
      target: { value: "Saved headline" },
    });
    clickWorkspaceAction("Save page");
    await screen.findByText("Saved.");

    // The save settles, the editor goes clean, and the reservation simply stays put. Typing
    // again needs no second round trip and Save is never disabled in between.
    await act(async () => {});
    expect(locks.client.release).not.toHaveBeenCalled();
    fireEvent.change(headingField(), {
      target: { value: "Typed straight after saving" },
    });
    expect(screen.getByRole("button", { name: "Save page" })).toBeEnabled();
    expect(locks.client.claim).toHaveBeenCalledTimes(1);
  });

  it("keeps a returned surface's new session safe from an older delayed release", async () => {
    const locks = fakeEditorLockClient();
    let finishOldRelease: (() => void) | undefined;
    let deferFirstRelease = true;
    locks.client.release = vi.fn((surfaceKey, actorId, sessionId) => {
      if (!deferFirstRelease) {
        const held = locks.currentLock();
        if (
          held &&
          held.surfaceKey === surfaceKey &&
          held.ownerId === actorId &&
          held.sessionId === sessionId
        ) {
          locks.emit(null);
        }
        return Promise.resolve();
      }
      deferFirstRelease = false;
      return new Promise<void>((resolve) => {
        finishOldRelease = () => {
          const held = locks.currentLock();
          if (
            held &&
            held.surfaceKey === surfaceKey &&
            held.ownerId === actorId &&
            held.sessionId === sessionId
          ) {
            locks.emit(null);
          }
          resolve();
        };
      });
    });
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) => ({
        blocks,
        version: 5,
      }),
    );
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          savePage={savePage}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    fireEvent.change(await findHeadingField(), {
      target: { value: "Saved before returning" },
    });
    const claim = vi.mocked(locks.client.claim);
    const firstSession = claim.mock.calls[0]?.[2];
    clickWorkspaceAction("Save page");
    await screen.findByText("Saved.");

    // Leaving the surface is what releases the lease, and that release is the one held open here.
    clickWorkspaceAction("Event");
    await waitFor(() => expect(locks.client.release).toHaveBeenCalledTimes(1));
    clickWorkspaceAction("Home page");
    expect(
      await screen.findByText("You are editing this in another tab or window"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take over editing" }));
    await waitFor(() => expect(claim.mock.calls.length).toBeGreaterThan(1));
    const returnedSession = claim.mock.calls[claim.mock.calls.length - 1]?.[2];
    expect(returnedSession).not.toBe(firstSession);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save page" })).toBeEnabled(),
    );

    await act(async () => finishOldRelease?.());
    expect(locks.currentLock()?.sessionId).toBe(returnedSession);
    expect(screen.getByRole("button", { name: "Save page" })).toBeEnabled();
  });

  it("lets a blocked editor ask the holder for the record", async () => {
    const locks = fakeEditorLockClient(courtesyLock("fixture-editor", "Jordan Editor"));
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("Jordan Editor is editing this right now"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask to edit" }));

    expect(
      await screen.findByText("Waiting for Jordan Editor to hand this over"),
    ).toBeTruthy();
    expect(locks.client.requestTakeover).toHaveBeenCalledWith(
      "cmsPages:home",
      lockActor,
      "remote-session",
    );
    // Asking never takes the record; the holder is still the holder.
    expect(locks.currentLock()?.ownerId).toBe("fixture-editor");
    expect(screen.queryByRole("button", { name: "Ask to edit" })).toBeNull();
  });

  it("shows the holder an incoming ask and hands the record over on request", async () => {
    const locks = fakeEditorLockClient();
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>,
    );

    await screen.findByDisplayValue("Original headline");
    await waitFor(() => expect(locks.currentLock()?.ownerId).toBe(lockActor.id));
    act(() =>
      locks.emit({
        ...locks.currentLock()!,
        request: { byId: "fixture-editor", byName: "Jordan Editor", atMs: Date.now() },
      }),
    );

    expect(
      await screen.findByText("Jordan Editor is asking to edit this"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hand over editing" }));

    await waitFor(() => expect(locks.client.release).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("You handed this record over"),
    ).toBeTruthy();
    // A handed-over tab must not silently grab the record back.
    await act(async () => {});
    expect(locks.currentLock()).toBeNull();
    expect(locks.client.claim).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Take the record back" }));
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(2));
  });

  it("holds an ask until the holder's own changes are saved or dropped", async () => {
    const locks = fakeEditorLockClient();
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          savePage={async (_pageId, _section, blocks) => ({ blocks, version: 5 })}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>,
    );

    fireEvent.change(await findHeadingField(), {
      target: { value: "Mid-sentence work" },
    });
    await waitFor(() => expect(locks.currentLock()?.ownerId).toBe(lockActor.id));
    act(() =>
      locks.emit({
        ...locks.currentLock()!,
        request: { byId: "fixture-editor", byName: "Jordan Editor", atMs: Date.now() },
      }),
    );

    await screen.findByText("Jordan Editor is asking to edit this");
    expect(
      screen.getByRole("button", { name: "Hand over editing" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Save or discard your changes first, then hand it over."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(locks.client.clearRequest).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText("Jordan Editor is asking to edit this")).toBeNull(),
    );
    expect(screen.getByDisplayValue("Mid-sentence work")).toBeTruthy();
  });

  it("brings a displaced editor's unsaved work back after the tab reloads", async () => {
    globalThis.localStorage.clear();
    const locks = fakeEditorLockClient();
    const workspace = () => (
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>
    );
    const first = render(workspace());

    fireEvent.change(await findHeadingField(), {
      target: { value: "Work lost to a takeover" },
    });
    await waitFor(() => expect(locks.currentLock()?.ownerId).toBe(lockActor.id));
    act(() => locks.emit(courtesyLock("fixture-editor", "Jordan Editor")));
    expect(
      await screen.findByText("Jordan Editor took over this record"),
    ).toBeTruthy();

    // The person closes the tab rather than sitting on a read-only editor.
    await act(async () => {
      first.unmount();
    });
    render(workspace());

    expect(
      await screen.findByDisplayValue("Work lost to a takeover"),
    ).toBeTruthy();
    expect(
      screen.getByText("Recovered your unsaved changes"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this notice" }));
    expect(screen.queryByText("Recovered your unsaved changes")).toBeNull();
  });

  it("recovers displaced page metadata without blanking the page's blocks", async () => {
    globalThis.localStorage.clear();
    const locks = fakeEditorLockClient();
    const workspace = () => (
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          savePageMetadata={async (_pageId, _section, metadata) => ({
            blocks: [],
            metadata,
            version: 5,
          })}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>
    );
    const first = render(workspace());

    // Only the metadata form is touched. Its draft is one of two drafts over one document, so a
    // recovery that carried it alone would restore into a mount with no loaded blocks behind it
    // and present the page as empty -- which a save could then make true.
    await screen.findByDisplayValue("Original headline");
    fireEvent.change(await screen.findByLabelText(/^Page title/), {
      target: { value: "Displaced page title" },
    });
    await waitFor(() => expect(locks.currentLock()?.ownerId).toBe(lockActor.id));
    act(() => locks.emit(courtesyLock("fixture-editor", "Jordan Editor")));
    await screen.findByText("Jordan Editor took over this record");

    await act(async () => {
      first.unmount();
    });
    render(workspace());

    expect(await screen.findByDisplayValue("Displaced page title")).toBeTruthy();
    expect(screen.getByDisplayValue("Original headline")).toBeTruthy();
    expect(screen.queryByText("This page is empty.")).toBeNull();
  });

  it("does not let a handed-over tab reclaim the record through a save action", async () => {
    // Save, lifecycle, history and assignment all reserve the lease before they write. After a
    // hand-off that reservation would take the record straight back from the person it was just
    // given to, without anybody pressing "Take the record back".
    const locks = fakeEditorLockClient();
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          savePage={async (_pageId, _section, blocks) => ({ blocks, version: 5 })}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>,
    );

    await screen.findByDisplayValue("Original headline");
    await waitFor(() => expect(locks.currentLock()?.ownerId).toBe(lockActor.id));
    act(() =>
      locks.emit({
        ...locks.currentLock()!,
        request: { byId: "fixture-editor", byName: "Jordan Editor", atMs: Date.now() },
      }),
    );
    await screen.findByText("Jordan Editor is asking to edit this");
    fireEvent.click(screen.getByRole("button", { name: "Hand over editing" }));
    await screen.findByText("You handed this record over");
    expect(locks.currentLock()).toBeNull();
    expect(locks.client.claim).toHaveBeenCalledTimes(1);

    // The record is free at this instant, so nothing but the yield itself keeps this tab out.
    expect(screen.getByRole("button", { name: "Save page" })).toBeDisabled();
    await act(async () => {});
    expect(locks.client.claim).toHaveBeenCalledTimes(1);
    expect(locks.currentLock()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Take the record back" }));
    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save page" })).toBeEnabled(),
    );
  });

  it("keeps writing the recovery snapshot while a displaced editor carries on typing", async () => {
    // The displaced editor stays interactive on purpose, so a one-shot snapshot would restore
    // the instant of the takeover and quietly lose everything typed after it.
    globalThis.localStorage.clear();
    const locks = fakeEditorLockClient();
    const workspace = () => (
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>
    );
    const first = render(workspace());

    fireEvent.change(await findHeadingField(), {
      target: { value: "Work at the moment of the takeover" },
    });
    await waitFor(() => expect(locks.currentLock()?.ownerId).toBe(lockActor.id));
    act(() => locks.emit(courtesyLock("fixture-editor", "Jordan Editor")));
    await screen.findByText("Jordan Editor took over this record");

    fireEvent.change(
      screen.getByDisplayValue("Work at the moment of the takeover"),
      { target: { value: "Work typed after the takeover" } },
    );
    await act(async () => {});

    await act(async () => {
      first.unmount();
    });
    render(workspace());

    expect(
      await screen.findByDisplayValue("Work typed after the takeover"),
    ).toBeTruthy();
  });

  it("drops the recovery snapshot when a save lands after the lease moved away", async () => {
    // A save already in flight can land after somebody takes over. It clears the draft, so the
    // snapshot is now the saved content and must not come back later as unsaved work.
    globalThis.localStorage.clear();
    const locks = fakeEditorLockClient();
    let resolveSave: ((content: PageContent) => void) | undefined;
    const savePage = vi.fn(
      () =>
        new Promise<PageContent>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const workspace = () => (
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          savePage={savePage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>
    );
    const first = render(workspace());

    fireEvent.change(await findHeadingField(), {
      target: { value: "Headline the save is carrying" },
    });
    await waitFor(() => expect(locks.currentLock()?.ownerId).toBe(lockActor.id));
    clickWorkspaceAction("Save page");
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));

    act(() => locks.emit(courtesyLock("fixture-editor", "Jordan Editor")));
    await act(async () => {
      resolveSave?.({
        blocks: [
          {
            id: "headline-1",
            type: "headline",
            order: 0,
            visible: true,
            data: { text: "Headline the save is carrying", level: 2 },
          },
        ],
        version: 5,
      });
    });
    // The draft is gone, so nothing is left to recover even though the lease moved away.
    await waitFor(() =>
      expect(
        globalThis.localStorage.getItem(
          "njpbs-admin:displaced-work:admin:cmsPages:home",
        ),
      ).toBeNull(),
    );

    await act(async () => {
      first.unmount();
    });
    render(workspace());

    // Coming back finds a record somebody else holds and nothing of this tab's to restore.
    expect(
      await screen.findByText("Jordan Editor is editing this right now"),
    ).toBeTruthy();
    expect(screen.queryByText("Recovered your unsaved changes")).toBeNull();
    expect(
      screen.queryByDisplayValue("Headline the save is carrying"),
    ).toBeNull();
  });

  it("tells a second waiting editor that somebody already asked", async () => {
    const locks = fakeEditorLockClient({
      ...courtesyLock("fixture-editor", "Jordan Editor"),
      request: { byId: "cass", byName: "Cass Editor", atMs: Date.now() },
    });
    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          editorLockActor={lockActor}
          editorLockClient={locks.client}
          loadPage={storedPage}
          surface={{ kind: "page", pageId: "home", section: "home" }}
        />
      </MemoryRouter>,
    );

    await screen.findByText("Jordan Editor is editing this right now");
    expect(
      screen.getByText(/Cass Editor already asked for this record/),
    ).toBeTruthy();
    // No second ask is offered, because the lease holds one and there is no queue behind it.
    expect(screen.queryByRole("button", { name: "Ask to edit" })).toBeNull();
    expect(locks.client.requestTakeover).not.toHaveBeenCalled();
  });

  it("holds its lease across a save and releases it on the way out", async () => {
    const locks = fakeEditorLockClient();
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ) => ({
        blocks,
        version: 5,
      }),
    );
    render(
      <EditorWorkspace
        principal={admin}
        editorLockActor={lockActor}
        editorLockClient={locks.client}
        loadPage={storedPage}
        savePage={savePage}
      />,
    );

    await waitFor(() => expect(locks.client.claim).toHaveBeenCalledTimes(1));
    fireEvent.change(await findHeadingField(), {
      target: { value: "Saved headline" },
    });
    clickWorkspaceAction("Save page");
    await screen.findByText("Saved.");
    await act(async () => {});
    expect(locks.client.release).not.toHaveBeenCalled();

    fireEvent.change(headingField(), {
      target: { value: "Another local change" },
    });
    await act(async () => {});
    expect(locks.client.claim).toHaveBeenCalledTimes(1);
    clickWorkspaceAction("Event");
    await waitFor(() => expect(locks.client.release).toHaveBeenCalledTimes(1));
    expect(locks.currentLock()).toBeNull();
  });
});

describe("EditorWorkspace byline feed (#1040)", () => {
  const SELF = `au_${"1".repeat(32)}`;
  const LAST = `au_${"9".repeat(32)}`;

  it.each(["complete", "failed"] as const)("keeps live-blog profile warnings quiet during a directory load that ends %s", async outcome => {
    let finish!: (response: BylineAuthorsResponse) => void;
    let fail!: (error: Error) => void;
    const loadBylineAuthors = vi.fn(() => new Promise<BylineAuthorsResponse>((resolve, reject) => { finish = resolve; fail = reject; }));
    const record = { id: "live-one", type: "post", title: "Live coverage", section: "news", status: "draft", version: 1, blocks: [], tags: [],
      liveBlog: { schemaVersion: 1, coverageState: "ongoing", updates: [{ id: "entry-one", headline: "First report", body: { type: "doc", content: [] },
        credits: [{ kind: "registered", authorId: SELF }], keyUpdate: false }] } };
    render(<MemoryRouter><EditorWorkspace principal={editor} newId={counterIds()} loadBylineAuthors={loadBylineAuthors}
      loadRecord={async () => ({ status: "ready", record })} surface={{ kind: "record", record: "post", id: record.id }} /></MemoryRouter>);
    await screen.findByRole("article", { name: "Live updates" });
    expect(screen.queryByRole("group", { name: "Reporter profiles before publishing" })).toBeNull();
    expect(screen.queryByText(/author profile could not be checked/)).toBeNull();
    await act(async () => {
      if (outcome === "failed") fail(new Error("directory unavailable"));
      else finish({ apiVersion: 1, success: true, nextCursor: null, selfAuthorId: SELF, authors: [{ authorId: SELF, displayName: "Ada Reporter", jobTitle: "Reporter",
        profileReadiness: { hasPhoto: true, hasJobTitle: true, hasBio: true, published: true } }] });
    });
    expect(loadBylineAuthors).toHaveBeenCalledOnce();
    if (outcome === "failed") expect(screen.getByRole("group", { name: "Reporter profiles before publishing" })).toHaveTextContent("author profile could not be checked");
    else expect(screen.queryByRole("group", { name: "Reporter profiles before publishing" })).toBeNull();
  });

  function pagedFeed() {
    return vi.fn(async (body?: { startAfter?: string | null }) => {
      if (!body?.startAfter) {
        return {
          apiVersion: 1 as const,
          success: true as const,
          authors: [
            { authorId: SELF, displayName: "Briana Vannozzi", jobTitle: "Anchor" },
          ],
          nextCursor: "uid-page-1",
          // No self identity, so nothing is auto-credited and both pages stay
          // visible in the picker rather than one of them being consumed.
          selfAuthorId: null,
        };
      }
      return {
        apiVersion: 1 as const,
        success: true as const,
        authors: [
          { authorId: LAST, displayName: "Ada Reporter", jobTitle: null },
        ],
        nextCursor: null,
        selfAuthorId: null,
      };
    });
  }

  it("follows the feed's cursor so nobody past the first page is uncreditable", async () => {
    const loadBylineAuthors = pagedFeed();
    render(
      <EditorWorkspace
        principal={editor}
        newId={counterIds()}
        loadBylineAuthors={loadBylineAuthors}
        surface={{ kind: "record", record: "post", id: null }}
      />,
    );

    await waitFor(() => expect(loadBylineAuthors).toHaveBeenCalledTimes(2));
    expect(loadBylineAuthors.mock.calls[0][0]).toBeUndefined();
    expect(loadBylineAuthors.mock.calls[1][0]).toEqual({
      startAfter: "uid-page-1",
    });

    const picker = await screen.findByLabelText("Add a staff byline");
    const options = within(picker as HTMLElement).getAllByRole("option");
    // Sorted across pages, not concatenated: the cursor walks document ids, so
    // each page arrives alphabetized only within itself.
    expect(
      options.slice(1).map((option) => option.textContent),
    ).toEqual(["Ada Reporter", "Briana Vannozzi — Anchor"]);
  });

  it("reports the feed as unavailable when a later page fails", async () => {
    const loadBylineAuthors = vi.fn(
      async (body?: { startAfter?: string | null }) => {
        if (body?.startAfter) throw new Error("network");
        return {
          apiVersion: 1 as const,
          success: true as const,
          authors: [
            { authorId: SELF, displayName: "Briana Vannozzi", jobTitle: null },
          ],
          nextCursor: "uid-page-1",
          selfAuthorId: null,
        };
      },
    );
    render(
      <EditorWorkspace
        principal={editor}
        newId={counterIds()}
        loadBylineAuthors={loadBylineAuthors}
        surface={{ kind: "record", record: "post", id: null }}
      />,
    );

    // A half-read directory would look complete while quietly missing people, so
    // a failed page says so rather than shipping the pages that did arrive.
    expect(
      await screen.findByText(
        "The staff list could not be loaded. You can still add custom credits.",
      ),
    ).toBeTruthy();
  });
});
