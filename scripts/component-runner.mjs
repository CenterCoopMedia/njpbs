#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEPLOYMENT_COMPONENTS } from "./lib/deployment-components.mjs";
import { ComponentReceiptError, fingerprintPaths, requireSha } from "./lib/cms-component-receipt.mjs";

// This dispatcher supplies neither credentials nor authorization. The existing
// source gates, workflow permission boundaries, locks and adapter checks still
// apply. Never interpret a plan or command exit as a completed deployment.
export async function runComponentOperation(component, operation, argv = [], load = url => import(url)) {
  const row = Object.hasOwn(DEPLOYMENT_COMPONENTS, component) && DEPLOYMENT_COMPONENTS[component];
  const adapter = row && Object.hasOwn(row.operations, operation) && row.operations[operation];
  if (!adapter) throw new Error("Unsupported component operation");
  if (operation === "inputs") {
    if (!Array.isArray(argv) || argv.length !== 1) throw new Error("Input inspection requires one full source SHA");
    const sourceSha = requireSha(argv[0], "Source SHA");
    return { component, sourceSha, inputFingerprint: await fingerprintPaths(sourceSha, row.inputPaths) };
  }
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string")
    || argv.some(value => value === "--component" || value.startsWith("--component="))
    || (!adapter.args.length && argv.length)) throw new Error("Invalid component arguments");
  const args = [...adapter.args, ...argv];
  const { main } = await load(new URL(adapter.module, import.meta.url).href);
  return main(args);
}

// Firestore's gRPC status carries its message in `details`, Firebase Admin in
// `errorInfo.message`. Quoted text, addresses and long tokens are still removed.
const scrubbed = message => String(message).replace(/(["'`]).*?\1/g, "<value>").replace(/\S+@\S+|https?:\/\/\S+/g, "<value>")
  .replace(/[A-Za-z0-9_+/=.-]{24,}/g, "<value>").replace(/\s+/g, " ").trim().slice(0, 200);

export function componentFailureDiagnostic(error) {
  // Deliberate adapter refusals are shown whole. Any other error shows only its
  // class and code, plus the structured message of a Firestore or Firebase
  // error, never its raw text: native parse and subprocess messages can contain credentials or
  // secret-derived inputs.
  if (error instanceof ComponentReceiptError || ["CmsSmokeError", "FunctionsDeployInventoryError", "FunctionsConfigurationError"].includes(error?.name)) {
    return error.message;
  }
  const name = /^[A-Za-z]{1,40}$/.test(error?.name ?? "") ? error.name : "unknown";
  const code = Number.isSafeInteger(error?.code) || /^[A-Za-z0-9/_-]{1,60}$/.test(error?.code ?? "") ? error.code : null;
  const structured = Number.isSafeInteger(error?.code) ? error.details : /^Firebase[A-Za-z]*Error$/.test(name) ? error.errorInfo?.message : null;
  return `Component operation did not complete: ${name}${code === null ? "" : ` code ${code}`}` +
    (typeof structured === "string" && structured ? `: ${scrubbed(structured)}` : "");
}

export async function main(argv = process.argv.slice(2)) {
  const [component, operation, ...args] = argv;
  const result = await runComponentOperation(component, operation, args);
  if (operation === "inputs") process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${componentFailureDiagnostic(error)}\n`);
    process.exitCode = 1;
  });
}
