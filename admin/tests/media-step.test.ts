import { afterEach, describe, expect, it } from "vitest";
import { viewerKeyAction, type ViewerKeyEvent } from "../src/lib/media-step";

function key(key: string, target: Element | null = document.body, extra: Partial<ViewerKeyEvent> = {}): ViewerKeyEvent {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, target, ...extra };
}

afterEach(() => { document.body.innerHTML = ""; });

describe("viewer stepping", () => {
  it("does nothing from a text field, a video element, its controls or the transcript", () => {
    document.body.innerHTML = `
      <input id="text" />
      <textarea id="area"></textarea>
      <select id="choice"><option>One</option></select>
      <div id="editable" contenteditable="true"><span id="inside">x</span></div>
      <video id="video" controls></video>
      <audio id="audio" controls></audio>
      <section data-viewer-keys="off"><button id="line">00:01 Hello</button></section>`;
    for (const id of ["text", "area", "choice", "inside", "video", "audio", "line"]) {
      const target = document.getElementById(id);
      for (const name of ["ArrowLeft", "ArrowRight", "Escape"]) expect(viewerKeyAction(key(name, target)), `${id} ${name}`).toBe("none");
      expect(viewerKeyAction(key("y", target, { metaKey: true })), id).toBe("none");
    }
  });
});
