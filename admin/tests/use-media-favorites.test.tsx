import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFavoriteButton } from "../src/components/MediaFavoriteButton";
import type { MediaFavoriteRef } from "../src/lib/media-favorites";
import { useMediaFavorites } from "../src/lib/use-media-favorites";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../src/lib/media-favorites", () => ({
  listMediaFavoriteStates: (...args: unknown[]) => mocks.list(...args),
  setMediaFavorite: (...args: unknown[]) => mocks.set(...args),
}));

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const defaultToken = async () => "test-token";

function Harness({
  userId,
  refs,
  getIdToken = defaultToken,
  seed,
  awaiting,
}: {
  userId: string;
  refs: MediaFavoriteRef[];
  getIdToken?: () => Promise<string>;
  seed?: { states?: { ref: MediaFavoriteRef; favorite: boolean }[] };
  awaiting?: { current: boolean };
}) {
  const favorites = useMediaFavorites(userId, refs, getIdToken, seed, awaiting);
  return <>
    {refs.map(ref => <MediaFavoriteButton
      key={JSON.stringify(ref)}
      name={ref.id}
      favorite={favorites.value(ref)}
      pending={favorites.pending(ref)}
      onToggle={() => void favorites.toggle(ref)} />)}
    <button disabled={favorites.retryDisabled} onClick={favorites.retry}>Retry favorites</button>
    {favorites.loadError || favorites.saveError ? <p role="alert">{favorites.loadError || favorites.saveError}</p> : null}
  </>;
}

const r2: MediaFavoriteRef = { backend: "r2", id: "same-id" };
const s3: MediaFavoriteRef = { backend: "s3", sourceId: "archive", id: "same-id" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockImplementation(async (_token: string, refs: MediaFavoriteRef[]) => ({
    success: true,
    states: refs.map(ref => ({ ref, favorite: false })),
  }));
});

