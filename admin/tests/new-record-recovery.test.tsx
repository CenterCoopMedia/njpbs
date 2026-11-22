import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo } from "react";
import { Link, MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { RecordKind } from "../../packages/content-core/src/editor-admin";
import type { Principal } from "../../packages/content-core/src/rbac";
import { EditorWorkspace } from "../src/components/EditorWorkspace";
import { NewRecordRecoveryNotice } from "../src/components/NewRecordRecoveryNotice";
import { canCreateEditableRecord, heldNewRecords, holdNewRecord } from "../src/lib/new-record-recovery";
import { clearSessionEnded, markSessionEnded } from "../src/lib/session-ended";
import { contentLibraryPath, createRecordPath, editRecordPath, mountedSurfaceForRoute, parseContentPath } from "../src/lib/routes";

const editor = { id: "example-editor", grants: [{ role: "editor", sections: ["news", "station"] }] } satisfies Principal;
const areas = [
  { id: "news", label: "News" },
  { id: "station", label: "Station" },
  { id: "other", label: "Other" },
];

function mountStudio(path: string, principal = editor, pendingCreateNonce?: string) {
  const saveRecord = vi.fn(async (_kind: RecordKind, record: Record<string, unknown>, _options?: { createNonce?: string }) =>
    ({ ...record, id: "saved-record", version: 1, status: "draft" }));
  function Studio() {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const surface = useMemo(() => mountedSurfaceForRoute(parseContentPath(pathname))!, [pathname]);
    return <>
      <Link to={contentLibraryPath()}>Library</Link>
      <NewRecordRecoveryNotice actorId={principal.id} />
      <EditorWorkspace
        principal={principal}
        surface={surface}
        onNavigateSurface={next => {
          if (next.kind === "record" && next.id) navigate(editRecordPath(next.record, next.id), { replace: true });
        }}
        saveRecord={saveRecord}
        pendingRecordCreateNonce={() => pendingCreateNonce}
        contentSections={areas}
        newRecordRecoveryAreas={areas.filter(area => canCreateEditableRecord(principal, area.id))}
        autoSaveEnabled
      />
    </>;
  }
  return { ...render(<MemoryRouter initialEntries={[path]}><Studio /></MemoryRouter>), saveRecord };
}

afterEach(() => {
  cleanup();
  clearSessionEnded();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("holds a new Post away from its create route and restores it through the banner with autosave paused", async () => {
  const original = mountStudio(createRecordPath("post"), editor, "fixture-create-nonce");
  fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), { target: { value: "Notes for a new Post" } });
  fireEvent.click(screen.getByRole("link", { name: "Library", exact: true }));
  act(() => markSessionEnded());
  original.unmount();
  clearSessionEnded();

  const other = mountStudio(contentLibraryPath(), { ...editor, id: "different-editor" });
  expect(screen.queryByRole("link", { name: "Review new post" })).toBeNull();
  other.unmount();

  const intervals = vi.spyOn(globalThis, "setInterval");
  const { saveRecord } = mountStudio(contentLibraryPath());
  fireEvent.click(screen.getByRole("link", { name: "Review new post" }));
  expect(await screen.findByRole("textbox", { name: "Post title" })).toHaveValue("Notes for a new Post");
  const autosaveTick = intervals.mock.calls.findLast(([, delay]) => delay === 60_000)?.[0] as () => void;
  await act(async () => autosaveTick());
  expect(saveRecord).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(saveRecord).toHaveBeenCalledWith(
    "post", expect.objectContaining({ title: "Notes for a new Post" }), { createNonce: "fixture-create-nonce" },
  ));
  await waitFor(() => expect(heldNewRecords(editor.id, "post")).toEqual([]));
});

it("lets a scoped editor choose among permitted areas before revealing and saving a non-Post draft", async () => {
  const original = mountStudio(createRecordPath("sponsor"));
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Sample sponsor" } });
  fireEvent.change(screen.getByLabelText(/^Website/), { target: { value: "https://example.org/" } });
  act(() => markSessionEnded());
  original.unmount();
  clearSessionEnded();

  const { saveRecord } = mountStudio(contentLibraryPath());
  fireEvent.click(screen.getByRole("link", { name: "Review new sponsor" }));
  expect(screen.queryByDisplayValue("Sample sponsor")).toBeNull();
  const picker = screen.getByRole("combobox", { name: "Editorial area" });
  expect(within(picker).queryByRole("option", { name: "Other" })).toBeNull();
  fireEvent.change(picker, { target: { value: "station" } });
  fireEvent.click(screen.getByRole("button", { name: "Restore draft" }));
  expect(screen.getByLabelText(/^Name/)).toHaveValue("Sample sponsor");
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(saveRecord).toHaveBeenCalledWith(
    "sponsor", expect.objectContaining({ name: "Sample sponsor", section: "station" }),
    { createNonce: expect.any(String) },
  ));
  await waitFor(() => expect(heldNewRecords(editor.id, "sponsor")).toEqual([]));
});

it("withholds a draft whose original area is no longer allowed and honors discard", () => {
  holdNewRecord(editor.id, "sponsor", { name: "Held sponsor", section: "other" });
  const { saveRecord } = mountStudio(createRecordPath("sponsor"));
  expect(screen.getByText("This draft is outside your current access")).toBeVisible();
  expect(screen.queryByDisplayValue("Held sponsor")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(screen.getByLabelText(/^Name/)).toHaveValue("");
  expect(heldNewRecords(editor.id, "sponsor")).toEqual([]);
  expect(saveRecord).not.toHaveBeenCalled();
});

it("lets the editor recover distinct drafts of the same type without overwriting either", () => {
  holdNewRecord(editor.id, "post", { title: "First held Post" });
  holdNewRecord(editor.id, "post", { title: "Second held Post" });
  mountStudio(createRecordPath("post"));
  fireEvent.click(screen.getByRole("button", { name: /draft 1/ }));
  const first = (screen.getByRole("textbox", { name: "Post title" }) as HTMLInputElement).value;
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  fireEvent.click(screen.getByRole("button", { name: /draft 1/ }));
  const second = (screen.getByRole("textbox", { name: "Post title" }) as HTMLInputElement).value;
  expect([first, second].sort()).toEqual(["First held Post", "Second held Post"]);
});
