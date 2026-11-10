#!/usr/bin/env node
import { readPublisherBudget, readPublisherFleetBudget } from "./lib/cloud-publisher-budget.mjs";
const [environment, applicationId, start, end, rawOther, ...extra] = process.argv.slice(2);
try {
  if (extra.length || !/^\d+$/.test(rawOther ?? "")) throw new Error();
  let credential = "";
  for await (const chunk of process.stdin) { credential += chunk; if (credential.length > 1024) throw new Error(); }
  const common = { start, end, otherMonthlyCents: Number(rawOther), token: credential.trim() };
  const ids = applicationId?.split(",");
  if (environment === "combined" && ids?.length !== 2) throw new Error();
  const result = environment === "combined"
    ? await readPublisherFleetBudget({ ...common, productionApplicationId: ids[0], developmentApplicationId: ids[1] })
    : await readPublisherBudget({ ...common, environment, applicationId });
  credential = "";
  console.log(JSON.stringify(result));
  // Review signals never stop accepted publication or modify admission.
  process.exitCode = result.reviewRequired ? 2 : 0;
} catch {
  console.error("Cloud publisher billing readback is unavailable");
  process.exitCode = 1;
}
