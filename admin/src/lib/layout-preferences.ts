export const EDITOR_BENTO_PREFERENCES_EVENT = "njpbs:editor-bento-preferences";

export const LAYOUT_DENSITIES = ["compact", "comfortable", "loose"] as const;

export type LayoutDensity = (typeof LAYOUT_DENSITIES)[number];
export type LayoutDisclosure = "inspector" | "navigation" | "outline";

interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DENSITY_KEY = "njpbs-admin:layout-density";
const DISCLOSURE_KEYS: Record<LayoutDisclosure, string> = {
  inspector: "njpbs-admin:inspector-collapsed",
  navigation: "njpbs-admin:navigation-collapsed",
  outline: "njpbs-admin:outline-collapsed",
};

function browserStorage(): LayoutStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isLayoutDensity(value: string | null): value is LayoutDensity {
  return LAYOUT_DENSITIES.some((density) => density === value);
}

export function readLayoutDensity(
  storage: LayoutStorage | null = browserStorage(),
): LayoutDensity {
  try {
    const stored = storage?.getItem(DENSITY_KEY) ?? null;
    return isLayoutDensity(stored) ? stored : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function writeLayoutDensity(
  density: LayoutDensity,
  storage: LayoutStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(DENSITY_KEY, density);
  } catch {
    // Layout preferences are an enhancement. A blocked or full store must not block editing.
  }
}

// A missing choice remains distinct from expanded so each workspace can supply its default.
export function readStoredLayoutDisclosure(
  disclosure: LayoutDisclosure,
  storage: LayoutStorage | null = browserStorage(),
): boolean | null {
  try {
    const stored = storage?.getItem(DISCLOSURE_KEYS[disclosure]);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return null;
  } catch {
    return null;
  }
}

export function readLayoutDisclosure(
  disclosure: LayoutDisclosure,
  storage: LayoutStorage | null = browserStorage(),
  defaultCollapsed = disclosure === "outline",
): boolean {
  return readStoredLayoutDisclosure(disclosure, storage) ?? defaultCollapsed;
}

export function writeLayoutDisclosure(
  disclosure: LayoutDisclosure,
  collapsed: boolean,
  storage: LayoutStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(DISCLOSURE_KEYS[disclosure], String(collapsed));
  } catch {
    // View state stays local and optional; content editing remains available without storage.
  }
}
