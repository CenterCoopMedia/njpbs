"use strict";

const MEDIA_TAG_SAMPLE_SIZE = 30;

// Keep the saved spelling and bound the response even for older records.
function savedMediaTagSample(records) {
  return [...new Set(records.flatMap(record => record.tags.slice(0, 30)
    .map(tag => tag.trim()).filter(tag => tag && tag.length <= 80)))];
}

module.exports = { MEDIA_TAG_SAMPLE_SIZE, savedMediaTagSample };
