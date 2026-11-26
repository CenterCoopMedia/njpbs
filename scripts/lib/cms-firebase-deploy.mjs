import { stripVTControlCharacters } from "node:util";
import { repeatAfterProviderLimit } from "./firebase-provider-limit.mjs";

/**
 * The Firebase part of a CMS release: rules and indexes, then Functions.
 *
 * Functions deploy as the whole codebase first, so Firebase skips each unchanged one.
 * When a live Function that the source no longer exports is in the project, Firebase
 * asks before it deletes it and, without a terminal, stops before any change. The
 * release then names each export: Firebase considers only those, deploys every one
 * of them, and leaves the other live Functions in place. Retirement stays with the
 * receipt-scoped path (docs/cms/functions-deploy.md).
 * No call uses --force: it would delete live indexes and Functions that the source does not name.
 *
 * `deploy(args)` runs one `npx --no-install <args>` and returns { ok, log, error }.
 */
export function firebaseDeployArgs({ project, config, only }) {
  return ["firebase", "deploy", "--project", project, "--config", config, "--only", only, "--non-interactive"];
}

export function functionTargets(names, codebase) {
  if (!names.length) throw new Error("The source exports no Function");
  return names.map(name => codebase === "default" ? `functions:${name}` : `functions:${codebase}:${name}`).join(",");
}

const askedToDelete = /found in your project but do not exist in your local source code:((?:\r?\n[ \t]+\S+\([\w-]+\))+)/;

export async function deployFirebase({ project, config, dev, codebase, exported, deploy, wait, say = console.log }) {
  await repeating(dev ? "firestore:rules,firestore:indexes" : "firestore:rules,firestore:indexes,storage");
  const kept = await repeating("functions", true);
  if (kept.length) {
    say(`Live Functions that the source does not export: ${kept.join(", ")}. They stay; each export is deployed by name.`);
    await repeating(functionTargets(exported, codebase));
  }

  async function repeating(first, whole = false) {
    for (let only = first; ;) {
      const { ok, log = "", error } = await deploy(firebaseDeployArgs({ project, config, only }));
      if (ok) return [];
      const kept = [...(stripVTControlCharacters(log).match(askedToDelete)?.[1] ?? "").matchAll(/(\S+)\([\w-]+\)/g)].map(match => match[1]);
      // Firebase asks after a whole deploy planned its changes and before it makes any.
      if (whole && only === first && kept.length) return kept;
      const repeat = repeatAfterProviderLimit(log, only);
      if (!repeat) throw error;
      ({ only } = repeat);
      say(`${repeat.error}\nWaiting 60 s for the provider's minute, then deploying ${repeat.left.length ? repeat.left.join(", ") : "everything again"}`);
      await wait(60_000);
    }
  }
}
