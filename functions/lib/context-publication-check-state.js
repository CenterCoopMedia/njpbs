"use strict";

function currentContextCheck(queue) {
  const check = queue?.lastPublicCheck;
  return check && check.queueStatus === queue.status && check.alertEpoch === (queue.alertEpoch ?? null) ? check : null;
}

module.exports = { currentContextCheck };
