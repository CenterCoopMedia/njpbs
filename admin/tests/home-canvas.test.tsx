import { createRef, useState, type ComponentProps } from "react";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Modal editing flows include retained fields and repeated surface changes.
vi.setConfig({ testTimeout: 10_000 });
import {
  BlockEditor,
  type BlockEditorHandle,
} from "../src/components/BlockEditor";

import {
  EditorWorkspace,
  type PageContent,
} from "../src/components/EditorWorkspace";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";
import type {
  EditorLock,
  EditorLockClient,
} from "../src/lib/editor-locks";
import { homeCompositionDefaults, homeContentAreas } from "../../packages/content-core/src/home-composition";
import v1Home from "../../site/tests/fixtures/home-composition-v1.json";
import { homeCompositionError } from "../../packages/content-core/src/home-composition-contract";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import type {
  HomeSourceSnapshot,
} from "../../packages/content-core/src/home-rail-render";
import type { SectionId } from "../../packages/content-core/src/editor-admin";
import type { PublicPageId } from "../../packages/content-core/src/public-pages";
import type { Principal } from "../../packages/content-core/src/rbac";

// jsdom exposes an iframe document but does not load srcDoc into it. Keep these
// tests on the real canvas and editor while replacing only that unsupported leaf.
vi.mock("../src/components/HomePreviewFrame", () => ({
  HomePreviewFrame: ({ html, title }: { html: string; title: string }) => (
    <div aria-label={title} data-preview-html={html} role="group" />
  ),
}));

// EditorWorkspace uses the production loader rather than taking the canvas test
// injection. Keep that boundary deterministic without replacing HomeCanvas.
const homeSourceMocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("../src/lib/home-source-snapshot", () => ({
  loadHomeSourceSnapshot: homeSourceMocks.load,
}));

const sourceSnapshot = {
  schemaVersion: 1,
  publication: {
    buildBatchId: "home-canvas-test",
    generation: 3,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  },
  pbs: {
    source: "media-manager",
    checkedAt: "2026-09-05T13:00:00.000Z",
    featured: [
      {
        title: "State of the Arts",
        description: "An arts program",
        href: "/watch/state-of-the-arts",
      },
    ],
    more: [],
  },
  spotlight: {
    source: "spotlight-rss",
    checkedAt: "2026-09-05T13:05:00.000Z",
    cards: [
      {
        title: "Policy update",
        category: "Politics",
        href: "https://www.njspotlightnews.org/policy-update/",
        image: "https://www.njspotlightnews.org/images/policy-update.jpg",
      },
    ],
  },
} satisfies HomeSourceSnapshot;

const loadSources = async () => sourceSnapshot;
const workspaceAdmin: Principal = {
  id: "home-workspace-admin",
  grants: [{ role: "admin" }],
};
const workspaceViewer: Principal = {
  id: "home-workspace-viewer",
  grants: [],
};

const requiredSections = [
  "home-start",
  "home-start-action",
  "home-featured",
  "home-passport-copy",
  "home-passport-action",
  "home-more",
  "home-spotlight",
];

