export interface HeroImageRecord {
  id: string;
  src: string;
  alt: string;
  label: string;
  caption?: string;
  credit?: string;
  position: string;
  scrim: number;
  accent: string;
  enabled: boolean;
}

export interface HeroImagePayload {
  id: string;
  src: string;
  alt: string;
  label: string;
  caption?: string;
  credit?: string;
  position: string;
  scrim: number;
  accent: string;
}

const REQUIRED_COLUMNS = ["id", "src", "alt"] as const;
const DEFAULT_POSITION = "center center";
const DEFAULT_SCRIM = 0.72;
const DEFAULT_ACCENT = "var(--color-signal-near-white)";
const SCRIM_MIN = 0.45;
const SCRIM_MAX = 0.9;
const POSITION_KEYWORD = /^(left|center|right|top|bottom)$/;
const POSITION_PERCENT = /^(?:100|[1-9]?\d)%$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    const next = csv[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell.trim());
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  if (row.some((value) => value.length > 0)) rows.push(row);

  if (inQuotes) {
    throw new Error("Hero image CSV has an unclosed quoted field.");
  }

  return rows;
}

function parseEnabled(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return !["0", "false", "no", "disabled", "off"].includes(normalized);
}

function parseScrim(value: string | undefined): number {
  const raw = (value ?? "").trim();
  if (!raw) return DEFAULT_SCRIM;

  const scrim = Number(raw);
  if (!Number.isFinite(scrim) || scrim < SCRIM_MIN || scrim > SCRIM_MAX) {
    throw new Error(
      `Hero image scrim must be a number from ${SCRIM_MIN} to ${SCRIM_MAX}: ${raw}`,
    );
  }

  return scrim;
}

// "x" = horizontal-only keyword, "y" = vertical-only keyword,
// "either" = center or a percentage (axis resolved by position).
function positionAxis(part: string): "x" | "y" | "either" {
  if (part === "left" || part === "right") return "x";
  if (part === "top" || part === "bottom") return "y";
  return "either";
}

function parsePosition(value: string | undefined): string {
  const position = (value ?? "").trim().replace(/\s+/g, " ");
  if (!position) return DEFAULT_POSITION;

  const parts = position.split(" ");
  const isSafe =
    parts.length >= 1 &&
    parts.length <= 2 &&
    parts.every((part) => POSITION_KEYWORD.test(part) || POSITION_PERCENT.test(part));
  if (!isSafe) {
    throw new Error(`Hero image position uses unsupported CSS: ${position}`);
  }

  // A two-value background-position must name different axes. Two same-axis
  // keywords (top bottom, left right) are syntactically valid tokens but
  // invalid as a pair: the browser drops the declaration and loses the
  // focal point, so reject them at build time.
  if (parts.length === 2) {
    const [first, second] = parts.map(positionAxis);
    if (first !== "either" && first === second) {
      throw new Error(
        `Hero image position uses two ${first === "x" ? "horizontal" : "vertical"} keywords: ${position}`,
      );
    }
  }

  return position;
}

function parseAccent(value: string | undefined): string {
  const accent = (value ?? "").trim();
  if (!accent) return DEFAULT_ACCENT;
  if (!HEX_COLOR.test(accent)) {
    throw new Error(`Hero image accent must be a six-digit hex color: ${accent}`);
  }
  return accent.toUpperCase();
}

function assertPresent(value: string, column: string): void {
  if (!value) {
    throw new Error(`Hero image CSV has an empty required value: ${column}`);
  }
}

function assertSafeImageSrc(src: string): void {
  const isRootRelative = src.startsWith("/") && !src.startsWith("//");
  const isHttps = src.startsWith("https://");
  if (!isRootRelative && !isHttps) {
    throw new Error(
      `Hero image src must be root-relative or https: ${src || "<empty>"}`,
    );
  }
}

export function parseHeroImagesCsv(csv: string): HeroImageRecord[] {
  const rows = parseCsvRows(csv).filter((row) => !row[0]?.startsWith("#"));
  if (rows.length === 0) return [];

  const [header, ...body] = rows;
  const columns = new Map(header.map((name, index) => [name.trim(), index]));

  for (const column of REQUIRED_COLUMNS) {
    if (!columns.has(column)) {
      throw new Error(`Hero image CSV is missing required column: ${column}`);
    }
  }

  return body.map((row) => {
    const get = (column: string) => row[columns.get(column) ?? -1]?.trim() ?? "";
    const id = get("id");
    const src = get("src");
    const alt = get("alt");
    assertPresent(id, "id");
    assertPresent(alt, "alt");
    assertSafeImageSrc(src);

    return {
      id,
      src,
      alt,
      label: get("label") || alt,
      caption: get("caption") || undefined,
      credit: get("credit") || undefined,
      position: parsePosition(get("position")),
      scrim: parseScrim(get("scrim")),
      accent: parseAccent(get("accent")),
      enabled: parseEnabled(get("enabled") || get("active")),
    };
  });
}

export function getEnabledHeroImages(
  records: HeroImageRecord[],
): HeroImageRecord[] {
  return records.filter((record) => record.enabled);
}

export function pickInitialHeroImage(
  records: HeroImageRecord[],
): HeroImageRecord | undefined {
  return getEnabledHeroImages(records)[0];
}

export function toHeroImagePayload(
  records: HeroImageRecord[],
): HeroImagePayload[] {
  return getEnabledHeroImages(records).map(
    ({ id, src, alt, label, caption, credit, position, scrim, accent }) => ({
      id,
      src,
      alt,
      label,
      caption,
      credit,
      position,
      scrim,
      accent,
    }),
  );
}

export function toCssImageUrl(src: string): string {
  assertSafeImageSrc(src);
  return `url(${JSON.stringify(src)})`;
}
