"use strict";

const { defaultActionableResolution } = require("./bug-report-contract");

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolutionEmailLines(resolution) {
  if (!resolution || typeof resolution !== "object") return [];
  const defaults = defaultActionableResolution();
  const lines = [];
  const recommendedResolution = Array.isArray(resolution.recommendedResolution)
    ? resolution.recommendedResolution.filter((item) =>
        typeof item === "string" && item.trim())
    : [];
  if (
    recommendedResolution.length > 0 &&
    !sameValue(recommendedResolution, defaults.recommendedResolution)
  ) {
    lines.push(
      "Recommended resolution:",
      ...recommendedResolution.map((item, index) => `${index + 1}. ${item}`),
    );
  }
  if (
    typeof resolution.verification === "string" &&
    resolution.verification.trim() &&
    resolution.verification !== defaults.verification
  ) {
    lines.push(`Verification: ${resolution.verification}`);
  }
  if (
    typeof resolution.immediateSafeAction === "string" &&
    resolution.immediateSafeAction.trim() &&
    resolution.immediateSafeAction !== defaults.immediateSafeAction
  ) {
    lines.push(`Immediate action: ${resolution.immediateSafeAction}`);
  }
  if (
    typeof resolution.fallback === "string" &&
    resolution.fallback.trim() &&
    resolution.fallback !== defaults.fallback
  ) {
    lines.push(`Fallback: ${resolution.fallback}`);
  }
  const likelyCause = resolution.likelyCause;
  if (
    likelyCause &&
    typeof likelyCause === "object" &&
    typeof likelyCause.certainty === "string" &&
    likelyCause.certainty !== "unknown" &&
    typeof likelyCause.summary === "string" &&
    likelyCause.summary.trim() &&
    !sameValue(likelyCause, defaults.likelyCause)
  ) {
    lines.push(
      `Cause (${likelyCause.certainty.replaceAll("_", " ")}): ${likelyCause.summary}`,
    );
  }
  return lines;
}

module.exports = { resolutionEmailLines };
