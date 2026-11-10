#!/usr/bin/env node
import { repositoryMatches } from "./lib/repository-identity.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_ADMIN_MILESTONE_NUMBER = 16;
const MAX_ADMIN_MILESTONES = 100;
const REFRESH_WINDOW_MS = 72 * 60 * 60 * 1000;

function fail(detail) {
  throw new Error(`Admin status manifest is invalid: ${detail}.`);
}

function record(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function cleanString(value, name, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    fail(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function normalizedTimestamp(value, name) {
  const timestamp = cleanString(value, name, 40);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) fail(`${name} must be an ISO timestamp`);
  return new Date(milliseconds).toISOString();
}

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer`);
  }
  return value;
}

function milestoneStatus(rawMilestone, repository) {
  const milestone = record(rawMilestone, "milestone");
  if (!Number.isSafeInteger(milestone.number) || milestone.number < 1) {
    fail("milestone number must be a positive integer");
  }
  if (milestone.state !== "open" && milestone.state !== "closed") {
    fail("milestone state must be open or closed");
  }
  const expectedUrl =
    `https://github.com/${repository}/milestone/${milestone.number}`;
  if (milestone.html_url !== expectedUrl) {
    fail("milestone URL does not match the Admin repository and milestone");
  }
  return {
    number: milestone.number,
    title: cleanString(milestone.title, "milestone title", 160),
    state: milestone.state,
    openIssues: count(milestone.open_issues, "open issue count"),
    closedIssues: count(milestone.closed_issues, "closed issue count"),
    updatedAt: normalizedTimestamp(milestone.updated_at, "milestone update time"),
    url: expectedUrl,
  };
}

export function createAdminStatusManifest({
  environment,
  generatedAt,
  repository,
  revision,
  milestones: rawMilestones,
}) {
  if (!repositoryMatches(repository)) {
    fail("repository must be an approved NJ PBS repository");
  }
  const buildRevision = cleanString(revision, "revision", 40);
  if (!/^[0-9a-f]{40}$/.test(buildRevision)) {
    fail("revision must be a full lowercase Git commit SHA");
  }
  const buildTime = normalizedTimestamp(generatedAt, "generatedAt");
  if (
    !Array.isArray(rawMilestones) ||
    rawMilestones.length === 0 ||
    rawMilestones.length > MAX_ADMIN_MILESTONES
  ) {
    fail(`milestones must contain from 1 to ${MAX_ADMIN_MILESTONES} entries`);
  }
  const milestones = rawMilestones.map(value => milestoneStatus(value, repository)).sort(
    (left, right) => left.number - right.number,
  );
  if (new Set(milestones.map(({ number }) => number)).size !== milestones.length) {
    fail("milestone numbers must be unique");
  }
  const milestone = milestones.find(
    ({ number }) => number === DEFAULT_ADMIN_MILESTONE_NUMBER,
  );
  if (!milestone) {
    fail(`milestones must include ${DEFAULT_ADMIN_MILESTONE_NUMBER}`);
  }

  return {
    schemaVersion: 2,
    status: "current",
    environment: cleanString(environment, "environment", 40),
    generatedAt: buildTime,
    refreshAfter: new Date(Date.parse(buildTime) + REFRESH_WINDOW_MS).toISOString(),
    build: {
      revision: buildRevision,
      builtAt: buildTime,
    },
    milestone,
    milestones,
  };
}

export function encodeAdminStatusManifest(manifest) {
  return Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
}

function readArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("arguments must be name and value pairs");
    }
    if (options.has(name)) fail(`${name} was given more than once`);
    options.set(name, value);
  }
  const allowed = new Set([
    "--environment",
    "--generated-at",
    "--milestones",
    "--repository",
    "--revision",
  ]);
  for (const name of options.keys()) {
    if (!allowed.has(name)) fail(`unknown argument ${name}`);
  }
  for (const name of ["--environment", "--milestones", "--repository", "--revision"]) {
    if (!options.has(name)) fail(`missing argument ${name}`);
  }
  return options;
}

function run(argv) {
  const options = readArguments(argv);
  const milestones = JSON.parse(readFileSync(options.get("--milestones"), "utf8"));
  const manifest = createAdminStatusManifest({
    environment: options.get("--environment"),
    generatedAt: options.get("--generated-at") ?? new Date().toISOString(),
    repository: options.get("--repository"),
    revision: options.get("--revision"),
    milestones,
  });
  process.stdout.write(encodeAdminStatusManifest(manifest));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin status manifest failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
