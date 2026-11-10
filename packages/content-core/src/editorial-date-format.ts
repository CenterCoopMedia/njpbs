// How a publication date reads on a public page.
//
// AP style, which is the house style for this site's copy: months longer than
// five letters are abbreviated with a period when they sit beside a day (Aug. 21,
// 2026), and March, April, May, June and July are always spelled out. The
// exception list is the whole reason this is not `toLocaleDateString`, which
// writes "Aug 21, 2026" or "August 21, 2026" depending on the option and never
// the AP form.
//
// The other reason is the day itself. A `YYYY-MM-DD` editorial date is a
// calendar day in station time that the dates contract already resolved; parsing
// it through `Date` would apply the build machine's zone and can move the day
// across a UTC boundary, printing a date the newsroom never published on. So it
// is parsed by hand and never becomes a `Date`.

const AP_MONTHS = [
  "Jan.",
  "Feb.",
  "March",
  "April",
  "May",
  "June",
  "July",
  "Aug.",
  "Sept.",
  "Oct.",
  "Nov.",
  "Dec.",
];

function parseCalendarDay(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/**
 * "Aug. 21, 2026" for a `YYYY-MM-DD` calendar day, or null for anything else.
 *
 * Null rather than a placeholder: a page with no printable date should print no
 * date line at all, not the word "unknown" where a reader expects one.
 */
export function formatEditorialDate(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const parsed = parseCalendarDay(value);
  if (!parsed) return null;
  return `${AP_MONTHS[parsed.month - 1]} ${parsed.day}, ${parsed.year}`;
}
