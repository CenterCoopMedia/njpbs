import { Suspense, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { deferEditor } from "../src/components/DeferredEditor";
afterEach(cleanup);

it("keeps the document draft mounted through a rejected secondary chunk and retries the real loader", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const load = vi.fn<() => Promise<(props: { value: string }) => React.ReactNode>>()
    .mockRejectedValueOnce(new Error("chunk unavailable"))
    .mockResolvedValueOnce(({ value }) => <p>Outline for {value}</p>);
  const { Editor } = deferEditor(load, "Outline");
  function Document() {
    const [title, setTitle] = useState("Saved title");
    return <><input aria-label="Document title" value={title} onChange={event => setTitle(event.target.value)} /><Editor value={title} /></>;
  }
  try {
    render(<Document />);
    const title = screen.getByRole("textbox", { name: "Document title" });
    fireEvent.change(title, { target: { value: "Unsaved title" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Your document is still open");
    expect(screen.getByRole("textbox", { name: "Document title" })).toBe(title);
    expect(title).toHaveValue("Unsaved title");
    fireEvent.click(screen.getByRole("button", { name: "Retry outline" }));
    expect(await screen.findByText("Outline for Unsaved title")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Document title" })).toBe(title);
    expect(load).toHaveBeenCalledTimes(2);
  } finally { errors.mockRestore(); }
});

it("retries an idle warm-up failure on first deliberate use without showing a stale error", async () => {
  const load = vi.fn<() => Promise<() => React.ReactNode>>()
    .mockRejectedValueOnce(new Error('Idle network interruption'))
    .mockResolvedValueOnce(() => <p>Ready after idle failure</p>);
  const { Editor, preload } = deferEditor(load, 'Content details');
  await act(async () => { await preload(); });
  render(<Editor />);
  expect(await screen.findByText('Ready after idle failure')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
});

it("contains a preload rejection when the editor has deliberately joined its pending request", async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let reject!: (error: Error) => void;
  const load = vi.fn(() => new Promise<() => React.ReactNode>((_resolve, fail) => { reject = fail; }));
  const { Editor, preload } = deferEditor(load, 'Outline');
  const pending = preload();
  try {
    await act(async () => { render(<Editor />); });
    await act(async () => { reject(new Error('Active request failed')); await pending; });
    expect(await screen.findByRole('alert')).toHaveTextContent('Your document is still open');
    expect(load).toHaveBeenCalledOnce();
  } finally { errors.mockRestore(); }
});

it("shares successful preloading with the first editor paint without another request", async () => {
  const load = vi.fn(async () => () => <p>Ready secondary fields</p>);
  const { Editor, preload } = deferEditor(load, "Content details");
  await act(async () => { await preload(); });
  render(<Suspense fallback={<p>Outer loading</p>}><Editor /></Suspense>);
  expect(screen.getByText("Ready secondary fields")).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("Outer loading")).toBeNull();
  expect(load).toHaveBeenCalledOnce();
});
