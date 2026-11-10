"use strict";

// Windows reports a file that Premiere still holds open as EBUSY. UXP may pass
// only the message text through, so match the system phrase when no code is set.
function inUse(error) {
  if (error?.code) return error.code === "EBUSY";
  return /resource busy or locked|used by another process/i.test(String(error?.message || ""));
}

// Delete each tracked file. Keep a file that is in use and continue with the
// others. Other failures stop the action as before.
async function clearTracked({ entries, mappings, key, save }) {
  let removed = 0;
  const kept = [];
  for (const entry of entries) {
    const path = key(entry.nativePath);
    if (!entry.isFile || !Object.hasOwn(mappings, path)) continue;
    try { await entry.delete(); }
    catch (error) {
      if (!inUse(error)) throw error;
      kept.push(entry.name);
      continue;
    }
    delete mappings[path]; removed++;
    save(mappings);
  }
  return { removed, kept };
}

function clearMessage({ removed, kept }) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const text = [`Removed ${plural(removed, "downloaded file")}.`];
  if (kept.length) {
    const it = kept.length === 1 ? "it" : "them";
    text.push(`Premiere is still using ${plural(kept.length, "file")}, so the panel kept ${it}: ${kept.join(", ")}.`,
      `Close the projects that use ${it}, or restart Premiere. Then clear again.`);
  }
  text.push("Other cache files were kept.");
  return text.join(" ");
}

module.exports = { clearTracked, clearMessage };
