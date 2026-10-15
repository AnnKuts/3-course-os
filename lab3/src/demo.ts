import { SimulationConfig } from './simulation';
import { Simulation, printStats } from './simulation';

const cfg: SimulationConfig = {
  numPhysicalFrames: 6,
  maxConcurrentProcesses: 2,
  processes: [
    { creationTime: 0,  lifetime: 30, virtualPages: 10, workingSetSize: 4, workingSetChangeInterval: 15 },
    { creationTime: 10, lifetime: 30, virtualPages: 10, workingSetSize: 4, workingSetChangeInterval: 15 },
  ],
  timeQuantum: 10,
  tau: 15,
  totalAccesses: 60,
  seed: 12345,
  verbose: true,
  writeProbability: 0.35,
  workingSetLocality: 0.9,
};

console.log(`${'='.repeat(70)}`);
console.log(`OS Lab 3 — Verbose Demo: Random vs WSClock`);
console.log(`  Frames: ${cfg.numPhysicalFrames}  |  Processes: 2 (10 virt. pages each)`);
console.log(`  WS size: 4  |  TAU: ${cfg.tau}  |  Quantum: ${cfg.timeQuantum}  |  Accesses: ${cfg.totalAccesses}`);
console.log(`${'='.repeat(70)}\n`);

const sim = new Simulation(cfg);
const trace = sim.generateWorkload();
console.log(`\nGenerated ${trace.accesses.length} accesses across ${trace.processConfigs.length} processes.\n`);

console.log(`\n>>> PHASE 1: WSClock <<<\n`);
const wsStats = sim.runWithWorkload('wsclock', trace);
printStats(wsStats);

console.log(`\n>>> PHASE 2: Random <<<\n`);
const rndStats = sim.runWithWorkload('random', trace);
printStats(rndStats);

console.log(`${'='.repeat(70)}`);
console.log(`DEMO SUMMARY`);
console.log(`  Accesses:            ${trace.accesses.length}`);
console.log(`  WSClock page faults: ${wsStats.totalPageFaults} (${((wsStats.totalPageFaults / trace.accesses.length) * 100).toFixed(1)}%)`);
console.log(`  Random  page faults: ${rndStats.totalPageFaults} (${((rndStats.totalPageFaults / trace.accesses.length) * 100).toFixed(1)}%)`);
console.log(`${'='.repeat(70)}`);
