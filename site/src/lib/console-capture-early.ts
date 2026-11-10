// Boot-time console capture for the "report a problem" widget.
//
// console-capture.ts only starts recording when the footer report island's
// module script runs, which is after earlier page scripts have already executed.
// A visitor reporting a boot-time failure would submit a report missing exactly
// the error that failing script threw. This module closes that gap: a minimal
// capture primitive emitted as a classic inline <script> in the document head, so
// it runs before any other page script. It installs a small console hook and a
// buffer on a shared global slot; console-capture.ts then adopts that same
// buffer, so the two are one source of truth, never two.
//
// A classic inline script cannot import, so the browser code is a self-contained
// string (no identifier from this module's scope leaks into it) with the caps and
// the slot key interpolated from console-capture.ts. That string is the single
// early-capture implementation; the test evaluates it directly.

import {
  EARLY_CAPTURE_GLOBAL_KEY,
  MAX_ENTRIES,
  MAX_MESSAGE_LENGTH,
} from "./console-capture";

// The exact JavaScript emitted inside the head <script>. Defensive throughout — a
// capture path that breaks logging is worse than a missed line — so a non-writable
// console is caught and any method already wrapped is put back, and stringify
// falls back rather than raising on an exotic value. It writes a slot shaped
// { buffer, originals } that console-capture.ts's adoptEarlyCapture reads.
export const EARLY_CONSOLE_CAPTURE_SNIPPET = `(function () {
  "use strict";
  var KEY = ${JSON.stringify(EARLY_CAPTURE_GLOBAL_KEY)};
  if (typeof window === "undefined" || typeof console === "undefined") return;
  if (window[KEY]) return;
  var MAX_ENTRIES = ${MAX_ENTRIES};
  var MAX_MESSAGE_LENGTH = ${MAX_MESSAGE_LENGTH};
  var LEVELS = ["log", "warn", "error", "info"];
  var buffer = [];
  var originals = {};
  function stringify(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value instanceof Error) return value.name + ": " + value.message;
    try {
      var json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch (e) {}
    try {
      return String(value);
    } catch (e) {
      return "[unserializable]";
    }
  }
  function addEntry(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(stringify(args[i]));
    buffer.push({
      level: level,
      message: parts.join(" ").slice(0, MAX_MESSAGE_LENGTH),
      timestamp: new Date().toISOString(),
    });
    if (buffer.length > MAX_ENTRIES) buffer.shift();
  }
  var wrapped = [];
  try {
    for (var j = 0; j < LEVELS.length; j++) {
      (function (level) {
        var original = console[level];
        originals[level] = original;
        console[level] = function () {
          addEntry(level, arguments);
          if (original) original.apply(console, arguments);
        };
        wrapped.push(level);
      })(LEVELS[j]);
    }
  } catch (e) {
    // A non-writable console method: put back what we already wrapped and leave
    // the console alone rather than half-hooked.
    for (var k = 0; k < wrapped.length; k++) {
      if (originals[wrapped[k]]) console[wrapped[k]] = originals[wrapped[k]];
    }
    return;
  }
  window[KEY] = { buffer: buffer, originals: originals };
})();`;
