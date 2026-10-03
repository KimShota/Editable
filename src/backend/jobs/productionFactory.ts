import type { Storage } from "../storage";
import type { ProductionOps } from "./deps";
import { cliProduction } from "./productionCli";
import { stubProduction } from "./stubProduction";

/** The production operations, real or stubbed (KATALAB_STUB_PROVIDERS=1).
 *  Its own small module so a route that only needs a price check does not
 *  pull the whole worker (the analyzer, the Anthropic client) into its
 *  bundle: jobs/registry.ts imports this, not the other way round. */
export const productionOps = (storage: Storage): ProductionOps => (process.env.KATALAB_STUB_PROVIDERS === "1" ? stubProduction(storage) : cliProduction());
