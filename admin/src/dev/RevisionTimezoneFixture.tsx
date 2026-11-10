import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ShellLayout } from "../routes/ShellLayout";
import { ShellProvider, type ShellData } from "../routes/ShellContext";
import { EditorWorkspace } from "../components/EditorWorkspace";
import type { RevisionSummary } from "../lib/functions";
import { createStudyReferenceFixtures } from "./StudyReferenceFixtures";
import "../styles.css";

if (!import.meta.env.DEV)
  throw new Error("Revision fixtures are development-only.");
const params = new URLSearchParams(location.search);
const kind = params.get("kind") === "page" ? "page" : "post";
const longValues = params.get("values") === "long";
const beforeTitle = longValues
  ? "Earlier sample headline with several complete words in a narrow revision panel"
  : "Earlier sample headline";
const afterTitle = longValues
  ? "Updated sample headline with several complete words in a narrow revision panel"
  : "Updated sample headline";
const revisionBlocks = (text: string, anchor: string) => longValues
  ? [{ id: "sample-heading", type: "heading", data: { text, anchor } }]
  : [];
const api = createStudyReferenceFixtures();
const stamps =
  params.get("boundary") === "fall-east"
    ? ["2026-11-01T06:30:00.000Z", "2026-11-01T05:30:00.000Z"]
    : params.get("boundary") === "fall-west"
      ? ["2026-11-01T09:30:00.000Z", "2026-11-01T08:30:00.000Z"]
      : params.get("boundary") === "spring-east"
        ? ["2026-03-08T07:00:00.000Z", "2026-03-08T06:59:00.000Z"]
        : params.get("boundary") === "spring-west"
          ? ["2026-03-08T10:00:00.000Z", "2026-03-08T09:59:00.000Z"]
          : ["2026-10-14T18:42:49.565Z", "2026-10-13T18:42:49.565Z"];
const entries: RevisionSummary[] = stamps.map((at, index) => ({
  id: `sample-revision-${9 - index}`,
  action: "update",
  actorUid: "sample-editor",
  actorEmail: "editor@example.test",
  at,
  beforeVersion: 8 - index,
  version: 9 - index,
  contentVersion: 9 - index,
  beforeStatus: "draft",
  status: "draft",
  beforeBlockCount: longValues ? 1 : 0,
  blockCount: longValues ? 1 : 0,
  mediaReferenceCount: 0,
  mediaReferencesAdded: 0,
  mediaReferencesRemoved: 0,
  beforeTruncated: false,
  diffAvailable: true,
  changedFields: ["title"],
  changedFieldCount: 1,
  changedFieldsTruncated: false,
}));
const unavailable = async () => {
  throw new Error(
    "This read-only fixture does not save, restore, preview or publish.",
  );
};
const principal: ShellData["principal"] = {
  id: "revision-fixture",
  grants: [{ role: "super_admin" }],
};
const shell: ShellData = {
  principal,
  user: {
    uid: "revision-fixture",
    email: "editor@example.test",
    displayName: "Sample editor",
  },
  userDoc: {
    role: "super_admin",
    displayName: "Sample editor",
  } as ShellData["userDoc"],
  signOut: () => {},
  navigationShares: [],
};
const router = createMemoryRouter(
  [
    {
      path: "/",
      element: <ShellLayout />,
      children: [
        {
          path: "content/*",
          handle: { title: kind === "page" ? "Edit page" : "Edit post" },
          element: (
            <EditorWorkspace
              {...api}
              principal={principal}
              surface={
                kind === "page"
                  ? { kind: "page", pageId: "home", section: "home" }
                  : { kind: "record", record: "post", id: "study-post" }
              }
              savePage={unavailable}
              savePageMetadata={unavailable}
              saveRecord={unavailable}
              requestSavedPreview={unavailable}
              publishContent={unavailable}
              scheduleContent={unavailable}
              transitionContent={unavailable}
              loadRevisions={async () => ({
                success: true,
                entries: structuredClone(entries),
                nextCursor: null,
              })}
              loadRevision={async (collection, documentId, revisionId) => {
                const entry = entries.find((row) => row.id === revisionId);
                if (!entry) throw new Error("Unknown fixture revision.");
                return {
                  success: true,
                  revision: {
                    id: entry.id,
                    collection,
                    documentId,
                    action: "update",
                    actorUid: entry.actorUid,
                    actorEmail: entry.actorEmail,
                    at: entry.at,
                    beforeTruncated: false,
                    before: {
                      title: beforeTitle,
                      version: entry.beforeVersion,
                      status: "draft",
                      blocks: revisionBlocks(beforeTitle, "a".repeat(100)),
                    },
                    after: {
                      title: afterTitle,
                      version: entry.version,
                      contentVersion: entry.version,
                      status: "draft",
                      blocks: revisionBlocks(afterTitle, "b".repeat(100)),
                    },
                  },
                };
              }}
            />
          ),
        },
      ],
    },
  ],
  {
    initialEntries: [
      kind === "page"
        ? "/content/pages/home/edit"
        : "/content/post/study-post/edit",
    ],
  },
);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShellProvider value={shell}>
      <RouterProvider router={router} />
    </ShellProvider>
  </StrictMode>,
);
