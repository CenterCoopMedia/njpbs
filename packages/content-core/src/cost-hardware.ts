/** Pure hardware assumptions shared by the ledger service and its Admin editor. */
export interface HardwareAssumptions {
  purchaseCents?: number | null;
  lifeMonths?: number | null;
  watts?: number | null;
  hoursPerMonth?: number | null;
  centsPerKwh?: number | null;
  internetShareCents?: number | null;
}

const MAX_CENTS = 100_000_000_000;
export const HARDWARE_MACHINE_IDS = Object.freeze([
  "node-services",
  "node-compute",
  "node-gpu-a",
  "node-gpu-b",
  "node-offsite",
]);
export const HARDWARE_LIMITS = Object.freeze({
  purchaseCents: MAX_CENTS,
  lifeMonths: 1200,
  watts: 200_000,
  hoursPerMonth: 744,
  centsPerKwh: 1_000_000,
  internetShareCents: MAX_CENTS,
});

export function hardwareMonthlyCents(
  machine: HardwareAssumptions,
): number | null {
  const parts: number[] = [];
  const hasPurchase =
    machine.purchaseCents !== null && machine.purchaseCents !== undefined;
  const hasLife =
    machine.lifeMonths !== null && machine.lifeMonths !== undefined;
  if (hasPurchase !== hasLife) return null;
  if (hasPurchase) {
    if (!Number.isSafeInteger(machine.lifeMonths) || machine.lifeMonths! < 1)
      return null;
    if (
      !Number.isSafeInteger(machine.purchaseCents) ||
      machine.purchaseCents! < 0
    )
      return null;
    parts.push(Math.round(machine.purchaseCents! / machine.lifeMonths!));
  }
  const powerFields = [
    machine.watts,
    machine.hoursPerMonth,
    machine.centsPerKwh,
  ];
  const powerSet = powerFields.filter(
    (value) => value !== null && value !== undefined,
  );
  if (powerSet.length !== 0 && powerSet.length !== 3) return null;
  if (powerSet.length === 3) {
    if (powerFields.some((value) => !Number.isSafeInteger(value) || value! < 0))
      return null;
    parts.push(
      Math.round(
        (machine.watts! * machine.hoursPerMonth! * machine.centsPerKwh!) / 1000,
      ),
    );
  }
  if (
    machine.internetShareCents !== null &&
    machine.internetShareCents !== undefined
  ) {
    if (
      !Number.isSafeInteger(machine.internetShareCents) ||
      machine.internetShareCents < 0
    )
      return null;
    parts.push(machine.internetShareCents);
  }
  if (parts.length === 0) return null;
  return parts.reduce((sum, value) => sum + value, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateHardwareInput(input: unknown): string | null {
  if (!isRecord(input) || !Array.isArray(input.machines)) {
    return "Hardware assumptions must list the fleet machines.";
  }
  const ids = input.machines.map((machine) => machine?.id);
  if (
    ids.length !== HARDWARE_MACHINE_IDS.length ||
    HARDWARE_MACHINE_IDS.some((id) => !ids.includes(id)) ||
    new Set(ids).size !== ids.length
  ) {
    return "Hardware assumptions must include each fleet machine once.";
  }
  for (const machine of input.machines) {
    const error = validateHardwareMachine(machine);
    if (error) return error;
  }
  return null;
}

/** Validate one preview using the service rules; fleet membership stays in validateHardwareInput. */
export function validateHardwareMachine(machine: unknown): string | null {
  if (!isRecord(machine)) return "Each machine needs an id.";
  if (typeof machine.label !== "string") return "Machine label must be text.";
  if (machine.label.trim().length > 80) return "Machine label is too long.";
  if (machine.label.trim() === "") return "Machine label is required.";
  for (const [field, max] of Object.entries(HARDWARE_LIMITS)) {
    const value = machine[field];
    if (value === null) continue;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > max
    ) {
      return `${machine.label} has an invalid ${field}.`;
    }
  }
  const monthly = hardwareMonthlyCents(machine as HardwareAssumptions);
  const anyValue = Object.keys(HARDWARE_LIMITS).some(
    (field) => machine[field] !== null,
  );
  const partialPower = [
    machine.watts,
    machine.hoursPerMonth,
    machine.centsPerKwh,
  ].filter((value) => value !== null).length;
  // The service deliberately accepts partial power assumptions as a saved blank calculation.
  if (partialPower === 1 || partialPower === 2) return null;
  if (
    anyValue &&
    (monthly === null || !Number.isSafeInteger(monthly) || monthly > MAX_CENTS)
  ) {
    return `${machine.label} cost is out of range.`;
  }
  return null;
}
