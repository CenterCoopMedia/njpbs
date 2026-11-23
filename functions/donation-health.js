"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { createDonationHealthHandler } = require("./lib/pbs/donation-health");

exports.donationHealth = onRequest(
  { region: "us-central1", invoker: "public", timeoutSeconds: 5, maxInstances: 2 },
  createDonationHealthHandler(),
);