describe("useMediaFavorites", () => {
  it("loads one source-aware projection for a visible page", async () => {
    const { rerender } = render(<Harness userId="user-a" refs={[r2, s3]} />);

    expect(await screen.findAllByRole("button", { name: "Add to favorites: same-id" })).toHaveLength(2);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith("test-token", [r2, s3]);

    rerender(<Harness userId="user-a" refs={[{ ...r2 }, { ...s3 }]} />);
    await act(async () => undefined);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("blocks a retry during a write and reconciles after confirmation", async () => {
    const save = deferred<{ success: true; ref: MediaFavoriteRef; favorite: false; changed: true }>();
    mocks.set.mockReturnValueOnce(save.promise);
    render(<Harness userId="user-a" refs={[{ ...r2, id: "asset-one" }]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add to favorites: asset-one" }));
    expect(screen.getByRole("button", { name: "Saving favorite: asset-one" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Retry favorites" })).toBeDisabled();
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await act(async () => save.resolve({
      success: true,
      ref: { backend: "r2", id: "wrong-asset" },
      favorite: false,
      changed: true,
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Add to favorites: asset-one" })).toBeEnabled();
  });

  it("keeps focus and the confirmed state without reloading the page", async () => {
    const save = deferred<{ success: true; ref: MediaFavoriteRef; favorite: true; changed: true }>();
    mocks.set.mockReturnValueOnce(save.promise);
    render(<Harness userId="user-a" refs={[r2]} />);

    const button = await screen.findByRole("button", { name: "Add to favorites: same-id" });
    button.focus();
    fireEvent.click(button);
    const pending = screen.getByRole("button", { name: "Saving favorite: same-id" });
    expect(pending).toHaveFocus();
    expect(pending).toHaveAttribute("aria-disabled", "true");

    await act(async () => save.resolve({ success: true, ref: r2, favorite: true, changed: true }));

    expect(screen.getByRole("button", { name: "Remove from favorites: same-id" })).toHaveFocus();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("keeps the last known state when reconciliation fails", async () => {
    mocks.set.mockRejectedValueOnce(new Error("Response lost"));
    mocks.list
      .mockResolvedValueOnce({ success: true, states: [{ ref: r2, favorite: false }] })
      .mockRejectedValueOnce(new Error("Offline"));
    render(<Harness userId="user-a" refs={[r2]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add to favorites: same-id" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Favorites could not be loaded");
    expect(screen.getByRole("button", { name: "Add to favorites: same-id" })).toBeEnabled();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("does not let an older reconciliation overwrite a later confirmed write", async () => {
    const staleRead = deferred<{ success: true; states: { ref: MediaFavoriteRef; favorite: boolean }[] }>();
    mocks.list
      .mockResolvedValueOnce({ success: true, states: [{ ref: r2, favorite: false }, { ref: s3, favorite: false }] })
      .mockReturnValueOnce(staleRead.promise);
    mocks.set
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValueOnce({ success: true, ref: s3, favorite: true, changed: true });
    render(<Harness userId="user-a" refs={[r2, s3]} />);

    const [r2Button, s3Button] = await screen.findAllByRole("button", { name: "Add to favorites: same-id" });
    fireEvent.click(r2Button);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    fireEvent.click(s3Button);
    expect(await screen.findByRole("button", { name: "Remove from favorites: same-id" })).toBeEnabled();

    await act(async () => staleRead.resolve({
      success: true,
      states: [{ ref: r2, favorite: false }, { ref: s3, favorite: false }],
    }));
    expect(screen.getByRole("button", { name: "Remove from favorites: same-id" })).toBeEnabled();
  });

  it("reconciles the visible page when a write completes after the page changes", async () => {
    const save = deferred<{ success: true; ref: MediaFavoriteRef; favorite: true; changed: true }>();
    mocks.set.mockReturnValueOnce(save.promise);
    const view = render(<Harness userId="user-a" refs={[r2]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to favorites: same-id" }));

    view.rerender(<Harness userId="user-a" refs={[s3]} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await act(async () => save.resolve({ success: true, ref: r2, favorite: true, changed: true }));

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: "Add to favorites: same-id" })).toBeEnabled();
  });

  it("does not apply a completed write to a different signed-in account", async () => {
    const save = deferred<{ success: true; ref: MediaFavoriteRef; favorite: true; changed: true }>();
    mocks.set.mockReturnValueOnce(save.promise);
    const { rerender } = render(<Harness userId="user-a" refs={[r2]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to favorites: same-id" }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith("test-token", r2, true));

    rerender(<Harness userId="user-b" refs={[r2]} />);
    expect(await screen.findByRole("button", { name: "Add to favorites: same-id" })).toBeEnabled();
    await act(async () => save.resolve({ success: true, ref: r2, favorite: true, changed: true }));

    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Add to favorites: same-id" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Remove from favorites: same-id" })).toBeNull();
  });

  it("does not send an old account write if token lookup settles after a switch", async () => {
    const token = deferred<string>();
    const getIdToken = vi.fn()
      .mockResolvedValueOnce("initial-token")
      .mockReturnValueOnce(token.promise);
    const { rerender } = render(<Harness userId="user-a" refs={[r2]} getIdToken={getIdToken} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to favorites: same-id" }));
    expect(screen.getByRole("button", { name: "Saving favorite: same-id" })).toHaveAttribute("aria-busy", "true");
    rerender(<Harness userId="user-b" refs={[r2]} getIdToken={async () => "user-b-token"} />);
    await act(async () => token.resolve("user-a-token"));

    expect(mocks.set).not.toHaveBeenCalledWith("user-a-token", r2, true);
    expect(await screen.findByRole("button", { name: "Add to favorites: same-id" })).toBeEnabled();
  });

  it("uses a matching list seed once instead of a lookup, and looks up when it does not match", async () => {
    const seed = { states: [{ ref: r2, favorite: true }] };
    const view = render(<Harness userId="staff" refs={[r2]} seed={seed} />);
    expect(await screen.findByRole("button", { name: /Remove .*from favorites|Remove from favorites/ })).toBeInTheDocument();
    expect(mocks.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry favorites" }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    view.rerender(<Harness userId="staff" refs={[r2, s3]} seed={seed} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });

  it("waits for an in-flight seeded list load, then looks up only if it brought no states", async () => {
    const awaiting = { current: true };
    const view = render(<Harness userId="staff" refs={[r2]} awaiting={awaiting} />);
    await act(async () => {});
    expect(mocks.list).not.toHaveBeenCalled();
    awaiting.current = false;
    view.rerender(<Harness userId="staff" refs={[r2]} awaiting={awaiting} seed={{}} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
  });
});
