import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ElectionResultsEditor } from "../src/components/ElectionResultsEditor";
import { ElectionResultsReview } from "../src/context/ElectionResultsReview";
import { electionBlock, electionRace } from "../../tests/fixtures/election-results";
import type { AdminBlock } from "../src/lib/block-factory";

afterEach(cleanup);
function Draft() {
  const [block, setBlock] = useState<AdminBlock>(electionBlock());
  return <><ElectionResultsEditor block={block} onChange={data => setBlock({ ...block, data })} />
    <output aria-label="Saved draft">{JSON.stringify(block.data)}</output></>;
}
describe("manual race editing", () => {
  it("keeps blank votes distinct from zero and makes AP attribution editable before saving", () => {
    render(<Draft />);
    const votes = screen.getAllByRole("spinbutton", { name: "Votes" })[0];
    fireEvent.change(votes, { target: { value: "" } });
    expect(JSON.parse(screen.getByLabelText("Saved draft").textContent!).races[0].candidates[0].votes).toBeNull();
    fireEvent.change(votes, { target: { value: "0" } });
    expect(JSON.parse(screen.getByLabelText("Saved draft").textContent!).races[0].candidates[0].votes).toBe(0);
    fireEvent.change(screen.getByRole("combobox", { name: "Race status" }), { target: { value: "called" } });
    expect(screen.getByRole("combobox", { name: "Candidate called by AP" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "AP call link" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Source type" })).toHaveValue("ap");
  });
  it("shows the saved approval while changed values still need approval, including when locked", () => {
    const race = electionRace();
    const approval = { blockId: "results", raceId: race.id, digest: "private", race, revision: 2,
      status: race.status, approvedAt: "2026-11-04T02:16:00Z", approvedBy: { uid: "editor-a", displayName: "Editor A" },
      statusHistory: [{ revision: 2, status: race.status, approvedAt: "2026-11-04T02:16:00Z", approvedBy: { uid: "editor-a", displayName: "Editor A" } }] };
    const block = { ...electionBlock(), id: "results" };
    render(<ElectionResultsReview.Provider value={[approval]}>
      <ElectionResultsEditor block={{ ...block, data: { races: [{ ...race, office: "Changed office" }] } }} readOnly onChange={() => { throw Error("Locked draft changed"); }} />
    </ElectionResultsReview.Provider>);
    expect(screen.getByText("Needs approval")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Office" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add race" })).toBeDisabled();
    const history = screen.getByText("Race approval history");
    fireEvent.click(history);
    expect(within(history.parentElement!).getByText(/Latest approved revision 2: Editor A/)).toBeVisible();
  });
});
