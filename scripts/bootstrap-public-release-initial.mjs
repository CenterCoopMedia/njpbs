/** Node22+tsx process boundary. Require keeps the repository's mixed CJS/ESM
 * TypeScript wrappers under one loader; no provider/configuration is installed. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { runInitialBootstrapOperator } = require("../site/scripts/bootstrap-public-release-initial.ts");
const { BootstrapReadBudgetError } = require("../site/scripts/public-release-bootstrap-read-budget.ts");
runInitialBootstrapOperator(process.argv.slice(2)).catch(error => {
  if (error instanceof BootstrapReadBudgetError) process.stdout.write(`${JSON.stringify({ measurement: error.measurement }, null, 2)}\n`);
  process.stderr.write("Initial public release selector was refused\n"); process.exitCode = 1;
});
