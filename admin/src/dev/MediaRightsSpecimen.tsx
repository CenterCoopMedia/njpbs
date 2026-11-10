/** Opt-in local evidence entry: real editor shell, synthetic identity, no live writes. */
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { EditorWorkspace } from "../components/EditorWorkspace";
import { ShellLayout } from "../routes/ShellLayout";
import { ShellProvider, type ShellData } from "../routes/ShellContext";
import "../styles.css";
import "../content-scan-flow.css";
import "../cms-workspace.css";

const principal: ShellData["principal"] = { id: "rights-fixture", grants: [{ role: "admin" }] };
const state = { postSaves: 0, dirty: false };
declare global { interface Window { __RIGHTS_EDITOR_FIXTURE__?: typeof state } }
window.__RIGHTS_EDITOR_FIXTURE__ = state;
const prose = (id: string, order: number) => ({ id, type: "prose", order, visible: true, data: {
  content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text:
    "New Jersey communities are sharing their stories from the boardwalk. ".repeat(24),
  }] }] },
} });
const record = { id: "rights-story", type: "post", version: 1, status: "draft", slug: "rights-story",
  title: "Stories from the New Jersey boardwalk", summary: "A local fixture of the real Post editor.",
  date: "2026-10-16", tags: [], credits: [], leadMedia: null,
  blocks: [prose("opening", 0), { id: "rights-video", type: "video", order: 1, visible: true,
    data: { sourceId: "video-library", assetId: "rights-video", title: "A walk along the boardwalk" } }, prose("ending", 2)],
};
const router = createMemoryRouter([{ path: "/", element: <ShellLayout />, children: [{
  path: "content/*", handle: { title: "Edit post", description: "Local media rights evidence." },
  element: <EditorWorkspace principal={principal} surface={{ kind: "record", record: "post", id: record.id }}
    loadRecord={async () => ({ status: "ready", record: structuredClone(record) })}
    onDirtyChange={dirty => { state.dirty = dirty; }}
    saveRecord={async (_kind, document) => { state.postSaves++; return { ...document, id: record.id, version: 2 }; }} />,
}] }], { initialEntries: ["/content/post/rights-story/edit"] });
const shell: ShellData = { principal, user: { uid: "rights-fixture", email: null, displayName: "Sample editor" },
  userDoc: { role: "admin", grants: principal.grants, displayName: "Sample editor" }, signOut() {},
  getIdToken: async () => "local-rights-evidence-only",
};
createRoot(document.getElementById("media-rights-root")!).render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);
