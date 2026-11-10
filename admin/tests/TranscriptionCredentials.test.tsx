import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionCredentials } from "../src/components/TranscriptionCredentials";
import { postFunction } from "../src/lib/functions";
import type { Principal } from "../../packages/content-core/src/rbac";

vi.mock("../src/lib/functions", () => ({ postFunction: vi.fn() }));
const getIdToken = vi.fn().mockResolvedValue("synthetic-token");
const principal = { id: "fixture-user", grants: [{ role: "editor" }] } as Principal;
const saved = { id: "fixture-record", scope: "personal", provider: "elevenlabs", revision: 3, configured: true, verification: "unverified", updatedAt: "2026-09-15T12:00:00Z" };
const syntheticKey = "synthetic-test-key-only";
beforeEach(() => { vi.mocked(postFunction).mockReset(); getIdToken.mockClear(); });
afterEach(cleanup);
async function ready() { await waitFor(() => expect(screen.queryAllByText("Loading key status.")).toHaveLength(0)); }

describe("transcription credentials", () => {
  it("shows station controls only with global settings access and resets entries on account change", async () => {
    vi.mocked(postFunction).mockResolvedValue({ success: true, credentials: [] });
    const view = render(<TranscriptionCredentials principal={{ id: "scoped", grants: [{ role: "admin", sections: ["news"] }] }} getIdToken={getIdToken} />);
    await ready();
    expect(screen.queryByRole("form", { name: "Station default key" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("ElevenLabs API key"), { target: { value: syntheticKey } });
    view.rerender(<TranscriptionCredentials principal={{ id: "global", grants: [{ role: "admin" }] }} getIdToken={getIdToken} />);
    await ready();
    expect(screen.getByRole("form", { name: "Station default key" })).toBeInTheDocument();
    for (const field of screen.getAllByLabelText("ElevenLabs API key")) expect(field).toHaveValue("");
    expect(vi.mocked(postFunction).mock.calls.map(call => call[2])).toContainEqual({ scope: "organization", provider: "elevenlabs" });
  });
  it("clears the key before authentication, saves against the loaded revision, and reports only unverified status", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(postFunction).mockImplementation(async endpoint => endpoint === "cmsSaveTranscriptionCredential" ? new Promise(resolve => { finish = resolve; }) : { success: true, credentials: [saved] });
    const onBusyChange = vi.fn();
    render(<TranscriptionCredentials principal={principal} getIdToken={getIdToken} onBusyChange={onBusyChange} />);
    await ready();
    const input = screen.getByLabelText("ElevenLabs API key");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: syntheticKey } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Replace key" })); });
    expect(input).toHaveValue("");
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(vi.mocked(postFunction).mock.lastCall).toEqual(["cmsSaveTranscriptionCredential", "synthetic-token", { scope: "personal", provider: "elevenlabs", expectedRevision: 3, key: syntheticKey }, {}, { appCheck: true }]);
    expect(screen.queryByText(syntheticKey)).not.toBeInTheDocument();
    await act(async () => { finish({ success: true, credential: { ...saved, revision: 4 } }); });
    expect(screen.getByText("Key saved. It has not been verified.")).toBeInTheDocument();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });
  it("requires a status reload after conflict and never renders error details or retains the submitted key", async () => {
    vi.mocked(postFunction).mockImplementation(async endpoint => {
      if (endpoint === "cmsSaveTranscriptionCredential") throw Object.assign(new Error(syntheticKey), { status: 409 });
      return { success: true, credentials: [saved] };
    });
    render(<TranscriptionCredentials principal={principal} getIdToken={getIdToken} />);
    await ready();
    fireEvent.change(screen.getByLabelText("ElevenLabs API key"), { target: { value: syntheticKey } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Replace key" })); });
    expect(screen.getByLabelText("ElevenLabs API key")).toHaveValue("");
    expect(screen.getByLabelText("ElevenLabs API key")).toBeDisabled();
    expect(screen.queryByText(syntheticKey)).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload key status" })); });
    await ready();
    expect(screen.getByLabelText("ElevenLabs API key")).toBeEnabled();
  });
  it("confirms disconnect and uses the station record revision without submitting a key", async () => {
    const station = { ...saved, scope: "organization", revision: 7 };
    vi.mocked(postFunction).mockImplementation(async (endpoint, _token, body) => endpoint === "cmsDisconnectTranscriptionCredential" ? { success: true, credential: { ...station, revision: 8, configured: false } } : { success: true, credentials: (body as { scope: string }).scope === "organization" ? [station] : [] });
    render(<TranscriptionCredentials principal={{ id: "admin", grants: [{ role: "admin" }] }} getIdToken={getIdToken} />);
    await ready();
    const form = within(screen.getByRole("form", { name: "Station default key" }));
    fireEvent.click(form.getByRole("button", { name: "Disconnect key" }));
    expect(vi.mocked(postFunction).mock.calls.some(call => call[0] === "cmsDisconnectTranscriptionCredential")).toBe(false);
    await act(async () => { fireEvent.click(form.getByRole("button", { name: "Confirm disconnect" })); });
    expect(vi.mocked(postFunction).mock.lastCall?.[2]).toEqual({ scope: "organization", provider: "elevenlabs", expectedRevision: 7 });
    expect(form.getByText("Not configured")).toBeInTheDocument();
  });
});

it("does not send a key if the form unmounts while authentication is pending", async () => {
  vi.mocked(postFunction).mockResolvedValue({ success: true, credentials: [] });
  const view = render(<TranscriptionCredentials principal={principal} getIdToken={getIdToken} />);
  await ready();
  let finishAuth!: (token: string) => void;
  getIdToken.mockImplementationOnce(() => new Promise(resolve => { finishAuth = resolve; }));
  fireEvent.change(screen.getByLabelText("ElevenLabs API key"), { target: { value: syntheticKey } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save key" })); });
  expect(screen.getByLabelText("ElevenLabs API key")).toHaveValue("");
  view.unmount();
  await act(async () => { finishAuth("new-session-token"); });
  expect(vi.mocked(postFunction).mock.calls.some(call => call[0] === "cmsSaveTranscriptionCredential")).toBe(false);
});
