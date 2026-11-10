import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { MediaFilterChips, type MediaFilterChipModel } from "../src/components/media/MediaFilterChips";

function Harness({ initial, landRemovals = true }: { initial: MediaFilterChipModel[]; landRemovals?: boolean }) {
  const filterRef = useRef<HTMLButtonElement>(null);
  const [chips, setChips] = useState(initial);
  return <>
    <button ref={filterRef} type="button">Filter</button>
    <MediaFilterChips
      chips={chips}
      filterButtonRef={filterRef}
      onClearAll={() => setChips([])}
      onEdit={() => {}}
      onRemove={(chip) => {
        if (landRemovals) setChips(current => current.filter(candidate => candidate.key !== chip.key));
        else setChips(current => [...current, { key: "category:sports", field: "category", value: "sports", label: "Category: Sports" }]);
      }}
    />
  </>;
}

describe("MediaFilterChips", () => {
  it("keeps focus on a refused removal when a tag key contains a separator", () => {
    const tag = { key: "tag:news|local", field: "tag", value: "news|local", label: "Tag: news|local" };
    render(<Harness initial={[tag]} landRemovals={false} />);
    const remover = screen.getByRole("button", { name: "Remove filter Tag: news|local" });
    remover.focus();
    fireEvent.click(remover);
    expect(remover).toHaveFocus();
  });
});
