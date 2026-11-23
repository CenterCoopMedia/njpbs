"use strict";

const { visibleLayoutBlocks } = require("./content-layout");
const { figureSelections } = require("./scroll-story");

const supportsDataFigures = capability => capability?.dataFigureVersion === 1;

function containsVisibleDataFigure(snapshot) {
  if (!Array.isArray(snapshot?.blocks)) return false;
  try { return visibleLayoutBlocks(snapshot.blocks).some(block => figureSelections(block).length > 0); }
  catch { return false; }
}

function candidateSupportsOwnedDataFigures(state, contract) {
  return state?.visible !== true || !state.datasetFiguresDigest || supportsDataFigures(contract);
}

module.exports = { supportsDataFigures, containsVisibleDataFigure, candidateSupportsOwnedDataFigures };
