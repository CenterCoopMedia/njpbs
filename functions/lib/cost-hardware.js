// Generated from packages/content-core/src/cost-hardware.ts.
// Regenerate with: node scripts/generate-cost-hardware.mjs
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/content-core/src/cost-hardware.ts
var cost_hardware_exports = {};
__export(cost_hardware_exports, {
  HARDWARE_LIMITS: () => HARDWARE_LIMITS,
  HARDWARE_MACHINE_IDS: () => HARDWARE_MACHINE_IDS,
  hardwareMonthlyCents: () => hardwareMonthlyCents,
  validateHardwareInput: () => validateHardwareInput,
  validateHardwareMachine: () => validateHardwareMachine
});
module.exports = __toCommonJS(cost_hardware_exports);
var MAX_CENTS = 1e11;
var HARDWARE_MACHINE_IDS = Object.freeze([
  "node-services",
  "node-compute",
  "node-gpu-a",
  "node-gpu-b",
  "node-offsite"
]);
var HARDWARE_LIMITS = Object.freeze({
  purchaseCents: MAX_CENTS,
  lifeMonths: 1200,
  watts: 2e5,
  hoursPerMonth: 744,
  centsPerKwh: 1e6,
  internetShareCents: MAX_CENTS
});
function hardwareMonthlyCents(machine) {
  const parts = [];
  const hasPurchase = machine.purchaseCents !== null && machine.purchaseCents !== void 0;
  const hasLife = machine.lifeMonths !== null && machine.lifeMonths !== void 0;
  if (hasPurchase !== hasLife) return null;
  if (hasPurchase) {
    if (!Number.isSafeInteger(machine.lifeMonths) || machine.lifeMonths < 1)
      return null;
    if (!Number.isSafeInteger(machine.purchaseCents) || machine.purchaseCents < 0)
      return null;
    parts.push(Math.round(machine.purchaseCents / machine.lifeMonths));
  }
  const powerFields = [
    machine.watts,
    machine.hoursPerMonth,
    machine.centsPerKwh
  ];
  const powerSet = powerFields.filter(
    (value) => value !== null && value !== void 0
  );
  if (powerSet.length !== 0 && powerSet.length !== 3) return null;
  if (powerSet.length === 3) {
    if (powerFields.some((value) => !Number.isSafeInteger(value) || value < 0))
      return null;
    parts.push(
      Math.round(
        machine.watts * machine.hoursPerMonth * machine.centsPerKwh / 1e3
      )
    );
  }
  if (machine.internetShareCents !== null && machine.internetShareCents !== void 0) {
    if (!Number.isSafeInteger(machine.internetShareCents) || machine.internetShareCents < 0)
      return null;
    parts.push(machine.internetShareCents);
  }
  if (parts.length === 0) return null;
  return parts.reduce((sum, value) => sum + value, 0);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validateHardwareInput(input) {
  if (!isRecord(input) || !Array.isArray(input.machines)) {
    return "Hardware assumptions must list the fleet machines.";
  }
  const ids = input.machines.map((machine) => machine?.id);
  if (ids.length !== HARDWARE_MACHINE_IDS.length || HARDWARE_MACHINE_IDS.some((id) => !ids.includes(id)) || new Set(ids).size !== ids.length) {
    return "Hardware assumptions must include each fleet machine once.";
  }
  for (const machine of input.machines) {
    const error = validateHardwareMachine(machine);
    if (error) return error;
  }
  return null;
}
function validateHardwareMachine(machine) {
  if (!isRecord(machine)) return "Each machine needs an id.";
  if (typeof machine.label !== "string") return "Machine label must be text.";
  if (machine.label.trim().length > 80) return "Machine label is too long.";
  if (machine.label.trim() === "") return "Machine label is required.";
  for (const [field, max] of Object.entries(HARDWARE_LIMITS)) {
    const value = machine[field];
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
      return `${machine.label} has an invalid ${field}.`;
    }
  }
  const monthly = hardwareMonthlyCents(machine);
  const anyValue = Object.keys(HARDWARE_LIMITS).some(
    (field) => machine[field] !== null
  );
  const partialPower = [
    machine.watts,
    machine.hoursPerMonth,
    machine.centsPerKwh
  ].filter((value) => value !== null).length;
  if (partialPower === 1 || partialPower === 2) return null;
  if (anyValue && (monthly === null || !Number.isSafeInteger(monthly) || monthly > MAX_CENTS)) {
    return `${machine.label} cost is out of range.`;
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HARDWARE_LIMITS,
  HARDWARE_MACHINE_IDS,
  hardwareMonthlyCents,
  validateHardwareInput,
  validateHardwareMachine
});
