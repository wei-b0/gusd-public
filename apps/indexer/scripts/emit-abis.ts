import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  gpuTokenAbi,
  gusdAbi,
  hookAbi,
  issuanceAbi,
  ledgerAbi,
  marketLiquidityAbi,
  oracleAbi,
  poolManagerAbi,
  positionManagerAbi,
  routerAbi,
  sgusdAbi,
  stableRouterAbi,
} from "../src/abis.js";

const outputDir = path.resolve(process.cwd(), "abis");
mkdirSync(outputDir, { recursive: true });

const abis = {
  gpu_token: gpuTokenAbi,
  gusd: gusdAbi,
  hook: hookAbi,
  issuance: issuanceAbi,
  ledger: ledgerAbi,
  market_liquidity: marketLiquidityAbi,
  oracle: oracleAbi,
  pool_manager: poolManagerAbi,
  position_manager: positionManagerAbi.filter((item) => item.type !== "event" || item.name !== "Transfer"),
  router: routerAbi,
  sgusd: sgusdAbi,
  stable_router: stableRouterAbi,
};

for (const [name, abi] of Object.entries(abis)) {
  writeFileSync(path.join(outputDir, `${name}.json`), `${JSON.stringify(abi, null, 2)}\n`);
}
