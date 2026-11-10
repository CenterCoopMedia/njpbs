import assert from "node:assert/strict";
import { test } from "node:test";
import { devAccessOrigin, deploymentEmail, deploymentOwner, previewRendererBindings } from "./deployment-settings.mjs";

test("development Access requires a configured HTTPS origin before deployment", () => {
  assert.equal(devAccessOrigin({ CMS_DEV_ACCESS_ORIGIN: "https://access.example.org" }), "https://access.example.org");
  for (const value of [undefined, "", "http://access.example.org", "https://access.example.org/path",
    "https://user:password@access.example.org", "https://access.example.org?query=1", "https://access.example.org#fragment"]) {
    assert.throws(() => devAccessOrigin({ CMS_DEV_ACCESS_ORIGIN: value }), /Configure CMS_DEV_ACCESS_ORIGIN/);
  }
});

test("deployment email identities require explicit configuration", () => {
  assert.equal(deploymentEmail("CMS_DEV_EDITOR_EMAIL", { CMS_DEV_EDITOR_EMAIL: "Editor@example.org" }), "editor@example.org");
  for (const value of [undefined, "", "REPLACE_ME@example.org", "missing-domain", "user @example.org"]) {
    assert.throws(() => deploymentEmail("CMS_DEV_EDITOR_EMAIL", { CMS_DEV_EDITOR_EMAIL: value }), /Configure CMS_DEV_EDITOR_EMAIL/);
  }
});

test("full deployment requires a separately configured owner", () => {
  assert.equal(deploymentOwner({ CMS_DEPLOY_OWNER: "deploy-owner" }), "deploy-owner");
  for (const value of [undefined, "", "REPLACE_ME", "some owner", "owner@example.org", "bot[bot]"]) {
    assert.throws(() => deploymentOwner({ CMS_DEPLOY_OWNER: value }), /Configure CMS_DEPLOY_OWNER/);
  }
});

test("production renderer bindings require no development issuer", () => {
  assert.deepEqual(previewRendererBindings("production", "a".repeat(32), {}), { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) });
  assert.deepEqual(previewRendererBindings("development", "a".repeat(32), { CMS_DEV_ACCESS_ORIGIN: "https://access.example.org" }),
    { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CMS_DEV_ACCESS_ORIGIN: "https://access.example.org" });
  assert.throws(() => previewRendererBindings("development", "a".repeat(32), {}), /Configure CMS_DEV_ACCESS_ORIGIN/);
  assert.throws(() => previewRendererBindings("production", "", {}), /Configure the renderer/);
  assert.throws(() => previewRendererBindings("unknown", "a".repeat(32), {}), /Configure the renderer/);
});
