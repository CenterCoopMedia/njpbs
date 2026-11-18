// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Env = Record<string, unknown>;
type Step = { name?: string; id?: string; if?: string | boolean; run?: string; uses?: string; with?: Env; env?: Env };
type Job = { environment?: string | { name: string }; env?: Env; if?: string | boolean; steps?: Step[] };
type Workflow = { env?: Env; jobs: Record<string, Job> };
type Manifest = Record<string, string[]>;
type Names = { vars: Set<string>; secrets: Set<string> };

const read = (path: string) => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const json = <T>(path: string): T => JSON.parse(read(path));
const targetWorkflows = ["cms-staging-deploy", "publisher-image"];
const workflows = targetWorkflows.map(name => [name, parse(read(".github/workflows/" + name + ".yml")) as Workflow] as const);
const manifest = json<Manifest>("config/step-inputs.json");
const namePattern = /^[A-Z_][A-Z0-9_]*$/;
const scriptPattern = /(?:\.github\/|site\/)?scripts\/[A-Za-z0-9_.-]+\.(?:mjs|cjs|ts|js|py|sh)|agents\/vmix\/[A-Za-z0-9_.-]+\.mjs/g;
const scriptCalls = (run: string) => Array.from(run.matchAll(scriptPattern));

function sourceRequirements(source: string): Set<string> {
  // These explicit forms are shared by entry scripts. Mode-dependent reads
  // and requirements reached through other helpers get an explicit audit.
  const code = source.replace(/^\s*\/\/[^\n]*$/gm, "");
  const required = new Set<string>();
  for (const pattern of [
    /\b(?:requiredEnv|requireEnv|mustEnv)\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
    /\bif\s*\(\s*!\s*(?:process\.env|env)\.([A-Z_][A-Z0-9_]*)\s*\)\s*(?:\{\s*)?throw\b/g,
  ]) {
    for (const [, name] of code.matchAll(pattern)) required.add(name);
  }
  if (code.includes('import { cloudflareAccount } from "./cloudflare-account.mjs"') &&
    /\bconst cloudflareAccountId = cloudflareAccount\(\);/.test(code)) {
    required.add("CLOUDFLARE_ACCOUNT_ID");
  }
  return required;
}

const unlistedRequirements = (source: string, declared: string[]) =>
  [...sourceRequirements(source)].filter(name => !declared.includes(name)).sort();

function jobEnvironment(job: Job): string {
  return typeof job.environment === "string" ? job.environment : job.environment?.name ?? "";
}

function envNames(...levels: Array<Env | undefined>): Set<string> {
  return new Set(levels.flatMap(level => Object.keys(level ?? {})));
}

function beforeCallExports(run: string) {
  return Array.from(run.matchAll(/^\s*export[ \t]+([^\n;]+)/gm)).flatMap(([, entries]) =>
    entries.split(/\s+/).map(entry => entry.split("=", 1)[0]).filter(name => namePattern.test(name)));
}

function priorStepExports(step: Step): string[] {
  const found = (step.run ?? "").split("\n").filter(line => /\b(?:GITHUB_ENV|github\.env)\b/.test(line))
    .flatMap(line => Array.from(line.matchAll(/\b([A-Z_][A-Z0-9_]*)=/g), ([, name]) => name));
  // Google auth exports the filename for later steps with the defaults used here.
  const enabled = (input: string) => ![false, "false"].includes(step.with?.[input] as boolean | string);
  if (step.uses?.startsWith("google-github-actions/auth@") &&
    enabled("export_environment_variables") && enabled("create_credentials_file")) {
    found.push("GOOGLE_APPLICATION_CREDENTIALS");
  }
  return found;
}

function stepWiringGaps(definition: Workflow, contract: Manifest): string[] {
  const gaps: string[] = [];
  for (const [jobId, job] of Object.entries(definition.jobs)) {
    const earlier = new Set<string>();
    for (const [index, step] of (job.steps ?? []).entries()) {
      const run = step.run ?? "";
      for (const match of scriptCalls(run)) {
        const script = match[0];
        const supplied = envNames(definition.env, job.env, step.env);
        for (const name of earlier) supplied.add(name);
        for (const name of beforeCallExports(run.slice(0, match.index))) supplied.add(name);
        for (const name of contract[script] ?? []) {
          if (!supplied.has(name)) gaps.push(jobId + " / " + (step.name ?? step.id ?? index + 1) + " / " + name);
        }
      }
      if (!/^(?:\$\{\{\s*)?false(?:\s*\}\})?$/i.test(String(step.if ?? "").trim())) {
        for (const name of priorStepExports(step)) earlier.add(name);
      }
    }
  }
  return [...new Set(gaps)];
}

const reference = /^(vars|secrets)\s*(?:\.\s*([a-z_]\w*)|\[\s*'([a-z_]\w*)'\s*\])$/i;
const tokens = /\b(?:vars|secrets)\s*(?:\.\s*[a-z_]\w*|\[\s*'[a-z_]\w*'\s*\])|'(?:[^']|'')*'/gi;
const defaultLiteral = /^(?:'(?:[^']|'')*'|true|false|null|-?\d+(?:\.\d+)?)$/i;

