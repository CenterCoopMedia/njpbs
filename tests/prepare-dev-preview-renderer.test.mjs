import { devDeploymentEnvironment } from "./helpers/dev-deployment-config.mjs";
import { developmentInputFixture } from "./helpers/development-inputs.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDevPreviewRenderer } from '../scripts/prepare-preview-renderer.mjs';

test('dev container context renders verified source and excludes untracked files and dependencies', async () => {
  const suppliers = { ...devDeploymentEnvironment, ...developmentInputFixture, CMS_DEV_ACCESS_ORIGIN: "https://access.example.org" };
  const priorInputs = Object.fromEntries(Object.keys(suppliers).map(name => [name, process.env[name]]));
  Object.assign(process.env, suppliers);
  const directory = mkdtempSync(join(tmpdir(), 'dev-preview-process-boundary-'));
  const previousPath = process.env.PATH;
  const canary = new URL('../home5-untracked-context-canary.txt', import.meta.url);
  let prepared;
  try {
    // Fake only dependency installation at the external process boundary. Git
    // and filesystem isolation are real. #2957 defines the expected dev tuple.
    writeFileSync(join(directory, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(canary, 'fixture-untracked-never-in-image', { flag: 'wx' });
    process.env.PATH = `${directory}:${previousPath}`;
    const sha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' }).trim();
    prepared = await prepareDevPreviewRenderer(sha);
    assert.equal(execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: prepared.source, encoding: 'utf8' }).trim(), sha);
    assert.equal(existsSync(join(prepared.source, 'home5-untracked-context-canary.txt')), false);
    assert.equal(existsSync(join(prepared.source, 'node_modules')), false);
    assert.equal(existsSync(join(prepared.source, 'site/node_modules')), false);
    const config = JSON.parse(readFileSync(prepared.configPath, 'utf8'));
    assert.equal(config.name, developmentInputFixture.CMS_DEV_PREVIEW_RENDERER);
    assert.equal(config.vars.FIREBASE_PROJECT_ID, 'njpbs-site-dev');
    assert.equal(config.vars.CMS_DEPLOYMENT_ENVIRONMENT, 'development');
    assert.equal(config.vars.PREVIEW_RENDERER_SHA, sha);
    assert.equal(config.vars.PREVIEW_RENDERER_ENABLED, 'false');
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.routes, undefined);
    assert.equal(config.containers[0].image_build_context, prepared.directory);
    assert.match(readFileSync(join(prepared.directory, '.dockerignore'), 'utf8'), /source\/\*\*\/node_modules/);
  } finally {
    for (const [name, value] of Object.entries(priorInputs)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    process.env.PATH = previousPath;
    rmSync(canary, { force: true });
    if (prepared) rmSync(prepared.directory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
