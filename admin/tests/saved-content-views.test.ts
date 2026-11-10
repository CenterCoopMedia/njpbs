import { describe, expect, it } from "vitest";
import {
  MAX_SAVED_CONTENT_VIEWS,
  SavedContentViewValidationError,
  applySavedContentViewMutation,
  createSavedContentView,
  parseSavedContentViews,
} from "../src/lib/saved-content-views";
import { DEFAULT_CONTENT_QUERY } from "../src/lib/content-query";

describe("saved content views", () => {
  it("creates a trimmed view with a canonical, page-independent query", () => {
    expect(
      createSavedContentView(
        "view-1",
        "  Draft articles  ",
        {
          ...DEFAULT_CONTENT_QUERY,
          types: ["article"],
          statuses: ["draft"],
          page: 7,
        },
      ),
    ).toEqual({
      id: "view-1",
      name: "Draft articles",
      query: "type=article&status=draft&v=1",
    });
  });

  it("rejects an empty name or unsafe id", () => {
    for (const create of [
      () => createSavedContentView("view-1", "   ", DEFAULT_CONTENT_QUERY),
      () =>
        createSavedContentView("spaces are not safe", "Drafts", DEFAULT_CONTENT_QUERY),
    ]) {
      expect(create).toThrow(SavedContentViewValidationError);
    }
  });

  it("parses untrusted profile data, canonicalizes queries, and enforces the cap", () => {
    const value = [
      { id: "one", name: "  One  ", query: "status=draft&page=9&v=1" },
      { id: "one", name: "Duplicate id", query: "status=published&v=1" },
      { id: "bad name", name: "", query: "v=1" },
      ...Array.from({ length: MAX_SAVED_CONTENT_VIEWS }, (_, index) => ({
        id: `view-${index}`,
        name: `View ${index}`,
        query: "owner=me&v=1",
      })),
    ];

    const parsed = parseSavedContentViews(value);
    expect(parsed).toHaveLength(MAX_SAVED_CONTENT_VIEWS);
    expect(parsed[0]).toEqual({ id: "one", name: "One", query: "status=draft&v=1" });
    expect(parsed.filter((view) => view.id === "one")).toHaveLength(1);
  });

  it("applies one add or delete without replacing unrelated views", () => {
    const current = [
      { id: "drafts", name: "Drafts", query: "status=draft&v=1" },
      { id: "review", name: "Review", query: "status=in_review&v=1" },
    ];

    expect(
      applySavedContentViewMutation(current, {
        type: "add",
        view: { id: "scheduled", name: "Scheduled", query: "status=scheduled&v=1" },
      }),
    ).toEqual([
      ...current,
      { id: "scheduled", name: "Scheduled", query: "status=scheduled&v=1" },
    ]);
    expect(
      applySavedContentViewMutation(current, { type: "delete", id: "drafts" }),
    ).toEqual([current[1]]);
  });

  it("rejects a concurrently-added duplicate name or filter", () => {
    const current = [
      { id: "drafts", name: "Drafts", query: "status=draft&v=1" },
    ];

    expect(() =>
      applySavedContentViewMutation(current, {
        type: "add",
        view: { id: "other", name: "drafts", query: "status=published&v=1" },
      }),
    ).toThrow("named");
    expect(() =>
      applySavedContentViewMutation(current, {
        type: "add",
        view: { id: "other", name: "Other", query: "status=draft&page=4&v=1" },
      }),
    ).toThrow("already saved");
  });

  it("uses destination-neutral copy when a concurrent add reaches the saved-view cap", () => {
    const current = Array.from({ length: MAX_SAVED_CONTENT_VIEWS }, (_, index) => ({
      id: `view-${index}`,
      name: `View ${index}`,
      query: `q=view-${index}&v=1`,
    }));

    expect(() =>
      applySavedContentViewMutation(current, {
        type: "add",
        view: { id: "extra", name: "Extra", query: "q=extra&v=1" },
      }),
    ).toThrow(`You can save up to ${MAX_SAVED_CONTENT_VIEWS} views.`);
  });
});
