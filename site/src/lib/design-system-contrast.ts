import { contrastRatio, meetsAA } from "./contrast";
import { parseDesignTokens } from "./design-system-catalog";

export interface DesignContrastPairing {
  background: `--${string}`;
  foreground: `--${string}`;
  id: string;
  kind: "text" | "ui";
  label: string;
}

export interface MeasuredDesignContrast extends DesignContrastPairing {
  backgroundValue: string;
  foregroundValue: string;
  minimum: 3 | 4.5;
  passes: boolean;
  ratio: number;
}

export const DESIGN_CONTRAST_PAIRINGS: readonly DesignContrastPairing[] = [
  {
    id: "primary-on-page",
    label: "Primary text on page",
    foreground: "--color-text-on-surface",
    background: "--color-surface-page",
    kind: "text",
  },
  {
    id: "muted-on-panel",
    label: "Muted text on panel",
    foreground: "--color-text-muted",
    background: "--color-surface-panel",
    kind: "text",
  },
  {
    id: "quiet-on-elevated",
    label: "Quiet metadata on elevated surface",
    foreground: "--color-text-quiet",
    background: "--color-surface-elevated",
    kind: "text",
  },
  {
    id: "link-on-page",
    label: "Link on page",
    foreground: "--color-link",
    background: "--color-surface-page",
    kind: "text",
  },
  {
    id: "text-on-brand",
    label: "Text on PBS blue",
    foreground: "--color-text-on-brand",
    background: "--color-brand",
    kind: "text",
  },
  {
    id: "text-on-action",
    label: "Text on action",
    foreground: "--color-text-on-action",
    background: "--color-action",
    kind: "text",
  },
  {
    id: "focus-on-page",
    label: "Focus ring on dark page",
    foreground: "--color-focus-ring",
    background: "--color-surface-page",
    kind: "ui",
  },
  {
    id: "focus-on-paper",
    label: "Focus ring on light paper",
    foreground: "--color-focus-ring-on-light",
    background: "--color-paper",
    kind: "ui",
  },
] as const;

function resolveHex(
  values: ReadonlyMap<string, string>,
  name: string,
  seen = new Set<string>(),
): string {
  if (seen.has(name)) throw new Error(`CSS token cycle at ${name}`);
  seen.add(name);

  const value = values.get(name) ?? "";
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${[...value.slice(1)].map((channel) => channel.repeat(2)).join("")}`;
  }

  const alias = value.match(/^var\((--[a-z0-9-]+)\)$/i);
  return alias ? resolveHex(values, alias[1], seen) : "";
}

export function measureDesignContrast(source: string): MeasuredDesignContrast[] {
  const values = new Map(
    parseDesignTokens(source).map((token) => [token.name, token.value]),
  );

  return DESIGN_CONTRAST_PAIRINGS.map((pairing) => {
    const foregroundValue = resolveHex(values, pairing.foreground);
    const backgroundValue = resolveHex(values, pairing.background);
    if (!foregroundValue || !backgroundValue) {
      throw new Error(`Unable to resolve contrast pairing ${pairing.id}`);
    }

    const ratio = contrastRatio(foregroundValue, backgroundValue);
    const minimum = pairing.kind === "ui" ? 3 : 4.5;
    return {
      ...pairing,
      foregroundValue,
      backgroundValue,
      minimum,
      passes: meetsAA(ratio, { large: pairing.kind === "ui" }),
      ratio,
    };
  });
}
