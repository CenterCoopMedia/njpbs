import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VoiceoverListenButton,
  VoiceoverPlayer,
  type VoiceoverPlayerProps,
} from "../src/components/VoiceoverPlayer";

function props(overrides: Partial<VoiceoverPlayerProps> = {}): VoiceoverPlayerProps {
  return {
    takeLabel: "Watching NJ PBS, warm, take 1",
    loaded: false,
    loading: false,
    peaks: null,
    durationSeconds: 125,
    onListen: vi.fn(),
    registerAudio: vi.fn(),
    onEnded: vi.fn(),
    onPlay: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VoiceoverPlayer", () => {
  it("keeps an idle listen control free of media elements", () => {
    const onListen = vi.fn();
    render(
      <VoiceoverListenButton
        durationSeconds={2.1}
        onListen={onListen}
        takeLabel="Watching NJ PBS, warm, take 1"
      />,
    );

    expect(screen.getByRole("button", { name: "Listen" })).toHaveAttribute("type", "button");
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(document.querySelector("audio")).toBeNull();
    expect(screen.getByLabelText("Watching NJ PBS, warm, take 1 playback time")).toHaveTextContent("0:02");
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    expect(onListen).toHaveBeenCalledOnce();
  });

  it("registers its uneager audio element and asks its owner to load playback", () => {
    const playerProps = props();
    const view = render(<VoiceoverPlayer {...playerProps} />);
    const audio = screen.getByLabelText(playerProps.takeLabel);
    const seek = screen.getByRole("slider", {
      name: `${playerProps.takeLabel} playback position`,
    });

    expect(audio).toHaveAttribute("preload", "none");
    expect(audio).not.toHaveAttribute("controls");
    expect(playerProps.registerAudio).toHaveBeenCalledWith(audio);
    expect(seek).toBeDisabled();
    expect(screen.getByLabelText(`${playerProps.takeLabel} playback time`)).toHaveTextContent(
      "2:05",
    );
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    expect(playerProps.onListen).toHaveBeenCalledOnce();

    view.unmount();
    expect(playerProps.registerAudio).toHaveBeenLastCalledWith(null);
  });

  it("tracks media events, pauses the current element, and forwards owner events", () => {
    const playerProps = props({ loaded: true, peaks: [0.25, 1, 0.5] });
    const { container } = render(<VoiceoverPlayer {...playerProps} />);
    const audio = screen.getByLabelText(playerProps.takeLabel) as HTMLAudioElement;
    Object.defineProperty(audio, "duration", { configurable: true, value: 125 });
    audio.currentTime = 65;

    fireEvent.loadedMetadata(audio);
    expect(screen.getByLabelText(`${playerProps.takeLabel} playback time`)).toHaveTextContent(
      "1:05",
    );
    expect(container.querySelector(".voiceover-player-waveform")).toBeInTheDocument();

    fireEvent.play(audio);
    expect(playerProps.onPlay).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();

    fireEvent.pause(audio);
    expect(screen.getByRole("button", { name: "Listen" })).toBeInTheDocument();
    fireEvent.error(audio);
    expect(playerProps.onError).toHaveBeenCalledOnce();
    fireEvent.ended(audio);
    expect(playerProps.onEnded).toHaveBeenCalledOnce();
  });

  it("uses the decoded media duration for its native seek control", () => {
    const playerProps = props({ loaded: true });
    render(<VoiceoverPlayer {...playerProps} />);
    const audio = screen.getByLabelText(playerProps.takeLabel) as HTMLAudioElement;
    Object.defineProperty(audio, "duration", { configurable: true, value: 10.5 });
    fireEvent.loadedMetadata(audio);
    const seek = screen.getByRole("slider", {
      name: `${playerProps.takeLabel} playback position`,
    });

    expect(seek).toBeEnabled();
    expect(seek).toHaveAttribute("max", "10.5");
    fireEvent.change(seek, { target: { value: "4.25" } });
    expect(audio.currentTime).toBe(4.25);
    expect(seek).toHaveValue("4.25");
    expect(seek).toHaveAttribute("aria-valuetext", "0:04 of 0:10");
    expect(screen.getByLabelText(`${playerProps.takeLabel} playback time`)).toHaveTextContent(
      "0:04",
    );
  });

  it("shows an honest empty track while real peaks are unavailable", () => {
    const { container } = render(<VoiceoverPlayer {...props({ loaded: true })} />);
    expect(container.querySelector(".voiceover-player-track")).toBeInTheDocument();
    expect(container.querySelector(".voiceover-player-waveform")).not.toBeInTheDocument();
  });
});
