// Deterministic multi-client simulator: N clients, in-memory server, seeded faults.
export { checkInvariants } from "./invariants.ts";
export { SimFs, type Clobber } from "./fs.ts";
export { Scheduler } from "./scheduler.ts";
export { NetError, simulate, World, type SimConfig, type SimResult } from "./world.ts";
