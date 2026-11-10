"use strict";

function validateMarkers(markers) {
  if (!Array.isArray(markers) || markers.length > 100) throw new Error("Use at most 100 markers per asset.");
  for (const marker of markers) {
    if (marker.type === "WebLink") throw new Error("WebLink markers cannot round-trip because Premiere cannot restore their URL and target. Keep them in Premiere.");
    if (!Number.isSafeInteger(marker.startMs) || !Number.isSafeInteger(marker.endMs) ||
        marker.startMs < 0 || marker.endMs < marker.startMs ||
        typeof marker.name !== "string" || marker.name.length > 200 ||
        typeof marker.comment !== "string" || marker.comment.length > 1000 ||
        !["Comment", "Chapter", "Segmentation"].includes(marker.type) ||
        !Number.isInteger(marker.color) || marker.color < 0 || marker.color > 7) {
      throw new Error("Markers need valid times, a name up to 200 characters, a comment up to 1,000 characters, and a supported type and color.");
    }
  }
  if (encodeURIComponent(JSON.stringify(markers)).replace(/%[A-F\d]{2}/g, "x").length > 65536) {
    throw new Error("Marker metadata exceeds 64 KiB. Shorten comments before saving.");
  }
  return markers;
}

function withinRange(marker, source) {
  return marker.startMs >= (source.inMs || 0) &&
    (source.outMs === undefined || (marker.startMs < source.outMs && marker.endMs <= source.outMs));
}

function toClipMarkers(markers, source) {
  const offset = source.inMs || 0;
  return validateMarkers(markers).filter(marker => withinRange(marker, source))
    .map(marker => ({ ...marker, startMs: marker.startMs - offset, endMs: marker.endMs - offset }));
}

function mergeClipMarkers(existing, local, source) {
  const offset = source.inMs || 0;
  const converted = validateMarkers(local).map(marker => ({ ...marker, startMs: marker.startMs + offset, endMs: marker.endMs + offset }));
  if (converted.some(marker => !withinRange(marker, source))) throw new Error("A selected clip marker extends beyond the downloaded range.");
  // Preserve markers outside the range, including those crossing either boundary.
  return validateMarkers([...existing.filter(marker => !withinRange(marker, source)), ...converted]
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs));
}

module.exports = { validateMarkers, toClipMarkers, mergeClipMarkers };
