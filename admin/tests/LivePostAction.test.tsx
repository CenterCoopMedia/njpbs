import { createHash, webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { EditorWorkspace } from "../src/components/EditorWorkspace";
import { WorkspaceActionsProvider } from "../src/components/WorkspaceActions";
import { PublicContentStatusProvider } from "../src/context/PublicContentStatusContext";

const identity = {
  schemaVersion: 1,
  buildBatchId: "build-one",
  generation: 1,
  commitSha: "a".repeat(40),
};
const contentKey = createHash("sha256").update("cmsPosts/post-one").digest("hex");
const admin = { id: "admin", grants: [{ role: "admin" as const }] };

function publicReceipt(path?: string, receiptIdentity = identity) {
  return {
    ...receiptIdentity,
    collections: ["cmsPages", "cmsPosts"],
    routes: path ? [{ path, source: "cms", sourceVersion: 8, contentKey }] : [],
  };
}

function renderPublishedPost(path?: string) {
  const actions = document.createElement("div");
  actions.dataset.testLivePostActions = "true";
  document.body.append(actions);
  vi.stubGlobal("crypto", webcrypto);
  let currentPath = path;
  let currentIdentity = identity;
  const fetch = vi.fn(async (url: string) => Response.json(
    url.includes("_content-status") ? publicReceipt(currentPath, currentIdentity) : currentIdentity,
  ));
  vi.stubGlobal("fetch", fetch);
  render(
    <MemoryRouter>
      <PublicContentStatusProvider>
        <WorkspaceActionsProvider target={actions}>
          <EditorWorkspace
            principal={admin}
            loadRecord={async () => ({
              status: "ready",
              record: {
                id: "post-one",
                type: "post",
                title: "Station update",
                slug: "new-working-slug",
                status: "draft",
                version: 12,
                contentVersion: 9,
                publiclyVisible: true,
                publicSourceVersion: 8,
                published: {
                  sourceVersion: 10,
                  contentVersion: 8,
                  metadata: { slug: "pending-slug" },
                },
              },
            })}
            surface={{ kind: "record", record: "post", id: "post-one" }}
          />
        </WorkspaceActionsProvider>
      </PublicContentStatusProvider>
    </MemoryRouter>,
  );
  return {
    actions,
    fetch,
    updatePublicRoute(nextPath: string) {
      currentPath = nextPath;
      currentIdentity = {
        ...identity,
        buildBatchId: "build-two",
        generation: 2,
        commitSha: "b".repeat(40),
      };
      window.dispatchEvent(new Event("focus"));
    },
  };
}

afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-test-live-post-actions]").forEach(element => element.remove());
  vi.unstubAllGlobals();
});

describe("the live Post action", () => {
  it("opens the exact route in the current public receipt without changing the editor", async () => {
    const { actions, updatePublicRoute } = renderPublishedPost("/posts/current-live-slug/");

    const link = await within(actions).findByRole("link", { name: "View live post (opens in a new tab)" });
    expect(link).toHaveAttribute("href", "https://njpbs.org/posts/current-live-slug/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const title = screen.getByRole("textbox", { name: "Post title" });
    fireEvent.change(title, { target: { value: "Unsaved station update" } });

    updatePublicRoute("/posts/published-new-slug/");

    await waitFor(() => expect(link).toHaveAttribute("href", "https://njpbs.org/posts/published-new-slug/"));
    expect(title).toHaveValue("Unsaved station update");
  });

  it("does not offer a live link when the current public receipt has no route for the Post", async () => {
    const { actions } = renderPublishedPost();

    await waitFor(() => expect(document.querySelector(".published-version-status"))
      .toHaveAttribute("data-public-state", "not-live"));
    expect(within(actions).queryByRole("link", { name: /View live post/ })).not.toBeInTheDocument();
  });
});
