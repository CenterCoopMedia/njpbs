import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { EditorWorkspace } from "../src/components/EditorWorkspace";
import { adminPerf, PERF_MARKS } from "../src/lib/perf-receipts";
import type { Principal } from "../../packages/content-core/src/rbac";

const admin: Principal = { id: "a", grants: [{ role: "admin" }] };

function readyMarks(): number {
  return adminPerf
    .receipt()
    .marks.filter((mark) => mark.name === PERF_MARKS.editorReady).length;
}

function mountedMarks(): number {
  return adminPerf
    .receipt()
    .marks.filter((mark) => mark.name === PERF_MARKS.editorMounted).length;
}

afterEach(cleanup);

describe("editor readiness marking", () => {
  // "First usable editing surface" has to mean the editor committed a ready state and put
  // something editable on screen. Marking when the content request resolves counts data
  // loading as editor render, and a stale response that the workspace discards could consume
  // the once-only mark before anything was rendered at all.
  it("marks the deferred mount before the hydrated editor is ready", async () => {
    let resolveRecord: (value: {
      status: "ready";
      record: Record<string, unknown>;
    }) => void = () => undefined;
    const pending = new Promise<{
      status: "ready";
      record: Record<string, unknown>;
    }>((resolve) => {
      resolveRecord = resolve;
    });
    const readyBefore = readyMarks();
    const mountedBefore = mountedMarks();

    render(
      <MemoryRouter>
        <EditorWorkspace
          loadRecord={async () => pending}
          principal={admin}
          surface={{ kind: "record", record: "post", id: "post-1" }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mountedMarks()).toBe(mountedBefore + 1));
    expect(readyMarks()).toBe(readyBefore);

    resolveRecord({
      status: "ready",
      record: { id: "post-1", type: "post", title: "Draft", version: 3 },
    });

    await waitFor(() => expect(readyMarks()).toBe(readyBefore + 1));
    expect(screen.getByRole("textbox", { name: /^Post title/ })).toHaveValue(
      "Draft",
    );
  });
});
