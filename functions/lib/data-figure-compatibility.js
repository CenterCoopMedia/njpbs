"use strict";

const { visibleLayoutBlocks } = require("./content-layout");

const supportsDataFigures = capability => capability?.dataFigureVersion === 1;

function containsVisibleDataFigure(snapshot) {
  if (!Array.isArray(snapshot?.blocks)) return false;
  try { return visibleLayoutBlocks(snapshot.blocks).some(block => block.type === "data_figure"); }
  catch { return false; }
}

function candidateSupportsOwnedDataFigures(state, contract) {
  return state?.visible !== true || !state.datasetFiguresDigest || supportsDataFigures(contract);
}

module.exports = { supportsDataFigures, containsVisibleDataFigure, candidateSupportsOwnedDataFigures };
