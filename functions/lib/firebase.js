"use strict";

const { getApps, initializeApp } = require("firebase-admin/app");
const { getAppCheck } = require("firebase-admin/app-check");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

const app = getApps()[0] || initializeApp();
const db = getFirestore(app);

// Keep the small local facade consumed by older function modules while all SDK
// imports use the modular entry points required by firebase-admin v14.
const firestore = Object.assign(() => db, { FieldValue });
const admin = {
  appCheck: () => getAppCheck(app),
  auth: () => getAuth(app),
  firestore,
};

module.exports = { admin, app, db };
