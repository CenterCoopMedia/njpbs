import { expect, it, vi } from "vitest";
import VisualProgressReporter from "./visual-progress-reporter";

it("records the active visual phase before it completes without exposing step arguments or errors", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const reporter = new VisualProgressReporter();
  const test = { location: { file: "/private/checkout/gallery.spec.ts", line: 17, column: 1 } };
  const browser = { category: "fixture", title: 'Fixture "browser"' };
  const setup = { category: "hook", title: "Before Hooks" };
  try {
    reporter.onConfigure();
    reporter.onBegin(undefined, { allTests: () => [] });
    reporter.onBegin(undefined, { allTests: () => [test] });
    reporter.onTestBegin(test);
    reporter.onStepBegin(test, undefined, setup);
    reporter.onStepBegin(test, undefined, browser);

    expect(output.mock.calls.map(([line]) => line)).toEqual([
      "Admin visual progress Runner configured",
      "Admin visual progress Suite ready",
      "Admin visual progress gallery.spec.ts:17 Test started",
      "Admin visual progress gallery.spec.ts:17 Before hooks started",
      "Admin visual progress gallery.spec.ts:17 Browser fixture started",
    ]);

    reporter.onStepBegin(test, undefined, { category: "pw:api", title: "Fixture-only URL and arguments" });
    reporter.onStepEnd(test, undefined, { ...browser, error: { message: "Fixture-only error details" } });
    expect(output.mock.calls).toHaveLength(6);
    expect(output).toHaveBeenLastCalledWith("Admin visual progress gallery.spec.ts:17 Browser fixture failed");
  } finally {
    output.mockRestore();
  }
});
