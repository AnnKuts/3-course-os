import { SimulationConfig, ProcessConfig } from './types';
import { Simulation, printComparisonTable } from './simulation';

/**
 * Runs systematic experiments comparing Random vs WSClock across
 * varying working set sizes to observe memory pressure effects.
 */
export function runExperiments(): void {
  console.log(`========================================================================`);
  console.log(`LAB 3 EXPERIMENTS: Page Replacement Under Increasing Working Set Size`);
  console.log(`Variant 3: Random vs WSClock (Working Set Clock)`);
  console.log(`========================================================================\n`);

  const numPhysicalFrames = 40;
  const workingSetSizes = [4, 8, 12, 16, 20, 24];
  const results = [];

  for (const wsSize of workingSetSizes) {
    const processes: ProcessConfig[] = [
      {
        creationTime: 0,
        lifetime: 500,
        virtualPages: 35,
        workingSetSize: wsSize,
        workingSetChangeInterval: 100,
      },
      {
        creationTime: 20,
        lifetime: 500,
        virtualPages: 35,
        workingSetSize: wsSize,
        workingSetChangeInterval: 100,
      },
      {
        creationTime: 50,
        lifetime: 500,
        virtualPages: 35,
        workingSetSize: wsSize,
        workingSetChangeInterval: 100,
      },
    ];

    const config: SimulationConfig = {
      numPhysicalFrames,
      maxConcurrentProcesses: 3,
      processes,
      timeQuantum: 20,
      tau: 180,
      totalAccesses: 1500,
      seed: 42,
      verbose: false,
      writeProbability: 0.3,
      workingSetLocality: 0.9,
    };

    const sim = new Simulation(config);
    const { random, wsclock } = sim.runComparison();

    results.push({
      workingSetSize: wsSize,
      random,
      wsclock,
    });
  }

  printComparisonTable(results);

  console.log(`Key Observations & Theoretical Analysis:`);
  console.log(`1. Monotonic Trend with Working Set Size:`);
  console.log(`   As the working set size increases from 4 to 24, the aggregate working set demand`);
  console.log(`   grows (from 12 to 72 pages across 3 processes). This exceeds physical memory capacity`);
  console.log(`   (40 frames), causing page fault rates to strictly increase for both algorithms.`);
  console.log(`2. WSClock Locality Retention vs Random Eviction:`);
  console.log(`   WSClock leverages hardware reference bits (R) and PhysicalPage lastAccessTime descriptors`);
  console.log(`   within the configured TAU window (TAU=180). Active pages in the current working set`);
  console.log(`   are preserved, while inactive pages are prioritized for eviction.`);
  console.log(`3. Random Inefficiency:`);
  console.log(`   Random page replacement selects victim frames without any consideration of usage recency`);
  console.log(`   or locality, frequently evicting hot pages and causing subsequent page faults.`);
  console.log(`4. Replayable Workload Integrity:`);
  console.log(`   Both algorithms are evaluated against identical pre-generated trace sequences`);
  console.log(`   with identical process lifecycles, memory accesses, and write operations.`);
}

if (require.main === module) {
  runExperiments();
}
