import {
  DESIGN_SYSTEM_VERSION,
  parseDesignTokens,
} from "./design-system-catalog";

export const DESIGN_PLAYGROUND_GROUPS = [
  "Brand and focus",
  "Surfaces",
  "Text and status",
  "Space and shape",
  "Motion",
] as const;

export type DesignPlaygroundGroup = (typeof DESIGN_PLAYGROUND_GROUPS)[number];

type DesignPlaygroundConstraint =
  | { kind: "color" }
  | {
      kind: "length";
      units: readonly {
        max: number;
        min: number;
        unit: "em" | "px" | "rem";
      }[];
    }
  | { kind: "duration"; min: number; max: number; unit: "ms" };

export interface DesignPlaygroundTokenSpec {
  constraint: DesignPlaygroundConstraint;
  group: DesignPlaygroundGroup;
  label: string;
  name: `--${string}`;
}

export interface DesignPlaygroundToken extends DesignPlaygroundTokenSpec {
  baseline: string;
}

const color = { kind: "color" } as const;
const rem = {
  kind: "length",
  units: [{ min: 0, max: 8, unit: "rem" }],
} as const;
const radius = {
  kind: "length",
  units: [
    { min: 0, max: 64, unit: "px" },
    { min: 0, max: 4, unit: "rem" },
  ],
} as const;

export const DESIGN_PLAYGROUND_TOKEN_SPECS: readonly DesignPlaygroundTokenSpec[] = [
  { name: "--pbs-blue", label: "PBS blue", group: "Brand and focus", constraint: color },
  { name: "--pbs-blue-bright", label: "Bright brand blue", group: "Brand and focus", constraint: color },
  { name: "--focus", label: "Focus ring", group: "Brand and focus", constraint: color },
  { name: "--bg-0", label: "Page background", group: "Surfaces", constraint: color },
  { name: "--bg-1", label: "Panel background", group: "Surfaces", constraint: color },
  { name: "--bg-2", label: "Elevated background", group: "Surfaces", constraint: color },
  { name: "--bg-now", label: "Current-state background", group: "Surfaces", constraint: color },
  { name: "--text", label: "Primary text", group: "Text and status", constraint: color },
  { name: "--text-dim", label: "Muted text", group: "Text and status", constraint: color },
  { name: "--text-quiet", label: "Quiet metadata", group: "Text and status", constraint: color },
  { name: "--action-red", label: "Action red", group: "Text and status", constraint: color },
  { name: "--status-green", label: "Status green", group: "Text and status", constraint: color },
  { name: "--space-4", label: "Standard space", group: "Space and shape", constraint: rem },
  { name: "--space-6", label: "Comfortable space", group: "Space and shape", constraint: rem },
  { name: "--space-8", label: "Large space", group: "Space and shape", constraint: rem },
  { name: "--radius-control", label: "Control radius", group: "Space and shape", constraint: radius },
  { name: "--radius-surface", label: "Surface radius", group: "Space and shape", constraint: radius },
  {
    name: "--heading-tracking",
    label: "Heading tracking",
    group: "Space and shape",
    constraint: {
      kind: "length",
      units: [{ min: -0.1, max: 0.1, unit: "em" }],
    },
  },
  {
    name: "--motion-duration-standard",
    label: "Standard motion",
    group: "Motion",
    constraint: { kind: "duration", min: 0, max: 2000, unit: "ms" },
  },
] as const;

const specByName = new Map(
  DESIGN_PLAYGROUND_TOKEN_SPECS.map((spec) => [spec.name, spec]),
);

export function getDesignPlaygroundTokens(source: string): DesignPlaygroundToken[] {
  const liveValues = new Map(
    parseDesignTokens(source).map((token) => [token.name, token.value]),
  );

  return DESIGN_PLAYGROUND_TOKEN_SPECS.map((spec) => {
    const baseline = liveValues.get(spec.name);
    if (!baseline) throw new Error(`Playground token ${spec.name} is missing from live CSS`);
    return { ...spec, baseline };
  });
}

export function groupDesignPlaygroundTokens(tokens: readonly DesignPlaygroundToken[]) {
  return DESIGN_PLAYGROUND_GROUPS.map((group) => ({
    group,
    tokens: tokens.filter((token) => token.group === group),
  })).filter((entry) => entry.tokens.length > 0);
}

export type DesignTokenOverrideValidation =
  | { valid: true; value: string }
  | { error: string; valid: false };

export function validateDesignTokenOverride(
  name: string,
  authoredValue: string,
): DesignTokenOverrideValidation {
  const spec = specByName.get(name as `--${string}`);
  if (!spec) {
    return { valid: false, error: "This token is not available in the playground." };
  }

  const value = authoredValue.trim();
  if (spec.constraint.kind === "color") {
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
      return { valid: false, error: "Use a hex color such as #2638c4." };
    }
    return { valid: true, value: value.toLowerCase() };
  }

  const match = value.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))(em|px|rem|ms)$/);
  const amount = Number(match?.[1]);
  const unit = match?.[2];

  if (spec.constraint.kind === "length") {
    const bounds = spec.constraint.units.find((candidate) => candidate.unit === unit);
    if (
      !match ||
      !Number.isFinite(amount) ||
      !bounds ||
      amount < bounds.min ||
      amount > bounds.max
    ) {
      const ranges = spec.constraint.units
        .map((candidate) => `${candidate.min}–${candidate.max}${candidate.unit}`)
        .join(" or ");
      return { valid: false, error: `Use a value from ${ranges}.` };
    }

    return { valid: true, value: `${amount}${unit}` };
  }

  if (
    !match ||
    !Number.isFinite(amount) ||
    unit !== spec.constraint.unit ||
    amount < spec.constraint.min ||
    amount > spec.constraint.max
  ) {
    return {
      valid: false,
      error: `Use a ${spec.constraint.unit} value from ${spec.constraint.min} to ${spec.constraint.max}.`,
    };
  }

  return { valid: true, value: `${amount}${unit}` };
}

function normalizeDesignTokenOverrides(
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  for (const [name, value] of Object.entries(overrides)) {
    const result = validateDesignTokenOverride(name, value);
    if (!result.valid) throw new Error(`Invalid override for ${name}: ${result.error}`);
  }

  return Object.fromEntries(
    DESIGN_PLAYGROUND_TOKEN_SPECS.flatMap((spec) => {
      if (!(spec.name in overrides)) return [];
      const result = validateDesignTokenOverride(spec.name, overrides[spec.name] ?? "");
      return result.valid ? [[spec.name, result.value]] : [];
    }),
  );
}

export function serializeDesignTokenCss(
  overrides: Readonly<Record<string, string>>,
): string {
  const normalized = normalizeDesignTokenOverrides(overrides);
  const declarations = Object.entries(normalized)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");

  return `/*\n * NJ PBS Design and Asset Lab draft\n * Based on v${DESIGN_SYSTEM_VERSION}\n * Status: experimental; not approved for production\n */\n:root {\n${declarations}\n}\n`;
}

export function serializeDesignTokenJson(
  overrides: Readonly<Record<string, string>>,
): string {
  return `${JSON.stringify(
    {
      schema: "njpbs-design-token-draft",
      status: "experimental",
      basedOnVersion: DESIGN_SYSTEM_VERSION,
      overrides: normalizeDesignTokenOverrides(overrides),
    },
    null,
    2,
  )}\n`;
}
