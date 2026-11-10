import { useMemo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { EditorWorkspace, type Surface } from "../src/components/EditorWorkspace";
import { EditorWorkspaceViewProvider, useEditorWorkspaceView } from "../src/context/EditorWorkspaceView";

afterEach(() => { cleanup(); localStorage.clear(); });

function ViewControls() {
  const view = useEditorWorkspaceView()!;
  const navigate = useNavigate();
  return <>
    <button onClick={() => { view.setArranging(true); view.setFocusWriting(true); view.setHistoryOpen(true); }}>Enable document views</button>
    <button onClick={() => view.closePane("outline", false)}>Hide outline preference</button>
    <button onClick={() => navigate(-1)}>Browser back</button>
    <button onClick={() => navigate(1)}>Browser forward</button>
    <output aria-label="Document views">{JSON.stringify([view.arranging, view.focusWriting, view.historyOpen])}</output>
    <output aria-label="Outline preference">{String(view.outlineOpen)}</output>
  </>;
}

it.each(["post", "page"] as const)("resets %s document views on duplicate/same-kind history navigation without changing drafts", async kind => {
  const save = vi.fn();
  const loadRecord = vi.fn(async (_kind, id) => ({ status: "ready" as const, record: {
    id, title: id, status: "draft", version: 1, blocks: [], tags: [], section: "news", createdBy: "admin",
  } }));
  const loadPage = vi.fn(async () => ({ blocks: [], version: 1, metadata: { title: "Page" } }));
  const duplicate = vi.fn(async () => ({ id: "second" }));
  function Fixture() {
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const surface = useMemo<Surface>(() => kind === "post"
      ? { kind: "record", record: "post", id: pathname.slice(1) }
      : { kind: "page", pageId: pathname === "/first" ? "home" : "watch", section: pathname === "/first" ? "home" : "programLanding" }, [pathname]);
    return <EditorWorkspaceViewProvider kind={kind}>
      <ViewControls />
      <button onClick={() => navigate("/second")}>Another page</button>
      <EditorWorkspace principal={{ id: "admin", grants: [{ role: "admin" }] }} surface={surface}
        loadRecord={loadRecord} loadPage={loadPage} duplicatePost={duplicate} saveRecord={save} savePage={save}
        onNavigateSurface={next => { if (next.kind === "record") navigate(`/${next.id}`); }} />
    </EditorWorkspaceViewProvider>;
  }
  render(<MemoryRouter initialEntries={["/first"]}><Fixture /></MemoryRouter>);
  await waitFor(() => expect(kind === "post" ? loadRecord : loadPage).toHaveBeenCalledTimes(1));
  if (kind === "post") {
    const headline = await screen.findByRole("textbox", { name: "Headline" });
    headline.focus();
    fireEvent.change(headline, { target: { value: "Retained local draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable document views" }));
    expect(screen.getByRole("textbox", { name: "Headline", hidden: true })).toBe(headline);
    expect(headline).toHaveValue("Retained local draft");
    expect(headline).toHaveFocus();
    // Revert only this test edit so Duplicate post can use the unchanged saved source.
    fireEvent.change(headline, { target: { value: "first" } });
  } else {
    await screen.findByRole("button", { name: "Add block: position 1" });
    fireEvent.click(screen.getByRole("button", { name: "Enable document views" }));
  }
  expect(screen.getByLabelText("Document views")).toHaveTextContent("[true,true,true]");
  fireEvent.click(screen.getByRole("button", { name: "Hide outline preference" }));
  if (kind === "post") {
    fireEvent.click(screen.getByRole("button", { name: "Post actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate post" }));
    await waitFor(() => expect(duplicate).toHaveBeenCalledWith("first", 1));
  } else fireEvent.click(screen.getByRole("button", { name: "Another page" }));
  await waitFor(() => expect(screen.getByLabelText("Document views")).toHaveTextContent("[false,false,false]"));
  expect(screen.getByLabelText("Outline preference")).toHaveTextContent("false");
  for (const action of ["Browser back", "Browser forward"]) {
    fireEvent.click(screen.getByRole("button", { name: "Enable document views" }));
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(screen.getByLabelText("Document views")).toHaveTextContent("[false,false,false]"));
  }
  expect(save).not.toHaveBeenCalled();
});
