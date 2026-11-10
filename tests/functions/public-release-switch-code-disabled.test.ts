import { expect, it } from "vitest";
import { createPublicReleaseSwitchCodeContinuation } from "../../site/scripts/public-release-switch-code-continuation";
import { bindPublicReleaseSwitchCodeContinuation } from "../../site/scripts/public-release-switch-code-binding";
it.each([undefined, false, "true", 1])("touches no SDK/storage/source dependency without literal CODE enablement (%s)", enabled => {
  const options = new Proxy({ enabled }, { get(target, key) {
    if (key === "enabled") return target.enabled;
    throw new Error("Disabled CODE accessed a private dependency");
  } });
  expect(createPublicReleaseSwitchCodeContinuation(options as any)).toEqual({});
});
it("preserves the exact original executor with its existing preview and publication hooks when CODE is absent", () => {
  const executor = { beforePoll: Symbol("original-preview"), stage: Symbol("original-publication"), recover: Symbol("existing-recovery") };
  expect(bindPublicReleaseSwitchCodeContinuation({ executor: executor as any, continuation: {} })).toBe(executor);
});
