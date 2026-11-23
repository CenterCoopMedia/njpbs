"use strict";

// Dedicated runtime identities exist only in the production project. A dev
// deployment (CMS_DEPLOYMENT_ENVIRONMENT=development at discovery, as in
// lib/cms-edge.js) runs these functions as the dev project's default identity.
function productionServiceAccount(name) {
  return process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development" ? undefined : `${name}@njpbs-site.iam.gserviceaccount.com`;
}

module.exports = { productionServiceAccount };
