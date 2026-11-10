import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { createModalDialog } from "../src/lib/dialog";
import { populateProgramDialog } from "../src/lib/native-schedule-dom";

const source = readFileSync(join(process.cwd(), "src", "components", "NativeSchedule.astro"), "utf8");
const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function runScheduleScript(): void {
  expect(script).toBeDefined();
  const compiled = ts
    .transpileModule(script!, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    })
    .outputText.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];\s*/g, "");
  const dependencies = {
    activateInitialScheduleState: () => true,
    activateScheduleDay: () => false,
    clearScheduleSearch: () => false,
    getScheduleScrollBehavior: () => "auto",
    populateProgramDialog,
    resolveJumpToNowTarget: () => null,
    resolvePrimetimeTarget: () => null,
    resolveScheduleToolbarSticky: () => false,
    updateScheduleDateGridVisibility: () => false,
    updateScheduleSearch: () => false,
    updateScheduleNowLine: () => false,
    createModalDialog,
    millisecondsToNextMinute: () => 60_000,
    resolveNowNextClock: () => ({ fixed: true, at: new Date() }),
  };
  new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
}

function mountScheduleDialog(): {
  button: HTMLButtonElement;
  close: HTMLButtonElement;
  dialog: HTMLDialogElement;
  outside: HTMLButtonElement;
  title: HTMLElement;
} {
  document.body.innerHTML = `
    <button type="button" data-schedule-outside>Outside</button>
    <section data-native-schedule>
      <button
        type="button"
        data-program-details
        data-program-title="Nature"
        data-program-episode="Wild hope"
        data-program-time="8:00–9:00 p.m. ET"
        data-program-meta="60 min · HD · CC"
        data-program-description="A wildlife story."
      >Details</button>
      <dialog data-program-dialog aria-labelledby="schedule-dialog-title">
        <h2 id="schedule-dialog-title" tabindex="-1" data-program-dialog-title>Program details</h2>
        <button type="button" data-dialog-close>Close</button>
        <p data-program-dialog-episode></p>
        <p data-program-dialog-time></p>
        <p data-program-dialog-meta></p>
        <p data-program-dialog-episode-description hidden>
          <span data-program-dialog-episode-description-text></span>
        </p>
        <p data-program-dialog-description></p>
      </dialog>
    </section>
  `;
  return {
    button: document.querySelector<HTMLButtonElement>("[data-program-details]")!,
    close: document.querySelector<HTMLButtonElement>("[data-dialog-close]")!,
    dialog: document.querySelector<HTMLDialogElement>("[data-program-dialog]")!,
    outside: document.querySelector<HTMLButtonElement>("[data-schedule-outside]")!,
    title: document.querySelector<HTMLElement>("[data-program-dialog-title]")!,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("native schedule dialog", () => {
  it("opens and dismisses the shipped program dialog with focus returned to its row", () => {
    const { button, close, dialog, outside, title } = mountScheduleDialog();
    runScheduleScript();

    outside.focus();
    expect(document.activeElement).toBe(outside);
    button.click();
    expect(dialog.open).toBe(true);
    expect(title.textContent).toBe("Nature");
    expect(document.activeElement).toBe(title);

    close.click();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(button);

    outside.focus();
    button.click();
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(title);
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(button);

    outside.focus();
    button.click();
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(title);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(button);
  });
});
