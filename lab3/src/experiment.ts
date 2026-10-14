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
}

if (require.main === module) {
  runExperiments();
}
