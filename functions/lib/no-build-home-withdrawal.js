"use strict";

// Compatibility for accepted Home jobs and existing callers. The temporary
// full-build safety work is owned by one Post fallback seam; see #2793.
const fallback = require("./transitional-post-withdrawal");
module.exports = {
  prepareHomeWithdrawalBuild: fields => fallback.preparePostWithdrawalBuild({ ...fields, homeAffected: true }),
  enqueueHomeWithdrawalBuild: fallback.enqueuePostWithdrawalBuild,
  retryHomeWithdrawalBuild: fallback.retryPostWithdrawalBuild,
  readHomeWithdrawalPublication: fallback.readPostWithdrawalPublication,
  warnFirstHomeFailure: fallback.warnFirstHomeFailure,
  HOME_FALLBACK_WARNING: fallback.HOME_FALLBACK_WARNING,
  HOME_WITHDRAWAL_WARNING: fallback.HOME_WITHDRAWAL_WARNING,
};
