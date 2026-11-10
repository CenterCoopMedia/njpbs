"use strict";

// Remove this transition seam when #2793 retires full-build Post publishing.
function useFullBuildForPausedPost({ owned, admissionEnabled }) {
  return !owned && !admissionEnabled;
}

function useAssetsForUnavailablePost(status) {
  return status >= 500;
}

module.exports = { useFullBuildForPausedPost, useAssetsForUnavailablePost };
