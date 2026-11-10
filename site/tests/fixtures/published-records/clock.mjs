// Process-boundary clock for full-build/compiled Event grouping parity.
const OriginalDate = globalThis.Date;
const instant = OriginalDate.parse("2026-10-12T12:00:00.000Z");
globalThis.Date = class extends OriginalDate {
  constructor(...args) {
    if (args.length === 0) super(instant);
    else super(...args);
  }
  static now() { return instant; }
};
