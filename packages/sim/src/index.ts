// Deterministic multi-client simulator: N clients, in-memory server, seeded faults.
export { checkInvariants, checkObserved, type Observed } from "./invariants.ts";
export { SimFs, type Clobber } from "./fs.ts";
export { Scheduler } from "./scheduler.ts";
export { hashSync } from "./hash.ts";
export { NetError, simulate, World, type SimConfig, type SimResult, type SimStore } from "./world.ts";
