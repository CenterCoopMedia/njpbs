import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {AudioCardPlayback, AudioPlayback} from "../src/components/media/AudioMedia";
import type {MediaAssetSummary} from "../src/lib/functions";
const mocks=vi.hoisted(() => ({audio:vi.fn()}));
const asset:MediaAssetSummary={id:"voiceover-station-01",name:"Station identification",originalName:"station-01.wav",kind:"audio",mimeType:"audio/wav",source:"voiceover",sizeBytes:48,width:null,height:null,
  url:"https://admin.njpbs.org/media/voiceovers?asset=voiceover-station-01",category:"news",categories:["news"],tags:[],description:null,altText:null,license:null,credit:null,
  lifecycle:"active",version:1,etag:'"media.fixture.1"',createdAt:null,createdBy:null,updatedAt:null,updatedBy:null};
const getIdToken=vi.fn(async () => "staff-token");
beforeEach(() => {
  mocks.audio.mockReset();getIdToken.mockClear();vi.stubGlobal("fetch",mocks.audio);
  vi.stubGlobal("URL",class extends URL {static createObjectURL=vi.fn(() => "blob:private-audio");static revokeObjectURL=vi.fn();});
  vi.spyOn(HTMLMediaElement.prototype,"play").mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("play")); return Promise.resolve(); });
  vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("pause")); });
  vi.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(() => undefined);
});
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("Audio media playback",() => {
  it("loads a private card only on Listen and offers Pause when playback starts", async () => {
    mocks.audio.mockResolvedValue(new Response(new Uint8Array(48),{headers:{"content-type":"audio/wav","content-length":"48"}}));
    const { container } = render(<AudioCardPlayback asset={asset} getIdToken={getIdToken} />);
    expect(screen.getByRole("button", { name: `Listen to ${asset.name}` })).toHaveTextContent("Listen");
    expect(mocks.audio).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `Listen to ${asset.name}` }));
    await waitFor(() => expect(container.querySelector("audio")).toHaveAttribute("src", "blob:private-audio"));
    fireEvent.play(container.querySelector("audio")!);
    expect(screen.getByRole("button", { name: `Pause ${asset.name}` })).toHaveTextContent("Pause");
    fireEvent.click(screen.getByRole("button", { name: `Pause ${asset.name}` }));
    expect(screen.getByRole("button", { name: `Listen to ${asset.name}` })).toBeVisible();
  });

  it.each(["voiceover", "upload"] as const)("shows a playback rejection and permits retry for %s cards", async (source) => {
    mocks.audio.mockResolvedValue(new Response(new Uint8Array(48), { headers: { "content-type": "audio/wav", "content-length": "48" } }));
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException("Playback refused", "NotAllowedError"));
    render(<AudioCardPlayback asset={{ ...asset, source }} getIdToken={getIdToken} />);
    fireEvent.click(screen.getByRole("button", { name: `Listen to ${asset.name}` }));
    expect(await screen.findByText("Audio could not be played")).toBeVisible();
    expect(screen.getByText("Choose Listen to try again.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: `Listen to ${asset.name}` }));
    await waitFor(() => expect(screen.queryByText("Audio could not be played")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: `Pause ${asset.name}` })).toBeVisible();
    if (source === "upload") expect(mocks.audio).not.toHaveBeenCalled();
  });

  it("shows a media error for uploaded audio and recovers after retry", async () => {
    const { container } = render(<AudioCardPlayback asset={{ ...asset, source: "upload" }} />);
    const audio = container.querySelector("audio")!;
    fireEvent.play(audio);
    expect(screen.getByRole("button", { name: `Pause ${asset.name}` })).toBeVisible();
    fireEvent.error(audio);
    expect(screen.getByText("Audio could not be played")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: `Listen to ${asset.name}` }));
    await waitFor(() => expect(screen.queryByText("Audio could not be played")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: `Pause ${asset.name}` })).toBeVisible();
    expect(mocks.audio).not.toHaveBeenCalled();
  });

  it("resets playback state when the card changes to another asset", () => {
    const view = render(<AudioCardPlayback asset={{ ...asset, source: "upload" }} />);
    fireEvent.play(view.container.querySelector("audio")!);
    const nextAsset = { ...asset, id: "next-audio", name: "Next recording", source: "upload" as const };
    view.rerender(<AudioCardPlayback asset={nextAsset} />);
    expect(screen.getByRole("button", { name: "Listen to Next recording" })).toBeVisible();
    fireEvent.error(view.container.querySelector("audio")!);
    expect(screen.getByText("Audio could not be played")).toBeVisible();
    view.rerender(<AudioCardPlayback asset={{ ...asset, source: "upload" }} />);
    expect(screen.queryByText("Audio could not be played")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Listen to ${asset.name}` })).toBeVisible();
  });

  it("fetches private bytes only after Listen and revokes them when details close",async () => {
    mocks.audio.mockResolvedValue(new Response(new Uint8Array(48),{headers:{"content-type":"audio/wav","content-length":"48"}}));
    const view=render(<AudioPlayback asset={asset} getIdToken={getIdToken}/>);
    expect(mocks.audio).not.toHaveBeenCalled();expect(screen.queryByLabelText(`Play ${asset.name}`)).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name:`Listen to ${asset.name}`})).toHaveTextContent("Listen");
    fireEvent.click(screen.getByRole("button",{name:`Listen to ${asset.name}`}));
    expect(await screen.findByLabelText(`Play ${asset.name}`)).toHaveAttribute("src","blob:private-audio");
    expect(screen.getByLabelText(`Play ${asset.name}`)).toHaveAttribute("preload","none");
    expect(mocks.audio).toHaveBeenCalledWith(expect.stringMatching(/cmsGetVoiceoverAudio$/),expect.objectContaining({method:"POST",body:JSON.stringify({schemaVersion:1,assetId:asset.id}),signal:expect.any(AbortSignal),headers:expect.objectContaining({Authorization:"Bearer staff-token"})}));
    view.unmount();expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:private-audio");
  });
  it("rejects incomplete private responses and permits an explicit retry",async () => {
    mocks.audio.mockResolvedValueOnce(new Response(new Uint8Array(12),{headers:{"content-type":"audio/wav","content-length":"48"}}));
    render(<AudioPlayback asset={asset} getIdToken={getIdToken}/>);
    fireEvent.click(screen.getByRole("button",{name:`Listen to ${asset.name}`}));
    expect(await screen.findByText("The audio response is incomplete.")).toBeVisible();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    mocks.audio.mockResolvedValueOnce(new Response(new Uint8Array(48),{headers:{"content-type":"audio/wav","content-length":"48"}}));
    fireEvent.click(screen.getByRole("button",{name:`Listen to ${asset.name}`}));
    await waitFor(() => expect(screen.getByLabelText(`Play ${asset.name}`)).toHaveAttribute("src","blob:private-audio"));
  });
  it("uses native lazy playback for staff uploads without a private API request",() => {
    render(<AudioPlayback asset={{...asset,source:"upload",url:"https://media.example.test/interview.wav"}} getIdToken={getIdToken}/>);
    expect(screen.getByLabelText(`Play ${asset.name}`)).toHaveAttribute("preload","none");
    expect(screen.getByLabelText(`Play ${asset.name}`)).toHaveAttribute("src","https://media.example.test/interview.wav");
    expect(mocks.audio).not.toHaveBeenCalled();expect(getIdToken).not.toHaveBeenCalled();
  });
});
