// PBS JAWS schedule widget embed.
//
// gc.js reads a global PBS_CHROME_CONFIG and, for EACH widget declared in it,
// injects that widget's own dependency stack -- including a private copy of
// jQuery 1.8.2 and jQuery UI 1.10.4. Those copies are not shared, so declaring
// N widgets loads jQuery N times. The reloads trip History.js ("Adapter has
// already been loaded"), leave window.jQuery undefined, and make the
// datepicker-backed full-week grid throw "datepicker is not a function" so its
// table never renders. Only the first-declared widget survives the collision.
//
// So the embed declares exactly one widget: the full week grid. It is the
// complete, printable schedule on its own -- it opens on "Now", carries date
// navigation, channel selection, and PBS's own "Print TV Schedule" action, and
// covers what the separate "on now" and "kids" partials showed, without the load
// collision that left the grid empty.

export interface ScheduleWidget {
  /** gc.js widget name: its key under PBS_CHROME_CONFIG.widgets. */
  name: string;
  /** DOM id gc.js renders the widget into. */
  placeholderId: string;
}

/** The single JAWS widget embedded. Exactly one -- see the file header. */
export const SCHEDULE_WIDGETS: readonly ScheduleWidget[] = [
  { name: "tvschedules", placeholderId: "tvschedule" },
];

/** Public client-side widget key (scoped to the JAWS widget API, not a secret). */
export const SCHEDULE_WIDGET_API_KEY = "99dd2a8c-842a-4c38-873f-c664b93818b8";

/** gc.js loader source. */
export const SCHEDULE_WIDGET_SRC = "https://jaws-prod.cdn.pbs.org/js/gc.js";

/**
 * Build the PBS_CHROME_CONFIG assignment gc.js reads before it loads. Passing
 * more than one widget is what reloads jQuery and breaks the grid (see the file
 * header); the shipped call passes SCHEDULE_WIDGETS, which is a single widget.
 */
export function buildScheduleWidgetConfig(
  widgets: readonly ScheduleWidget[] = SCHEDULE_WIDGETS,
  apiKey: string = SCHEDULE_WIDGET_API_KEY,
): string {
  const declared = widgets
    .map((w) => `${w.name}: { placeholder: '#${w.placeholderId}' }`)
    .join(", ");
  return `var PBS_CHROME_CONFIG = { api_key: '${apiKey}', widgets: { ${declared} } };`;
}