function referenceGaps(expression: string, available: Names): string[] {
  const parts = expression.split(/\|\|(?=(?:[^']*'[^']*')*[^']*$)/).map(term => term.trim());
  const supplied = (ref: string) => {
    const match = reference.exec(ref);
    return match && available[match[1].toLowerCase() as keyof Names].has((match[2] ?? match[3]).toUpperCase());
  };
  if (parts.length > 1 && parts.every(part => reference.test(part) || defaultLiteral.test(part))) {
    return parts.some(part => supplied(part) || defaultLiteral.test(part)) ? [] : [parts.join(" || ")];
  }
  return (expression.match(tokens) ?? []).filter(ref => reference.test(ref) && !supplied(ref));
}

function expressionText(value: unknown): string[] {
  if (typeof value === "string") {
    return Array.from(value.matchAll(/\$\{\{([\s\S]*?)\}\}/g), ([, expression]) => expression);
  }
  return value && typeof value === "object" ? Object.values(value).flatMap(expressionText) : [];
}

const policy = json<Record<string, { secrets: string[] }>>(".github/deploy-environments.json");
const suppliers = json<{ inputs: { names: string[]; suppliers: string[] }[] }>("config/configuration-inputs.json");
const variables = new Set(suppliers.inputs.filter(group => group.suppliers.includes("github-variable")).flatMap(group => group.names));

describe("release step inputs", () => {
  it("inventories every named entry script and its explicit required reads", () => {
    const seen = new Set(workflows.flatMap(([, workflow]) => Object.values(workflow.jobs)
      .flatMap(job => (job.steps ?? []).flatMap(step => scriptCalls(step.run ?? "").map(match => match[0])))));
    expect(Object.keys(manifest).sort()).toEqual([...seen].sort());
    for (const [script, names] of Object.entries(manifest)) {
      expect(names, script).toEqual([...new Set(names)].sort());
      expect(names.every(name => namePattern.test(name)), script).toBe(true);
      const source = read(script);
      expect(unlistedRequirements(source, names), script).toEqual([]);
    }
  });

  it("detects a new required script input missing from the contract", () => {
    expect(unlistedRequirements('if (!process.env.NEW_REQUIRED) throw new Error("Missing input");', [])).toEqual(["NEW_REQUIRED"]);
    const path = "site/scripts/deploy-cms-preview-cloud.ts";
    expect(unlistedRequirements(read(path), manifest[path].filter(name => name !== "CLOUDFLARE_ACCOUNT_ID")))
      .toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  for (const [name, workflow] of workflows) {
    it("wires declared inputs for " + name, () => {
      expect(stepWiringGaps(workflow, manifest)).toEqual([]);
    });

    it("declares the referenced suppliers for " + name, () => {
      const missing = Object.entries(workflow.jobs).flatMap(([id, job]) => {
        const names = { vars: variables, secrets: new Set(["GITHUB_TOKEN", ...(policy[jobEnvironment(job)]?.secrets ?? [])]) };
        const bareConditions = [job.if, ...(job.steps ?? []).map(step => step.if)]
          .filter((value): value is string => typeof value === "string" && !value.includes("${{"));
        const expressions = [...expressionText([workflow.env, job]), ...bareConditions];
        return expressions.flatMap(expression => referenceGaps(expression, names)).map(ref => id + " / " + ref);
      });
      expect([...new Set(missing)]).toEqual([]);
    });
  }

  it("names the missing Cloudflare account on the old preview pause step", () => {
    const old = structuredClone(workflows[0][1]);
    const pause = old.jobs.firebase.steps?.find(step => step.name === "Pause cloud preview admission before changing Functions");
    expect(pause?.env?.CLOUDFLARE_ACCOUNT_ID).toBeDefined();
    delete pause?.env?.CLOUDFLARE_ACCOUNT_ID;
    expect(stepWiringGaps(old, manifest)).toContain(
      "firebase / Pause cloud preview admission before changing Functions / CLOUDFLARE_ACCOUNT_ID");
  });

  it("separates publisher image mode inputs at their invocation sites", () => {
    const job = workflows[1][1].jobs.image;
    for (const [mode, input] of [
      ["verify", "GH_TOKEN"], ["prepare", "PUBLISHER_PUBLIC_VARS_JSON"], ["image", "CLOUDFLARE_API_TOKEN"],
    ]) {
      const step = job.steps?.find(step => step.run?.endsWith("publisher-image.mjs " + mode));
      expect(step?.env?.[input], mode).toBeDefined();
    }
  });

  it("accepts a supplied variable or literal fallback and reports an unresolved reference", () => {
    const available = { vars: new Set(["A"]), secrets: new Set<string>() };
    expect(referenceGaps("vars.A || secrets.A", available)).toEqual([]);
    expect(referenceGaps("secrets.OPTIONAL || 'safe || default'", available)).toEqual([]);
    expect(referenceGaps("vars.ABSENT || secrets.ABSENT", available)).toEqual(["vars.ABSENT || secrets.ABSENT"]);
  });
});
