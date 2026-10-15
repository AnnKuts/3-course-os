import { SimulationConfig } from './simulation';
import { Simulation, printStats } from './simulation';

export function getDefaultConfig(): SimulationConfig {
  return {
    numPhysicalFrames: 40,
    maxConcurrentProcesses: 3,
    processes: [
      { creationTime: 0,  lifetime: 500, virtualPages: 35, workingSetSize: 10, workingSetChangeInterval: 100 },
      { creationTime: 20, lifetime: 500, virtualPages: 35, workingSetSize: 12, workingSetChangeInterval: 100 },
      { creationTime: 50, lifetime: 500, virtualPages: 35, workingSetSize: 10, workingSetChangeInterval: 100 },
    ],
    timeQuantum: 20,
    tau: 180,
    totalAccesses: 1500,
    seed: 42,
    verbose: false,
    writeProbability: 0.3,
    workingSetLocality: 0.9,
  };
}

if (require.main === module) {
  const cfg = getDefaultConfig();
  console.log(`${'='.repeat(70)}`);
  console.log(`OS Lab 3: Page Replacement Algorithms — Variant 3: Random vs WSClock`);
  console.log(`${'='.repeat(70)}\n`);
  console.log(`Configuration:`);
  console.log(`  Physical frames:        ${cfg.numPhysicalFrames}`);
  console.log(`  Max concurrent procs:   ${cfg.maxConcurrentProcesses}`);
  console.log(`  Round-robin quantum:    ${cfg.timeQuantum} accesses`);
  console.log(`  WSClock TAU:            ${cfg.tau} accesses`);
  console.log(`  Total accesses:         ${cfg.totalAccesses}`);
  console.log(`  Locality:               ${cfg.workingSetLocality * 100}%`);
  console.log(`  Write probability:      ${cfg.writeProbability * 100}%`);
  console.log(`  Processes:              ${cfg.processes.length}\n`);

  const sim = new Simulation(cfg);
  const { random, wsclock } = sim.runComparison();
  printStats(random);
  printStats(wsclock);

  const diff = random.totalPageFaults - wsclock.totalPageFaults;
  const pct = random.totalPageFaults > 0
    ? ((diff / random.totalPageFaults) * 100).toFixed(1)
    : '0';
  console.log(`Summary:`);
  console.log(`  Random:  ${random.totalPageFaults} faults (${((random.totalPageFaults / random.totalAccesses) * 100).toFixed(2)}%)`);
  console.log(`  WSClock: ${wsclock.totalPageFaults} faults (${((wsclock.totalPageFaults / wsclock.totalAccesses) * 100).toFixed(2)}%)`);
  console.log(`  WSClock saves ${diff} faults (${pct}% reduction)\n`);
}
