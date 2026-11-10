"use strict";

const { visibleLayoutBlocks } = require("./content-layout");

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only a principal who can publish may add or change custom HTML. Removing a
// block, hiding it, or moving it without exposing hidden HTML needs no extra grant.
function changesCustomHtml(storedBlocks, nextBlocks) {
  const beforeBlocks = (Array.isArray(storedBlocks) ? storedBlocks : []).filter(isPlainObject);
  const visibleBefore = new Set(visibleLayoutBlocks(beforeBlocks).map((block) => block.id));
  const visibleAfter = new Set(visibleLayoutBlocks(nextBlocks).map((block) => block.id));
  const stored = new Map(
    beforeBlocks
      .filter((block) => block.type === "html" && isPlainObject(block.data))
      .map((block) => [block.id, block]),
  );
  return nextBlocks.some((block) => {
    if (block.type !== "html") return false;
    const before = stored.get(block.id);
    return !before || before.data.html !== block.data.html || before.data.title !== block.data.title ||
      (before.visible === false && block.visible === true) ||
      (visibleAfter.has(block.id) && !visibleBefore.has(block.id));
  });
}

module.exports = { changesCustomHtml };
