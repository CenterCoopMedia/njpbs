"use strict";

const { defineString } = require("firebase-functions/params");

const GITHUB_REPOSITORY = defineString("CMS_BUG_REPORT_GITHUB_REPOSITORY");
const GITHUB_REPOSITORY_ID = defineString("CMS_BUG_REPORT_GITHUB_REPOSITORY_ID");
const FIX_GITHUB_REPOSITORY = defineString("CMS_BUG_REPORT_FIX_GITHUB_REPOSITORY");
const FIX_GITHUB_REPOSITORY_ID = defineString("CMS_BUG_REPORT_FIX_GITHUB_REPOSITORY_ID");

function repositoryIdentity(repository, id) {
  if (typeof repository !== "string" ||
      !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
      !/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) {
    throw new Error("A GitHub repository name and numeric ID must be configured");
  }
  return { repository, repositoryId: Number(id) };
}

function githubIssueRepository() {
  const repository = (process.env.CMS_BUG_REPORT_GITHUB_REPOSITORY ??
    GITHUB_REPOSITORY.value() ?? "").trim();
  const id = (process.env.CMS_BUG_REPORT_GITHUB_REPOSITORY_ID ??
    GITHUB_REPOSITORY_ID.value() ?? "").trim();
  return repositoryIdentity(repository, id);
}

function githubFixRepository() {
  const repository = (process.env.CMS_BUG_REPORT_FIX_GITHUB_REPOSITORY ??
    FIX_GITHUB_REPOSITORY.value() ?? "").trim();
  const id = (process.env.CMS_BUG_REPORT_FIX_GITHUB_REPOSITORY_ID ??
    FIX_GITHUB_REPOSITORY_ID.value() ?? "").trim();
  return repositoryIdentity(repository, id);
}

module.exports = { githubIssueRepository, githubFixRepository, repositoryIdentity };
