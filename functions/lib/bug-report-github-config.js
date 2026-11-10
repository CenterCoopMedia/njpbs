"use strict";

const { defineString } = require("firebase-functions/params");

const GITHUB_REPOSITORY = defineString("CMS_BUG_REPORT_GITHUB_REPOSITORY");

function githubRepository() {
  const repository = (process.env.CMS_BUG_REPORT_GITHUB_REPOSITORY ??
    GITHUB_REPOSITORY.value() ?? "").trim();
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
    throw new Error("A private report repository must be configured");
  }
  return repository;
}

module.exports = { githubRepository };
