import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { ContentTab } from "../src/components/ContentTab";
import type { ComponentProps } from "react";
import type { ContentBrowseWorkspace } from "../src/components/ContentBrowseWorkspace";
import type { Principal } from "../../packages/content-core/src/rbac";
import type { Surface } from "../src/components/EditorWorkspace";

const mocks = vi.hoisted(() => ({
  token: vi.fn(), categories: vi.fn(), pages: vi.fn(),
  sections: [{ id: "news", label: "News" }],
}));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => ({ getIdToken: mocks.token, state: { status: "signed-out" } }) }));
vi.mock("../src/lib/firebase", () => ({ db: {}, firebaseConfig: { projectId: "test" } }));
vi.mock("../src/lib/use-content-sections", () => ({ useContentSectionRegistry: () => ({ sections: mocks.sections, ready: true }) }));
vi.mock("../src/lib/functions", async (original) => ({
  ...await original<typeof import("../src/lib/functions")>(),
  cmsListPages: mocks.pages, cmsListMediaCategories: mocks.categories,
}));
// Keep the actual directory and its read ownership; other browse surfaces need no I/O here.
vi.mock("../src/components/ContentBrowseWorkspace", async () => {
  const { PagesDirectory } = await import("../src/components/PagesDirectory");
  return { ContentBrowseWorkspace: ({ surface, pageDirectoryApi }: ComponentProps<typeof ContentBrowseWorkspace>) => surface.kind === "page-list"
    ? <PagesDirectory api={pageDirectoryApi} /> : <div>Browse records</div> };
});
// Probe retained editor activation without loading rich text or writing a draft.
vi.mock("../src/components/EditorWorkspace", () => ({ EditorWorkspace: () => <div>Editor mounted</div> }));
const principal: Principal = { id: "editor", grants: [{ role: "super_admin" }] };
function host(surface: Surface, authority = principal) {
  return <MemoryRouter><ContentTab principal={authority} surface={surface} /></MemoryRouter>;
}
beforeEach(() => {
  mocks.token.mockReset().mockResolvedValue("token");
  mocks.categories.mockReset().mockResolvedValue({ categories: [] });
  mocks.pages.mockReset().mockResolvedValue({ pages: [{ id: "custom", title: "Private page", path: "/custom/", section: "news" }] });
  mocks.sections = [{ id: "news", label: "News" }];
});

describe("content browse request ownership", () => {
  it.each<Surface>([{ kind: "page-list" }, { kind: "library" }, { kind: "record-list", record: "post" }])("defers categories on $kind", async surface => {
    render(host(surface));
    await act(async () => {});
    expect(mocks.categories).not.toHaveBeenCalled();
    // The page list owns one token; other browse probes own no request.
    expect(mocks.token).toHaveBeenCalledTimes(surface.kind === "page-list" ? 1 : 0);
  });

  it("loads categories on first editor entry and retains them on return to browse", async () => {
    const view = render(host({ kind: "library" }));
    view.rerender(host({ kind: "page", pageId: "home", section: "home" }));
    await screen.findByText("Editor mounted");
    await waitFor(() => expect(mocks.categories).toHaveBeenCalledTimes(1));
    view.rerender(host({ kind: "library" }));
    await act(async () => {});
    expect(mocks.categories).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Editor mounted")).toBeInTheDocument();
  });

  it.each(["identity", "grants", "token provider"])("updates section labels without rereading but invalidates for changed %s", async change => {
    const view = render(host({ kind: "page-list" }));
    await act(async () => {});
    expect(screen.getByRole("row", { name: /Private page/ })).toBeInTheDocument();
    mocks.sections = [{ id: "news", label: "New desk" }];
    view.rerender(host({ kind: "page-list" }));
    expect(screen.getByRole("row", { name: /Private page/ })).toHaveTextContent("New desk");
    expect(mocks.pages).toHaveBeenCalledTimes(1);
    mocks.pages.mockResolvedValueOnce({ pages: [] });
    const nextPrincipal = change === "identity" ? { ...principal, id: "different-editor" }
      : change === "grants" ? { ...principal, grants: [] } : principal;
    if (change === "token provider") mocks.token = vi.fn().mockResolvedValue("new-token");
    view.rerender(host({ kind: "page-list" }, nextPrincipal));
    expect(screen.queryByRole("row", { name: /Private page/ })).toBeNull();
    await waitFor(() => expect(mocks.pages).toHaveBeenCalledTimes(2));
  });
});
