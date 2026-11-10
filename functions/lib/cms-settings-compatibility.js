"use strict";

// Non-secret deployment receipt shared by the Firebase release and the
// standalone Admin deploy. Change it only when Admin requires a settings
// response an older deployed backend cannot provide.
const CMS_SETTINGS_CONTRACT_HEADER = "X-NJPBS-CMS-Settings-Contract";
const NEWSROOM_SETTINGS_CONTRACT = "newsroom-milestone-v1";

module.exports = {
  CMS_SETTINGS_CONTRACT_HEADER,
  NEWSROOM_SETTINGS_CONTRACT,
};
