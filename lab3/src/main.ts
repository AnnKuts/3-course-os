import { SimulationConfig, ProcessConfig } from './types';
import { Simulation, printStats } from './simulation';

/**
 * Creates default demonstration configuration.
 *
 * Designed to demonstrate realistic virtual memory contention with:
 * - 3 concurrent processes competing for physical RAM
 * - Aggregate working set ~30-36 pages competing for 40 physical frames
 * - Round-robin CPU quantum = 20 accesses
 * - WSClock TAU = 180 accesses (spans multiple scheduling cycles to protect waiting processes)
 */
export function getDefaultConfig(): SimulationConfig {
  const processes: ProcessConfig[] = [
    {
      creationTime: 0,
      lifetime: 500,
      virtualPages: 35,
      workingSetSize: 10,
      workingSetChangeInterval: 100,
    },
    {
      creationTime: 20,
      lifetime: 500,
      virtualPages: 35,
      workingSetSize: 12,
      workingSetChangeInterval: 100,
    },
    {
      creationTime: 50,
      lifetime: 500,
      virtualPages: 35,
      workingSetSize: 10,
      workingSetChangeInterval: 100,
    },
  ];

  return {
    numPhysicalFrames: 40,
    maxConcurrentProcesses: 3,
    processes,
    timeQuantum: 20,
    tau: 180,
    totalAccesses: 1500,
    seed: 42,
    verbose: false,
    writeProbability: 0.3, // 70% reads, 30% writes per assignment
    workingSetLocality: 0.9, // 90% locality per assignment
  };
}

function main(): void {
  console.log(`========================================================================`);
  console.log(`OPERATING SYSTEMS LAB 3: Page Replacement Algorithms`);
  console.log(`Variant 3: Random vs WSClock (Working Set Clock)`);
  console.log(`========================================================================\n`);

  const config = getDefaultConfig();
  console.log(`Simulation Configuration:`);
  console.log(`- Physical frames (RAM):       ${config.numPhysicalFrames}`);
  console.log(`- Max concurrent processes:    ${config.maxConcurrentProcesses}`);
  console.log(`- Round-robin time quantum:    ${config.timeQuantum} accesses`);
  console.log(`- WSClock TAU parameter:       ${config.tau} accesses`);
  console.log(`- Total simulation accesses:   ${config.totalAccesses}`);
  console.log(`- Locality / WS proportion:    ${config.workingSetLocality * 100}%`);
  console.log(`- Write operation ratio:       ${config.writeProbability * 100}%`);
  console.log(`- Processes configured:        ${config.processes.length}\n`);

  const sim = new Simulation(config);
  const { random, wsclock } = sim.runComparison();

  printStats(random);
  printStats(wsclock);

  const diff = random.totalPageFaults - wsclock.totalPageFaults;
  const pct = random.totalPageFaults > 0
    ? ((diff / random.totalPageFaults) * 100).toFixed(1)
    : '0';

  console.log(`Summary Comparison:`);
  console.log(`- Random page faults:   ${random.totalPageFaults} (${(random.totalPageFaults / random.totalAccesses * 100).toFixed(2)}%)`);
  console.log(`- WSClock page faults:  ${wsclock.totalPageFaults} (${(wsclock.totalPageFaults / wsclock.totalAccesses * 100).toFixed(2)}%)`);
  console.log(`- Difference:           ${diff} fewer faults with WSClock (${pct}% reduction)\n`);
}

if (require.main === module) {
  main();
}
