// Color tokens for the Events view's date plates, kept here (not inline in the
// component) so the WCAG AA promise is executable: tests/event-theme.test.ts
// feeds these through contrast.ts and fails the build if the pairing drops below
// AA. This mirrors how coming-soon-theme.ts pins the coming-soon palette.
//
// Why this exists: the month labels (.feature__month / .ev__month) are small
// uppercase text that sits directly on the page's near-black surface. The shared
// --pbs-blue-bright accent (#4d5ee8) clears AA as a focus outline (a 3:1 UI
// threshold) but only reaches 3.9:1 as small text on this surface — below the
// 4.5:1 floor. A lighter accent fixes the labels without touching the 20+ other,
// passing, uses of --pbs-blue-bright.

// The Events surface the date labels render over (matches the dark base).
export const EVENT_DATE_SURFACE = "var(--bg-0)";

// AA-safe accent for the small uppercase month labels: ~5.8:1 on EVENT_DATE_SURFACE.
export const EVENT_DATE_ACCENT = "var(--color-event-date-accent)";
