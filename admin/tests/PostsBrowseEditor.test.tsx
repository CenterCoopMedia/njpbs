import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PostsBrowseEditor } from "../src/components/PostsBrowseEditor";
import { SiteNavigationSettings } from "../src/components/SiteNavigationSettings";
import { DEFAULT_SITE_NAVIGATION } from "../../packages/content-core/src/cms-settings";
import type { PostsBrowseConfig } from "../../packages/content-core/src/posts-browse";
const config: PostsBrowseConfig = { groups: [
  { id: "schools", label: "Schools", icon: "heart", terms: [{ filter: "category", value: "Education" }], cover: { filter: "category", value: "Education" } },
  { id: "people", label: "People", icon: "pin", terms: [] },
] };
function Harness({ load = async () => ({ tags: [], categories: [] }) }: { load?: () => Promise<{ tags: string[]; categories: string[] }> }) {
  const [value, setValue] = useState(config);
  return <><PostsBrowseEditor value={value} disabled={false} onChange={setValue} loadVocabulary={load} /><output data-testid="draft">{JSON.stringify(value)}</output></>;
}
const open = (text: string) => fireEvent.click(screen.getByText(text, { selector: "summary" }));
describe("Posts browsing in Boardwalk", () => {
  it("loads vocabulary only after opening, retries failure and preserves saved cover choices", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ tags: ["new topic"], categories: [] });
    render(<Harness load={load} />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Group name" })).not.toBeInTheDocument();
    open("Posts browsing · 2 groups");
    fireEvent.click(await screen.findByRole("button", { name: "Retry subjects" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByText("Schools · 1 subject", { selector: "summary" }));
    await screen.findByRole("textbox", { name: "Group name" });
    expect(screen.getByRole("combobox", { name: "Cover subject" })).toHaveValue(JSON.stringify(["category", "Education"]));
    expect(screen.getByLabelText("Subject 1")).toHaveValue("Education");
  });
  it("reorders groups and moves a subject without leaving an invalid cover behind", async () => {
    render(<Harness />); open("Posts browsing · 2 groups"); fireEvent.click(await screen.findByText("Schools · 1 subject", { selector: "summary" }));
    await screen.findByRole("textbox", { name: "Group name" });
    fireEvent.click(screen.getByRole("button", { name: "Move down, Schools" }));
    expect(JSON.parse(screen.getByTestId("draft").textContent!).groups[0].id).toBe("people");
    fireEvent.change(screen.getByRole("combobox", { name: "Move Education to group" }), { target: { value: "people" } });
    const next = JSON.parse(screen.getByTestId("draft").textContent!);
    expect(next.groups[0].terms).toEqual(config.groups[0].terms);
    expect(next.groups[1]).not.toHaveProperty("cover");
    expect(next.groups[1].terms).toEqual([]);
    await waitFor(() => expect(screen.getByLabelText("Subject 1")).toHaveFocus());
  });
  it("returns focus to an available control after removing the last subject or a group", async () => {
    render(<Harness />); open("Posts browsing · 2 groups");
    fireEvent.click(await screen.findByText("Schools · 1 subject", { selector: "summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove from group, Education" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add subject to Schools" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Remove group, Schools" }));
    await waitFor(() => expect(screen.getByText("People · 0 subjects", { selector: "summary" })).toHaveFocus());
    expect(screen.getByText("Posts browsing · 1 group", { selector: "summary" })).toBeInTheDocument();
  });
  it("keeps the newly opened group active after the prior group closes", async () => {
    render(<Harness />); open("Posts browsing · 2 groups");
    fireEvent.click(await screen.findByText("Schools · 1 subject", { selector: "summary" }));
    await screen.findByRole("textbox", { name: "Group name" });
    open("People · 0 subjects");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Group name" })).toHaveValue("People"));
  });
  it("does not save fallback groups just because an unchanged group name loses focus", async () => {
    const onChange = vi.fn();
    render(<PostsBrowseEditor disabled={false} onChange={onChange} />);
    open("Posts browsing · 6 groups");
    fireEvent.click(await screen.findByText("Elections & government · 50 subjects", { selector: "summary" }));
    const name = await screen.findByRole("textbox", { name: "Group name" });
    fireEvent.focus(name); fireEvent.blur(name);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("keeps the cover attached to its subject when staff edit its text or type", async () => {
    render(<Harness />); open("Posts browsing · 2 groups");
    fireEvent.click(await screen.findByText("Schools · 1 subject", { selector: "summary" }));
    const input = await screen.findByLabelText("Subject 1");
    fireEvent.change(input, { target: { value: "Schools" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Subject 1 type" }), { target: { value: "tag" } });
    expect(JSON.parse(screen.getByTestId("draft").textContent!).groups[0].cover).toEqual({ filter: "tag", value: "Schools" });
    expect(input).toBe(screen.getByLabelText("Subject 1"));
  });
  it("trims pasted group and subject text on save while preserving the cover", async () => {
    const values = { ...DEFAULT_SITE_NAVIGATION, postsBrowse: config };
    const save = vi.fn(async request => ({ success: true as const, changed: true, id: "site-navigation", settings: { schemaVersion: 2, version: 5, values: request.values } }));
    render(<SiteNavigationSettings load={async () => ({ success: true, found: true, id: "site-navigation", settings: { schemaVersion: 2, version: 4, values } })} loadPages={async () => []} save={save} publish={vi.fn()} />);
    open(await screen.findByText("Posts browsing · 2 groups", { selector: "summary" }).then(element => element.textContent!));
    fireEvent.click(await screen.findByText("Schools · 1 subject", { selector: "summary" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Group name" }), { target: { value: " Schools now " } });
    fireEvent.change(screen.getByLabelText("Subject 1"), { target: { value: " Education " } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].values.postsBrowse.groups[0]).toEqual({ ...config.groups[0], label: "Schools now" });
  });
  it("validates cleaned text while staff type without changing the draft or hiding real errors", async () => {
    render(<Harness />); open("Posts browsing · 2 groups");
    fireEvent.click(await screen.findByText("Schools · 1 subject", { selector: "summary" }));
    const name = await screen.findByRole("textbox", { name: "Group name" });
    const subject = screen.getByLabelText("Subject 1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    for (const label of ["Schools ", " Schools now "]) {
      fireEvent.change(name, { target: { value: label } });
      expect(name).toHaveValue(label);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
    for (const value of ["nj ", " nj transit "]) {
      fireEvent.change(subject, { target: { value } });
      expect(subject).toHaveValue(value);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(JSON.parse(screen.getByTestId("draft").textContent!).groups[0].cover.value).toBe(value);
    }

    fireEvent.change(name, { target: { value: "   " } });
    expect(screen.getByRole("alert")).toHaveTextContent("Each Posts browsing group needs a name");
    fireEvent.change(name, { target: { value: "Schools now " } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.change(subject, { target: { value: "   " } });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose an exact category or topic");
    fireEvent.change(subject, { target: { value: "nj transit " } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("preserves the Posts arrangement when saving an unrelated navigation edit", async () => {
    const values = { ...DEFAULT_SITE_NAVIGATION, postsBrowse: config };
    const save = vi.fn(async request => ({ success: true as const, changed: true, id: "site-navigation", settings: { schemaVersion: 2, version: 5, values: request.values } }));
    render(<SiteNavigationSettings load={async () => ({ success: true, found: true, id: "site-navigation", settings: { schemaVersion: 2, version: 4, values } })} loadPages={async () => []} save={save} publish={vi.fn()} />);
    fireEvent.click(within(await screen.findByRole("group", { name: "Header links" })).getByRole("button", { name: "Edit Live" }));
    const labels = await screen.findAllByRole("textbox", { name: "Label" });
    fireEvent.change(labels[0], { target: { value: "Watch live" } });
    expect(within(screen.getByRole("list", { name: "Header preview" })).getByText("Watch live")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].values.postsBrowse).toEqual(config);
    expect(save.mock.calls[0][0].values.footer).toEqual(DEFAULT_SITE_NAVIGATION.footer);
    expect(save.mock.calls[0][0].baseVersion).toBe(4);
  });
});
