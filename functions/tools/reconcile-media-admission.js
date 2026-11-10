#!/usr/bin/env node
"use strict";
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { reconcileMediaAdmission } = require("../lib/media-discovery");

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply") || args.length > 1) {
    throw new Error("Usage: node functions/tools/reconcile-media-admission.js [--apply]");
  }
  initializeApp();
  // Default read-only; apply changes only the capacity ledger in this transaction.
  console.log(JSON.stringify(await reconcileMediaAdmission(getFirestore(), {
    apply: args.includes("--apply"),
  })));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
