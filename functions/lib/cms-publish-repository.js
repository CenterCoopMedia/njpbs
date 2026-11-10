"use strict";

const { defineString } = require("firebase-functions/params");

const PUBLISH_GITHUB_REPOSITORY = defineString("CMS_PUBLISH_GITHUB_REPOSITORY", {
  default: "",
});

function publishGithubRepository() {
  const repository = PUBLISH_GITHUB_REPOSITORY.value();
  if (typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/.test(repository) || /replace|placeholder/i.test(repository) || [".", ".."].includes(repository.split("/")[1])) {
    throw new Error("Publish dispatch repository is not approved");
  }
  return repository;
}

module.exports = { publishGithubRepository };
