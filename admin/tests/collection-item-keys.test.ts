import { describe, expect, it } from "vitest";
import {
  collectionItemId,
  collectionItemsById,
  reconcileCollectionItemIds,
  sameCollectionItemIds,
} from "../src/lib/collection-item-keys";

function minter() {
  let sequence = 0;
  return () => `item-${++sequence}`;
}

describe("persisted collection item identity (#1127)", () => {
  it("assigns a unique id to every legacy item", () => {
    const next = reconcileCollectionItemIds(
      [],
      [{ title: "One" }, { title: "Two" }],
      minter(),
    );
    expect(next.map(collectionItemId)).toEqual(["item-1", "item-2"]);
    expect(collectionItemsById(next)?.size).toBe(2);
  });

  it("preserves an already canonical list by reference", () => {
    const items = [{ itemId: "a" }, { itemId: "b" }];
    expect(reconcileCollectionItemIds(items, items, minter())).toBe(items);
  });

  it("moves legacy ids with items matched by content during reorder", () => {
    const prior = [
      { itemId: "a", title: "One", body: { text: "A" } },
      { itemId: "b", title: "Two", body: { text: "B" } },
    ];
    const next = reconcileCollectionItemIds(
      prior,
      [
        { title: "Two", body: { text: "B" } },
        { title: "One", body: { text: "A" } },
      ],
      minter(),
    );
    expect(next.map(collectionItemId)).toEqual(["b", "a"]);
    expect(sameCollectionItemIds(prior, next)).toBe(true);
  });

  it("keeps the same-position id when one item's content changes", () => {
    const prior = [
      { itemId: "a", title: "One" },
      { itemId: "b", title: "Two" },
    ];
    const next = reconcileCollectionItemIds(
      prior,
      [{ title: "One edited" }, { title: "Two" }],
      minter(),
    );
    expect(next.map(collectionItemId)).toEqual(["a", "b"]);
  });

  it("repairs duplicate ids instead of collapsing two rows", () => {
    const next = reconcileCollectionItemIds(
      [],
      [{ itemId: "same" }, { itemId: "same" }],
      minter(),
    );
    expect(next.map(collectionItemId)).toEqual(["same", "item-1"]);
    expect(collectionItemsById(next)?.size).toBe(2);
  });

  it("requires the same complete unique id set for an undo overlay", () => {
    const prior = [{ itemId: "a" }, { itemId: "b" }];
    expect(sameCollectionItemIds(prior, [prior[1], prior[0]])).toBe(true);
    expect(sameCollectionItemIds(prior, [{ itemId: "a" }])).toBe(false);
    expect(sameCollectionItemIds(prior, [{ itemId: "a" }, {}])).toBe(false);
  });
});