beforeEach(() => {
  vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", undefined);
  homeSourceMocks.load.mockReset().mockResolvedValue(sourceSnapshot);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function counterIds() {
  let next = 0;
  return () => `home-test-${++next}`;
}

function renderHomeEditor(
  props: Partial<ComponentProps<typeof BlockEditor>> = {},
) {
  return render(
    <BlockEditor
      section="home"
      pageId="home"
      homeCompositionVersion={1}
      initialBlocks={homeCompositionDefaults() as AdminBlock[]}
      loadHomeSources={loadSources}
      newId={counterIds()}
      commandsInline
      {...props}
    />,
  );
}

function markedHomePage(version = 7): PageContent {
  return {
    blocks: homeCompositionDefaults() as AdminBlock[],
    homeCompositionVersion: 1,
    metadata: { title: "Home" },
    createdBy: workspaceAdmin.id,
    status: "draft",
    version,
  };
}

function legacyHomePage(overrides: Partial<PageContent> = {}): PageContent {
  return {
    blocks: [createBlock("promotion_playlist", "legacy-home-shelf")],
    metadata: { title: "Home" },
    createdBy: workspaceAdmin.id,
    status: "draft",
    version: 7,
    ...overrides,
  };
}

describe("guarded v2 Home saved-array authoring", () => {
  it.each([1, 2] as const)("offers manual placement only for v1 in a reachable shelf editor (version %s)", (version) => {
    const shelf = createBlock("promotion_playlist", "saved-local");
    shelf.data = { ...shelf.data, title: "Local station story", placement: "before_featured" };
    const blocks = [...v1Home.blocks, shelf].map((block, order) => ({ ...block, order })) as AdminBlock[];
    renderHomeEditor({ homeCompositionVersion: version, initialBlocks: blocks, allowIncomplete: true });
    fireEvent.click(screen.getByRole("button", { name: "Edit Manual content shelf: Local station story" }));
    const dialog = screen.getByRole("dialog", { name: "Manual content shelf: Local station story" });
    expect(dialog).toBeVisible();
    if (version === 1) expect(within(dialog).getByRole("combobox", { name: "Home page position" })).toHaveValue("before_featured");
    else expect(within(dialog).queryByRole("combobox", { name: "Home page position" })).toBeNull();
  });

  it("opens the saved section order and preserves a manual shelf's array position on save", async () => {
    const shelf = { ...createBlock("promotion_playlist", "saved-local"), visible: false };
    const blocks = [...v1Home.blocks.slice(3, 5), ...v1Home.blocks.slice(0, 3), ...v1Home.blocks.slice(5), shelf]
      .map((block, order) => ({ ...block, order })) as AdminBlock[];
    const onSave = vi.fn();
    renderHomeEditor({ homeCompositionVersion: 2, initialBlocks: blocks, allowIncomplete: true, onSave });
    const editButtons = screen.getAllByRole("button", { name: /^Edit (Passport|Featured programs|More to watch|NJ Spotlight News)$/ });
    expect(editButtons.map(button => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
      "Edit Passport", "Edit Featured programs", "Edit More to watch", "Edit NJ Spotlight News",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as AdminBlock[];
    expect(saved.map(block => block.id)).toEqual(blocks.map(block => block.id));
    expect(saved.find(block => block.id === shelf.id)).toEqual(blocks.at(-1));
  });

  it("refuses a standalone v2 writer when production layouts are disabled", async () => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    const onSave = vi.fn();
    const ref = createRef<BlockEditorHandle>();
    renderHomeEditor({ ref, homeCompositionVersion: 2, initialBlocks: v1Home.blocks as AdminBlock[], onSave });
    await act(async () => { await ref.current?.save(); });
    expect(onSave).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function blockingEditorLockClient(): EditorLockClient {
  const lock: EditorLock = {
    surfaceKey: "cmsPages:home",
    ownerId: "another-editor",
    ownerName: "Another editor",
    sessionId: "another-session",
    acquiredAtMs: Date.now() - 1_000,
    heartbeatAtMs: Date.now(),
    observedAtMs: globalThis.performance.now(),
  };
  return {
    subscribe: vi.fn((_surfaceKey, onLock) => {
      onLock(lock);
      return () => {};
    }),
    claim: vi.fn(async () => ({ status: "blocked" as const, lock })),
    heartbeat: vi.fn(async () => true),
    release: vi.fn(async () => {}),
    requestTakeover: vi.fn(async () => true),
    clearRequest: vi.fn(async () => {}),
  };
}

function renderHomeWorkspace(
  props: Partial<ComponentProps<typeof EditorWorkspace>>,
) {
  return render(
    <MemoryRouter>
      <EditorWorkspace
        principal={workspaceAdmin}
        enforcePublicPageOwnership
        newId={counterIds()}
        {...props}
      />
    </MemoryRouter>,
  );
}

function closeComponentEditor() {
  const dialog = screen.queryAllByRole("dialog").find(element => element.classList.contains("component-editor-dialog"));
  if (dialog) fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
}
function clickPageCommand(name: string) {
  closeComponentEditor();
  fireEvent.click(screen.getByRole("button", { name }));
}

function lastDraft(onDraftChange: ReturnType<typeof vi.fn>): AdminBlock[] {
  const blocks = onDraftChange.mock.lastCall?.[0];
  if (!Array.isArray(blocks)) throw new Error("The editor did not report a draft.");
  return blocks as AdminBlock[];
}

function blockText(block: AdminBlock | undefined): string {
  return JSON.stringify(block?.data ?? {});
}

function textIn(value: unknown): string {
  if (Array.isArray(value)) return value.map(textIn).join("");
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  return (typeof record.text === "string" ? record.text : "") +
    Object.values(record).map(textIn).join("");
}

function passportBodyText(block: AdminBlock | undefined): string {
  const content = (block?.data.content as { content?: unknown[] } | undefined)
    ?.content;
  return textIn(content?.slice(1) ?? []);
}

function expectNoSampleCards(): void {
  for (const preview of document.querySelectorAll("[data-preview-html]")) {
    expect(preview.getAttribute("data-preview-html")).not.toContain(
      'class="sample"',
    );
  }
}

async function replaceRichText(
  surface: HTMLElement,
  html: string,
): Promise<void> {
  await act(async () => {
    surface.innerHTML = html;
    fireEvent.input(surface);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Home section modal lifetime", () => {
  it("keeps Passport text and editor history across Done, reopen, and canonical IDs", async () => {
    const originalBlocks = homeCompositionDefaults() as AdminBlock[];
    let adoptIds!: () => void;
    function Draft() {
      const [blocks, setBlocks] = useState(originalBlocks);
      adoptIds = () => setBlocks(current => current.map(block => ({ ...block, id: `canonical-${block.id}` })));
      return <BlockEditor section="home" pageId="home" homeCompositionVersion={1}
        initialBlocks={blocks} commandsInline
        onDraftChange={(next) => { if (next) setBlocks(next); }} />;
    }
    render(<Draft />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("group", { name: "Passport page preview" })).toBeNull();
    const edit = screen.getByRole("button", { name: "Edit Passport" });
    edit.focus();
    fireEvent.click(edit);
    const dialog = screen.getByRole("dialog", { name: "Passport" });
    const body = within(dialog).getByRole("textbox", { name: "Body" });
    const original = body.textContent;
    await replaceRichText(body, "<p>A retained Passport edit.</p>");
    closeComponentEditor();
    expect(edit).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Body" })).toBeNull();
    fireEvent.click(edit);
    expect(screen.getByRole("textbox", { name: "Body" })).toBe(body);
    act(() => adoptIds());
    expect(screen.getByRole("dialog", { name: "Passport" })).toBe(dialog);
    expect(screen.getByRole("textbox", { name: "Body" })).toBe(body);
    fireEvent.focus(body);
    fireEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
    expect(body.textContent).toBe(original);
  });

  it("closes on readonly and blocks callbacks even from retained fields", async () => {
    const onDraftChange = vi.fn();
    const props = {
      section: "home" as const,
      pageId: "home" as const,
      homeCompositionVersion: 1 as const,
      initialBlocks: homeCompositionDefaults() as AdminBlock[],
      commandsInline: true,
      onDraftChange,
    };
    const view = render(<BlockEditor {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Passport" }));
    const body = screen.getByRole("textbox", { name: "Body" });
    view.rerender(<BlockEditor {...props} readOnly />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Passport" })).toBeDisabled();
    await replaceRichText(body, "<p>Forbidden change</p>");
    expect(onDraftChange).not.toHaveBeenCalled();
    view.rerender(<BlockEditor {...props} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Passport" }));
    expect(screen.getByRole("textbox", { name: "Body" })).toBe(body);
  });

  it("does not expose retired Start here controls in the structural editor", () => {
    renderHomeEditor();

    expect(screen.getByRole("region", { name: "Newsletter signup" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit Start here" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Start here destinations" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Start here" })).toBeNull();
    expect(screen.queryByText("Schedule link label")).toBeNull();
  });
});

describe("Home canvas", () => {
  it("resets added-content heading context at Home boundaries", async () => {
    const blocks = homeCompositionDefaults() as AdminBlock[];
    const cards = (id: string): AdminBlock => ({
      ...createBlock("card_grid", id),
      data: { cards: [{ title: id, href: "/watch/", body: { type: "doc", content: [] } }] },
    });
    blocks.splice(2, 0,
      { ...createBlock("headline", "custom-heading"), data: { text: "Custom section", level: 3 } },
      cards("Before featured"));
    blocks.splice(blocks.findIndex(block => block.section === "home-more"), 0, cards("After Passport"));
    renderHomeEditor({ initialBlocks: blocks.map((block, order) => ({ ...block, order })) });
    for (const title of ["Before featured", "After Passport"]) {
      const card = Array.from(document.querySelectorAll<HTMLElement>(".block-card")).find(element => element.textContent?.includes(title));
      fireEvent.click(within(card!).getByRole("button", { name: /^Edit / }));
      expect(screen.getByRole("textbox", { name: "Card title 1" })).toHaveValue(title);
      closeComponentEditor();
    }
  });

  it("moves page-level Home content past complete sections without rows or remounting", async () => {
    const onDraftChange = vi.fn();
    const extra: AdminBlock = {
      ...createBlock("prose", "extra-text"),
      data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this text" }] }] } },
    };
    const initialBlocks = [extra, ...homeCompositionDefaults() as AdminBlock[]].map((block, order) => ({ ...block, order }));
    renderHomeEditor({ initialBlocks, onDraftChange });
    fireEvent.click(screen.getByRole("button", { name: "Edit text 1" }));
    const body = await screen.findByRole("textbox", { name: "Body" });
    closeComponentEditor();
    const originalIds = initialBlocks.map(block => block.id);
    expect(screen.queryByRole("combobox", { name: /Placement for text/ })).toBeNull();
    const grip = screen.getByRole("button", { name: /^Move: text plank/ });
    const beforeBoundary = onDraftChange.mock.calls.length;
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(onDraftChange).toHaveBeenCalledTimes(beforeBoundary);
    const areas = ["before_featured", "before_passport", "before_more", "before_spotlight", "after_spotlight"] as const;
    for (const area of areas) {
      fireEvent.keyDown(grip, { key: "ArrowDown" });
      const draft = lastDraft(onDraftChange);
      expect(homeContentAreas(draft)[area].map(block => block.id)).toEqual([extra.id]);
      expect(homeCompositionError("home", 1, draft as PageBlock[])).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /^Edit text / }));
      expect(screen.getByRole("textbox", { name: "Body" })).toBe(body);
      closeComponentEditor();
    }
    const afterBoundary = onDraftChange.mock.calls.length;
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(onDraftChange).toHaveBeenCalledTimes(afterBoundary);
    for (let step = 0; step < 5; step++) {
      fireEvent.keyDown(grip, { key: "ArrowUp" });
      expect(homeCompositionError("home", 1, lastDraft(onDraftChange) as PageBlock[])).toBeNull();
    }
    expect(lastDraft(onDraftChange).map(block => block.id)).toEqual(originalIds);
    expect(body).toHaveTextContent("Keep this text");
    // Ten complete canvas moves need headroom on shared CI runners.
  }, 20_000);

  it("saves a Passport body edit through the shared component dialog", async () => {
    const onSave = vi.fn();
    renderHomeEditor({ onSave });

    fireEvent.click(screen.getByRole("button", { name: "Edit Passport" }));
    const body = screen.getByRole("textbox", { name: "Body" });
    await replaceRichText(body, "<h2>Passport member stories</h2><p>A later body edit stays in the draft.</p>");

    clickPageCommand("Save page");
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as AdminBlock[];
    const savedPassport = saved.find(
      (block) => block.section === "home-passport-copy",
    );
    expect(savedPassport?.id).toBe("new-home-passport-copy");
    expect(blockText(savedPassport)).toContain("Passport member stories");
    expect(blockText(savedPassport)).toContain("A later body edit stays in the draft.");
  });

  it("refuses a blank Passport body without replacing the draft", async () => {
    const onSave = vi.fn();
    const onDraftChange = vi.fn();
    renderHomeEditor({ onSave, onDraftChange });

    fireEvent.click(screen.getByRole("button", { name: "Edit Passport" }));
    const body = screen.getByRole("textbox", { name: "Body" });
    await replaceRichText(body, "<p></p>");
    await waitFor(() => expect(onDraftChange).toHaveBeenCalled());

    clickPageCommand("Save page");

    expect(onSave).not.toHaveBeenCalled();
  });

  it("adds and removes a manual shelf without opening a branded Home canvas", async () => {
    const onSave = vi.fn();
    const onDraftChange = vi.fn();
    renderHomeEditor({ onSave, onDraftChange });

    expect(screen.queryByRole("group", { name: /page preview$/i })).toBeNull();
    const addContent = screen.getAllByRole("button", { name: /^Add content/ }).at(-1);
    if (!addContent) throw new Error("Missing add content control");
    fireEvent.click(addContent);
    fireEvent.click(screen.getByRole("radio", { name: "manual content shelf" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));
    await waitFor(() => expect(onDraftChange).toHaveBeenCalled());
    expect(lastDraft(onDraftChange).some((block) => block.type === "promotion_playlist")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Edit Manual content shelf 1" }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove / }));
    await waitFor(() => {
      expect(lastDraft(onDraftChange).every((block) => block.type !== "promotion_playlist")).toBe(true);
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("restricts required Home named regions to contract-safe fields", () => {
    renderHomeEditor();

    fireEvent.click(screen.getByRole("button", { name: "Edit Featured programs" }));
    const featured = screen.getByRole("dialog", { name: "Featured programs" });
    expect(within(featured).getByRole("textbox", { name: "Shelf heading" })).toHaveValue("Featured on NJ PBS");
    expect(within(featured).getByRole("textbox", { name: /More link label/ })).toBeVisible();
    expect(within(featured).queryByLabelText(/^Content source/)).toBeNull();
    expect(within(featured).queryByLabelText(/^More link$/)).toBeNull();
    expect(within(featured).queryByRole("button", { name: /Hide from page/ })).toBeNull();
    expect(within(featured).queryByRole("button", { name: /^Remove / })).toBeNull();
    closeComponentEditor();

    fireEvent.click(screen.getByRole("button", { name: "Edit Passport" }));
    const passport = screen.getByRole("dialog", { name: "Passport" });
    expect(within(passport).getByRole("textbox", { name: "Heading" })).toBeVisible();
    expect(within(passport).getByRole("textbox", { name: "Body" })).toBeVisible();
    expect(within(passport).queryByRole("button", { name: /Hide from page/ })).toBeNull();
    closeComponentEditor();

    fireEvent.click(screen.getByRole("button", { name: "Edit Passport action" }));
    const action = screen.getByRole("dialog", { name: "Passport action" });
    expect(within(action).getByLabelText("Button label")).toBeVisible();
    expect(within(action).queryByLabelText("Button link")).toBeNull();
    expect(within(action).queryByRole("button", { name: "Add button" })).toBeNull();
    expect(within(action).queryByRole("button", { name: /Hide from page/ })).toBeNull();
  });

  it("shows a new Home manual shelf before Featured and moves it by public placement", async () => {
    const onDraftChange = vi.fn();
    renderHomeEditor({ onDraftChange });

    const addContent = screen.getAllByRole("button", { name: /^Add content/ }).at(-1);
    if (!addContent) throw new Error("Missing add content control");
    fireEvent.click(addContent);
    fireEvent.click(screen.getByRole("radio", { name: "manual content shelf" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));
    await waitFor(() => expect(onDraftChange).toHaveBeenCalled());
    const shelf = lastDraft(onDraftChange).find((block) => block.type === "promotion_playlist");
    expect(shelf?.data.placement).toBe("before_featured");
    const shelfEdit = screen.getByRole("button", { name: "Edit Manual content shelf 1" });
    const featured = screen.getByRole("button", { name: "Edit Featured programs" });
    expect(shelfEdit.compareDocumentPosition(featured) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("button", { name: /^Move: manual content shelf plank/ }), { key: "ArrowDown" });
    expect(lastDraft(onDraftChange).find((block) => block.id === shelf?.id)?.data.placement).toBe("before_passport");
  });

  it("gives two Home manual shelves distinct edit controls and dialogs", () => {
    const first = {
      ...createBlock("promotion_playlist", "shelf-a"),
      data: { ...createBlock("promotion_playlist", "shelf-a").data, title: "Evening programs" },
    };
    const second = {
      ...createBlock("promotion_playlist", "shelf-b"),
      data: { ...createBlock("promotion_playlist", "shelf-b").data, title: "Weekend watch" },
    };
    renderHomeEditor({
      initialBlocks: [...homeCompositionDefaults() as AdminBlock[], first, second],
    });

    expect(screen.getByRole("button", { name: "Edit Manual content shelf: Evening programs" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit Manual content shelf: Weekend watch" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit Manual content shelf: Evening programs" }));
    expect(screen.getByRole("dialog", { name: "Manual content shelf: Evening programs" })).toBeVisible();
    expect(screen.getAllByText("manual content shelf", { selector: ".block-card-kind" })).toHaveLength(2);
  });

  it("gives duplicate Home manual shelf titles distinct edit controls and keeps blank names numbered", () => {
    const first = {
      ...createBlock("promotion_playlist", "shelf-a"),
      data: { ...createBlock("promotion_playlist", "shelf-a").data, title: "Evening programs" },
    };
    const second = {
      ...createBlock("promotion_playlist", "shelf-b"),
      data: { ...createBlock("promotion_playlist", "shelf-b").data, title: "Evening programs" },
    };
    const blank = createBlock("promotion_playlist", "shelf-blank");
    const unique = {
      ...createBlock("promotion_playlist", "shelf-unique"),
      data: { ...createBlock("promotion_playlist", "shelf-unique").data, title: "Weekend watch" },
    };
    renderHomeEditor({
      initialBlocks: [...homeCompositionDefaults() as AdminBlock[], first, second, blank, unique],
    });

    function shelfEditButton(id: string, name: string) {
      const card = document.getElementById(`block-card-${id}`);
      if (!card) throw new Error(`No shelf card for ${id}`);
      return within(card).getByRole("button", { name });
    }

    expect(shelfEditButton(first.id, "Edit Manual content shelf: Evening programs 1")).toBeVisible();
    expect(shelfEditButton(second.id, "Edit Manual content shelf: Evening programs 2")).toBeVisible();
    expect(shelfEditButton(blank.id, "Edit Manual content shelf 3")).toBeVisible();
    expect(shelfEditButton(unique.id, "Edit Manual content shelf: Weekend watch")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit Manual content shelf: Evening programs" })).toBeNull();

    fireEvent.click(shelfEditButton(second.id, "Edit Manual content shelf: Evening programs 2"));
    expect(screen.getByRole("dialog", { name: "Manual content shelf: Evening programs 2" })).toBeVisible();
    closeComponentEditor();
    fireEvent.click(shelfEditButton(blank.id, "Edit Manual content shelf 3"));
    expect(screen.getByRole("dialog", { name: "Manual content shelf 3" })).toBeVisible();
  });

  it("saves Featured programs settings without branded card previews", async () => {
    const onSave = vi.fn();
    renderHomeEditor({ onSave });

    expect(screen.queryByRole("group", { name: /page preview$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Featured programs" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Shelf heading" }), {
      target: { value: "Programs selected for New Jersey" },
    });
    clickPageCommand("Save page");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(blockText((onSave.mock.calls[0][0] as AdminBlock[]).find(
      (block) => block.section === "home-featured",
    ))).toContain("Programs selected for New Jersey");
  });

  it.each([
    ["Featured programs", ["4", "8"]],
    ["More to watch", ["4", "8", "12", "16"]],
    ["NJ Spotlight News", ["4", "8"]],
  ])("keeps %s settings compatible with production when Home layouts are disabled", (label, counts) => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    renderHomeEditor();
    fireEvent.click(screen.getByRole("button", { name: "Edit " + label }));
    const dialog = within(screen.getByRole("dialog", { name: label }));
    expect(dialog.queryByLabelText("Shelf layout")).not.toBeInTheDocument();
    expect(dialog.queryByLabelText("Grid columns")).not.toBeInTheDocument();
    expect(within(dialog.getByLabelText(/^Number of items/)).getAllByRole("option").map(option => option.getAttribute("value")))
      .toEqual(counts);
  });

  it.each([
    ["Featured programs", "home-featured", "pbs_featured"],
    ["More to watch", "home-more", "pbs_more"],
  ])("edits the %s layout without changing its protected source or position", async (label, section, source) => {
    const onSave = vi.fn();
    renderHomeEditor({ onSave });
    fireEvent.click(screen.getByRole("button", { name: "Edit " + label }));
    const dialog = within(screen.getByRole("dialog", { name: label }));
    expect(dialog.getByLabelText("Shelf layout")).toHaveValue("rail");
    expect(dialog.queryByLabelText("Grid columns")).not.toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Shelf layout"), { target: { value: "grid" } });
    expect(dialog.getByLabelText("Grid columns")).toHaveValue("3");
    fireEvent.change(dialog.getByLabelText("Grid columns"), { target: { value: "4" } });
    fireEvent.change(dialog.getByLabelText(/^Number of items/), { target: { value: "6" } });
    fireEvent.change(dialog.getByLabelText("Shelf layout"), { target: { value: "rail" } });
    fireEvent.change(dialog.getByLabelText("Shelf layout"), { target: { value: "grid" } });
    expect(dialog.getByLabelText("Grid columns")).toHaveValue("4");
    expect(dialog.queryByLabelText(/^Content source/)).not.toBeInTheDocument();
    expect(dialog.queryByLabelText(/^More link$/)).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: /Hide from page|^Remove / })).not.toBeInTheDocument();
    clickPageCommand("Save page");
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = (onSave.mock.calls[0][0] as AdminBlock[]).find(block => block.section === section);
    const original = homeCompositionDefaults().find(block => block.section === section);
    expect(saved).toMatchObject({ id: original?.id, section, order: original?.order, visible: true,
      data: { source, presentation: "grid", columns: 4, itemLimit: 6, moreHref: "https://watch.njpbs.org/" } });
  });

  it.each([1, 2] as const)("refuses a v%s imperative forced save even when conflict overwrite is allowed", async version => {
    const onSave = vi.fn();
    const editorRef = createRef<BlockEditorHandle>();
    renderHomeEditor({ ref: editorRef, homeCompositionVersion: version, onSave, allowConflictOverwrite: true });

    let outcome;
    await act(async () => {
      outcome = await editorRef.current?.save({ force: true });
    });

    expect(outcome).toEqual({ landed: false, clean: false });
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("EditorWorkspace Home canvas", () => {
  it("shows every legacy Home section with its manual shelf in the saved placement", async () => {
    renderHomeWorkspace({
      loadPage: vi.fn(async () => legacyHomePage()),
      convertHome: vi.fn(),
    });

    expect(await screen.findByRole("region", {
      name: /Fixed Home page context/,
    })).toHaveTextContent("Public Home frame");
    expect(screen.getByRole("region", {
      name: /Manual content shelf/i,
    })).toBeTruthy();
    expect(screen.queryByRole("group", { name: /page preview$/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit Start here" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Enable Home editing" }),
    ).toBeEnabled();
  });

  it.each([
    [
      "has no current version",
      () => {
        const page = legacyHomePage();
        delete page.version;
        return page;
      },
      workspaceAdmin,
    ],
    [
      "does not exist yet",
      () => legacyHomePage({ expectedAbsent: true }),
      workspaceAdmin,
    ],
    [
      "is not a draft",
      () => legacyHomePage({ status: "approved" }),
      workspaceAdmin,
    ],
    [
      "has a publication in progress",
      () => legacyHomePage({ publishBuildPending: true }),
      workspaceAdmin,
    ],
    [
      "cannot be edited by this person",
      () => legacyHomePage(),
      workspaceViewer,
    ],
  ] satisfies ReadonlyArray<readonly [string, () => PageContent, Principal]>)(
    "does not enable legacy Home editing when it %s",
    async (_label, page, principal) => {
      const convertHome = vi.fn();
      renderHomeWorkspace({
        principal,
        loadPage: vi.fn(async () => page()),
        convertHome,
      });

      const enable = await screen.findByRole("button", {
        name: "Enable Home editing",
      });
      expect(enable).toBeDisabled();
      fireEvent.click(enable);
      expect(convertHome).not.toHaveBeenCalled();
    },
  );

  it("does not enable legacy Home editing while another session owns its lease", async () => {
    const convertHome = vi.fn();
    renderHomeWorkspace({
      loadPage: vi.fn(async () => legacyHomePage()),
      convertHome,
      editorLockActor: {
        id: "home-workspace-admin",
        name: "Home workspace admin",
      },
      editorLockClient: blockingEditorLockClient(),
    });

    expect(await screen.findByText(
      "Another editor is editing this right now",
    )).toBeTruthy();
    expect(screen.queryByRole("button", {
      name: "Enable Home editing",
    })).toBeNull();
    expect(convertHome).not.toHaveBeenCalled();
  });

  it("holds the workspace during conversion, then reloads the canonical marked Home draft", async () => {
    const conversion = deferred<PageContent>();
    const canonical = markedHomePage(8);
    const loadPage = vi.fn()
      .mockResolvedValueOnce(legacyHomePage())
      .mockResolvedValueOnce(canonical);
    const convertHome = vi.fn(() => conversion.promise);
    const publishContent = vi.fn();
    const onSavingChange = vi.fn();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "11111111-1111-4111-8111-111111111111",
    );
    renderHomeWorkspace({
      loadPage,
      convertHome,
      publishContent,
      onSavingChange,
    });

    const enable = await screen.findByRole("button", {
      name: "Enable Home editing",
    });
    fireEvent.click(enable);
    fireEvent.click(enable);

    await waitFor(() => expect(convertHome).toHaveBeenCalledTimes(1));
    expect(convertHome).toHaveBeenCalledWith(
      7,
      "11111111-1111-4111-8111-111111111111",
    );
    expect(screen.getByRole("button", {
      name: /^.+: Enabling editing…$/,
    })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Staff" })).toBeDisabled();
    expect(screen.getByLabelText(/^Page title/)).toBeDisabled();
    expect(onSavingChange).toHaveBeenLastCalledWith(true);

    await act(async () => conversion.resolve(canonical));

    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", {
      name: "Edit Passport",
    })).toBeEnabled();
    expect(screen.queryByRole("button", {
      name: "Enable Home editing",
    })).toBeNull();
    expect(publishContent).not.toHaveBeenCalled();
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
  });

  it("reuses the same version and request key when conversion is retried", async () => {
    const canonical = markedHomePage(8);
    const loadPage = vi.fn()
      .mockResolvedValueOnce(legacyHomePage())
      .mockResolvedValueOnce(canonical);
    const convertHome = vi.fn()
      .mockRejectedValueOnce(new Error("Home conversion was interrupted."))
      .mockResolvedValueOnce(canonical);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "22222222-2222-4222-8222-222222222222",
    );
    renderHomeWorkspace({ loadPage, convertHome });

    fireEvent.click(await screen.findByRole("button", {
      name: "Enable Home editing",
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Home conversion was interrupted.",
    );
    fireEvent.click(screen.getByRole("button", {
      name: "Enable Home editing",
    }));

    await waitFor(() => expect(convertHome).toHaveBeenCalledTimes(2));
    expect(convertHome.mock.calls).toEqual([
      [7, "22222222-2222-4222-8222-222222222222"],
      [7, "22222222-2222-4222-8222-222222222222"],
    ]);
    expect(await screen.findByRole("button", {
      name: "Edit Passport",
    })).toBeEnabled();
  });

  it.each(["metadata", "manual shelf"] as const)(
    "refuses conversion while the legacy Home %s has unsaved changes",
    async (draftKind) => {
      const convertHome = vi.fn();
      renderHomeWorkspace({
        loadPage: vi.fn(async () => legacyHomePage()),
        convertHome,
      });

      const enable = await screen.findByRole("button", {
        name: "Enable Home editing",
      });
      if (draftKind === "metadata") {
        fireEvent.change(screen.getByLabelText(/^Page title/), {
          target: { value: "Unsaved Home title" },
        });
      } else {
        const manualShelf = screen.getByRole("region", {
          name: /Manual content shelf/i,
        });
        fireEvent.click(within(manualShelf).getByRole("button", { name: /^Edit / }));
        fireEvent.click(within(manualShelf).getByRole("button", {
          name: /Hide from page:/,
        }));
      }

      closeComponentEditor();
      await waitFor(() => expect(enable).toBeDisabled());
      fireEvent.click(enable);
      expect(convertHome).not.toHaveBeenCalled();
    },
  );

  it("keeps Home conversion available without branded card previews", async () => {
    renderHomeWorkspace({
      loadPage: vi.fn(async () => legacyHomePage()),
      convertHome: vi.fn(),
    });

    expect(await screen.findByRole("button", {
      name: "Enable Home editing",
    })).toBeEnabled();
    expect(screen.queryByRole("group", { name: /page preview$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry loading cards" })).toBeNull();
  });

  it("hydrates the marked canvas, echoes its base version, and keeps the marker after save", async () => {
    const loadPage = vi.fn(async (): Promise<PageContent> => markedHomePage());
    const savePage = vi.fn(
      async (
        _pageId: PublicPageId,
        _section: SectionId,
        blocks: AdminBlock[],
      ): Promise<PageContent> => ({
        ...markedHomePage(8),
        blocks,
      }),
    );
    renderHomeWorkspace({ loadPage, savePage });

    expect(await screen.findByRole("region", { name: "Newsletter signup" })).toBeVisible();
    expect(screen.queryByRole("region", { name: /Fixed Home page context/ })).toBeNull();

    fireEvent.click(await screen.findByRole("button", {
      name: "Edit Passport",
    }));
    await replaceRichText(screen.getByRole("textbox", { name: "Body" }), "<h2>Passport from the stored Home canvas</h2><p>Keep the rest.</p>");
    clickPageCommand("Save page");

    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    expect(savePage.mock.calls[0]?.slice(0, 4)).toEqual([
      "home",
      "home",
      expect.any(Array),
      7,
    ]);
    expect(blockText(savePage.mock.calls[0]?.[2].find(
      (block) => block.section === "home-passport-copy",
    ))).toContain("Passport from the stored Home canvas");
    expect(await screen.findByRole("button", {
      name: "Edit Passport",
    })).toBeTruthy();
    expect(screen.queryByText("Home page ownership")).toBeNull();
  });

  it("restores a marked Home canvas draft after visiting another page", async () => {
    const loadPage = vi.fn(async (pageId: PublicPageId): Promise<PageContent> =>
      pageId === "home"
        ? markedHomePage()
        : {
            blocks: [],
            metadata: { title: "Staff" },
            createdBy: workspaceAdmin.id,
            status: "draft",
            version: 2,
          },
    );
    const savePage = vi.fn(async (): Promise<PageContent> => markedHomePage(8));
    renderHomeWorkspace({ loadPage, savePage });

    fireEvent.click(await screen.findByRole("button", {
      name: "Edit Passport",
    }));
    await replaceRichText(screen.getByRole("textbox", { name: "Body" }), "<h2>Unsaved Home canvas draft</h2><p>Keep the rest.</p>");
    await act(async () => {});

    clickPageCommand("Staff");
    await screen.findByRole("button", { name: "Add content: position 1" });
    fireEvent.click(screen.getByRole("button", { name: "Home page" }));

    fireEvent.click(await screen.findByRole("button", {
      name: "Edit Passport",
    }));
    expect(screen.getByRole("textbox", { name: "Body" })).toHaveTextContent(
      "Unsaved Home canvas draft",
    );
    expect(screen.queryByText("Home page ownership")).toBeNull();
    expect(loadPage.mock.calls.filter(([pageId]) => pageId === "home")).toHaveLength(1);
  });

  it("restores the legacy Home canvas after an explicit reload returns no marker", async () => {
    const legacyHistoricalPageContent: PageContent = {
      blocks: [],
      metadata: { title: "Home" },
      createdBy: workspaceAdmin.id,
      status: "draft",
      version: 8,
    };
    let storedPage = markedHomePage();
    const loadPage = vi.fn(async (): Promise<PageContent> => storedPage);
    const savePage = vi.fn(async (): Promise<PageContent> => {
      throw Object.assign(new Error("The stored Home page changed."), {
        status: 409,
      });
    });
    renderHomeWorkspace({ loadPage, savePage });

    fireEvent.click(await screen.findByRole("button", {
      name: "Edit Passport",
    }));
    await replaceRichText(screen.getByRole("textbox", { name: "Body" }), "<h2>Edit based on the former revision</h2><p>Keep the rest.</p>");
    storedPage = legacyHistoricalPageContent;
    clickPageCommand("Save page");
    await screen.findByText(/Someone else saved this page/);
    fireEvent.click(screen.getByRole("button", {
      name: "Reload the page, discarding your changes",
    }));

    expect(await screen.findByRole("region", {
      name: /Fixed Home page context/,
    })).toHaveTextContent("Public Home frame");
    expect(screen.queryByRole("button", { name: "Edit Start here" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Passport" })).toBeNull();
    expect(loadPage).toHaveBeenCalledTimes(2);
  }, 10_000);
});
