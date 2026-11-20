import { fileURLToPath } from "node:url";
import { writeFunctionsContracts } from "./lib/functions-contracts.mjs";

const count = await writeFunctionsContracts(fileURLToPath(new URL("../", import.meta.url)));
console.log(`Built ${count} Functions contracts.`);
