import { describe, expect, it } from "vitest";
import {
  HARDWARE_MACHINE_IDS,
  hardwareMonthlyCents,
  validateHardwareInput,
  validateHardwareMachine,
} from "../../packages/content-core/src/cost-hardware";
import generated from "../../functions/lib/cost-hardware.js";
import service from "../../functions/lib/cost-ledger.js";

const blank = {
  purchaseCents: null,
  lifeMonths: null,
  watts: null,
  hoursPerMonth: null,
  centsPerKwh: null,
  internetShareCents: null,
};
const fleet = (patch) => ({
  machines: [
    "node-services",
    "node-compute",
    "node-gpu-a",
    "node-gpu-b",
    "node-offsite",
  ].map((id, index) => ({
    id,
    label: id,
    ...blank,
    ...(index === 0 ? patch : {}),
  })),
});

describe("shared hardware assumptions contract", () => {
  it("keeps both validator fleet lists identical to the service seed fleet", () => {
    const seededIds = service.SEED_MACHINES.map((machine) => machine.id);
    expect(HARDWARE_MACHINE_IDS).toEqual(seededIds);
    expect(generated.HARDWARE_MACHINE_IDS).toEqual(seededIds);
  });
  it.each([
    [blank, null],
    [{ purchaseCents: 120000, lifeMonths: 48 }, 2500],
    [{ watts: 100, hoursPerMonth: 100, centsPerKwh: 20 }, 200],
    [{ internetShareCents: 1234 }, 1234],
    [{ internetShareCents: 0 }, 0],
    [{ purchaseCents: 120000, lifeMonths: 48, watts: 100 }, null],
    [{ purchaseCents: 0, lifeMonths: 48 }, 0],
    [{ purchaseCents: 120000 }, null],
    [
      {
        watts: 100,
        hoursPerMonth: 744,
        centsPerKwh: 20,
        internetShareCents: 100,
      },
      1588,
    ],
  ])(
    "keeps the calculation %j at %s cents in both consumers",
    (patch, expected) => {
      const machine = { ...blank, ...patch };
      expect(hardwareMonthlyCents(machine)).toBe(expected);
      expect(service.hardwareMonthlyCents(machine)).toBe(expected);
    },
  );
  it.each([
    [{}, null],
    [{ watts: 100 }, null],
    [{ purchaseCents: 120000 }, "node-services cost is out of range."],
    [{ purchaseCents: 120000, watts: 100 }, null],
    [{ hoursPerMonth: 745 }, "node-services has an invalid hoursPerMonth."],
    [{ hoursPerMonth: 1.5 }, "node-services has an invalid hoursPerMonth."],
    [{ purchaseCents: -1 }, "node-services has an invalid purchaseCents."],
    [
      { purchaseCents: 120000, lifeMonths: 0 },
      "node-services cost is out of range.",
    ],
  ])("keeps the existing validation %j", (patch, expected) => {
    const input = fleet(patch);
    expect(validateHardwareMachine(input.machines[0])).toBe(expected);
    expect(generated.validateHardwareMachine(input.machines[0])).toBe(expected);
    expect(validateHardwareInput(input)).toBe(expected);
    expect(service.validateHardwareInput(fleet(patch))).toBe(expected);
  });
  it("requires every machine exactly once", () => {
    const input = fleet({});
    input.machines[4] = input.machines[0];
    expect(validateHardwareInput(input)).toBe(
      "Hardware assumptions must include each fleet machine once.",
    );
  });
});
