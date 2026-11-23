import { basename } from "node:path";
import type { Reporter, TestCase, TestStep } from "@playwright/test/reporter";

const phases = new Map([
  ['fixture:Fixture "browser"', "Browser fixture"],
  ["hook:Before Hooks", "Before hooks"],
  ["hook:After Hooks", "After hooks"],
  ["hook:Worker Cleanup", "Worker cleanup"],
]);

type TestLocation = Pick<TestCase, "location">;
type StepPhase = Pick<TestStep, "category" | "title">;

function logProgress(message: string, test?: TestLocation) {
  const location = test ? ` ${basename(test.location.file)}:${test.location.line}` : "";
  console.log(`Admin visual progress${location} ${message}`);
}

export default class VisualProgressReporter implements Reporter {
  onConfigure() {
    logProgress("Runner configured");
  }

  onBegin(_config: unknown, suite: { allTests(): readonly unknown[] }) {
    // Playwright also calls this with an empty suite after a setup failure.
    if (suite.allTests().length > 0) logProgress("Suite ready");
  }

  onTestBegin(test: TestLocation) {
    logProgress("Test started", test);
  }

  onStepBegin(test: TestLocation, _result: unknown, step: StepPhase) {
    const phase = phases.get(`${step.category}:${step.title}`);
    if (phase) logProgress(`${phase} started`, test);
  }

  onStepEnd(test: TestLocation, _result: unknown, step: StepPhase & Pick<TestStep, "error">) {
    const phase = phases.get(`${step.category}:${step.title}`);
    if (phase) logProgress(`${phase} ${step.error ? "failed" : "finished"}`, test);
  }
}
