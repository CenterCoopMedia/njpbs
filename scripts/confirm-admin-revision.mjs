#!/usr/bin/env node
const expected = process.env.DEPLOY_SHA;
if (!/^[0-9a-f]{40}$/.test(expected ?? "")) {
  throw new Error("DEPLOY_SHA is not a full revision");
}

let lastError = "Admin status was not read";
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const response = await fetch("https://admin.njpbs.org/admin-status.json", {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      lastError = `Admin status HTTP ${response.status}`;
    } else {
      const body = await response.json();
      const revision = body?.build?.revision;
      const schema = body?.schemaVersion;
      if ((schema === 1 || schema === 2) && body?.environment === "Production"
        && body?.status === "current" && revision === expected) {
        process.stdout.write(`live Admin revision ${revision}\n`);
        process.exit(0);
      }
      lastError = `live Admin revision ${revision || "missing"} != ${expected}`;
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Admin status could not be read";
  }
  if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 5000));
}
throw new Error(lastError);
