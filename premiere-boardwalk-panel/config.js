"use strict";
const local = typeof __BOARDWALK_LOCAL__ !== "undefined" && __BOARDWALK_LOCAL__;
module.exports = {
  local,
  revision: typeof __BOARDWALK_REVISION__ === "string" ? __BOARDWALK_REVISION__ : "",
  apiOrigin: local ? "http://localhost:5001/demo-njpbs/us-central1" : "https://api.example.org",
  approvalUrl: local ? "http://localhost:5173/premiere/connect" : "https://admin.njpbs.org/premiere/connect",
};
