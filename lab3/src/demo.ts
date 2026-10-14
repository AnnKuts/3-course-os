import { SimulationConfig, ProcessConfig } from './types';
import { Simulation, printStats } from './simulation';

/**
 * Verbose Demonstration Script for Operating Systems Lab 3
 * Variant 3: Random vs WSClock (Working Set Clock)
 *
 * Runs a compact, human-readable trace (60 accesses, 6 frames, 2 processes)
 * with verbose logging enabled to clearly illustrate:
 *   1. Process lifecycle (creation, round-robin scheduling, termination)
 *   2. MMU page fault detection (P = 0)
 *   3. Free frame allocation vs victim eviction
 *   4. WSClock circular scan: R=1 bit inspection, clearing R, updating lastAccessTime
 *   5. Age evaluation (currentTime - lastAccessTime > TAU)
 *   6. Clean eviction vs dirty write-back to simulated BackingStore
 *   7. Three-way page load classification (first-time, clean reload, backing-store reload)
 */
function runDemo(): void {
  console.log('='.repeat(80));
  console.log('OS LAB 3: VERBOSE DEMONSTRATION');
  console.log('Variant 3: Random vs WSClock (Working Set Clock)');
  console.log('='.repeat(80));
  console.log('Trace Parameters:');
  console.log('  - Physical Frames (RAM):  6 frames');
  console.log('  - Processes:              2 processes (10 virtual pages each)');
  console.log('  - Working Set Size:       4 pages per process');
  console.log('  - WSClock TAU Window:     15 memory accesses');
  console.log('  - Round-robin Quantum:    10 accesses');
  console.log('  - Total Trace Accesses:   60 accesses');
  console.log('  - Verbose Output:         ENABLED');
  console.log('='.repeat(80));

  const processes: ProcessConfig[] = [
    {
      creationTime: 0,
      lifetime: 30,
      virtualPages: 10,
      workingSetSize: 4,
      workingSetChangeInterval: 15,
    },
    {
      creationTime: 10,
      lifetime: 30,
      virtualPages: 10,
      workingSetSize: 4,
      workingSetChangeInterval: 15,
    },
  ];

  const config: SimulationConfig = {
    numPhysicalFrames: 6,
    maxConcurrentProcesses: 2,
    processes,
    timeQuantum: 10,
    tau: 15,
    totalAccesses: 60,
    seed: 12345,
    verbose: true,
    writeProbability: 0.35,
    workingSetLocality: 0.9,
    debugMode: true,
  };

  const sim = new Simulation(config);

  console.log('\n>>> PHASE 1: GENERATING DETERMINISTIC WORKLOAD TRACE <<<\n');
  const trace = sim.generateWorkload();
  console.log(`Generated ${trace.accesses.length} memory accesses across ${processes.length} processes.\n`);

  console.log('\n>>> PHASE 2: RUNNING WSCLOCK WITH STEP-BY-STEP VERBOSE LOGGING <<<\n');
  const wsclockStats = sim.runWithWorkload('wsclock', trace);
  printStats(wsclockStats);

  console.log('\n>>> PHASE 3: RUNNING RANDOM REPLACEMENT WITH IDENTICAL WORKLOAD <<<\n');
  const randomStats = sim.runWithWorkload('random', trace);
  printStats(randomStats);

  console.log('\n' + '='.repeat(80));
  console.log('DEMONSTRATION SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total Accesses:         ${trace.accesses.length}`);
  console.log(`WSClock Page Faults:    ${wsclockStats.totalPageFaults} (${((wsclockStats.totalPageFaults / trace.accesses.length) * 100).toFixed(1)}%)`);
  console.log(`Random Page Faults:     ${randomStats.totalPageFaults} (${((randomStats.totalPageFaults / trace.accesses.length) * 100).toFixed(1)}%)`);
  console.log(`WSClock Evictions:      ${wsclockStats.totalEvictions} (Dirty write-backs: ${wsclockStats.dirtyWriteBacks})`);
  console.log(`Random Evictions:       ${randomStats.totalEvictions} (Dirty write-backs: ${randomStats.dirtyWriteBacks})`);
  console.log('Three-way Load Breakdown Verification:');
  console.log(`  WSClock: First-time(${wsclockStats.firstTimeLoads}) + Clean(${wsclockStats.cleanReloads}) + BackingStore(${wsclockStats.backingStoreReloads}) = ${wsclockStats.firstTimeLoads + wsclockStats.cleanReloads + wsclockStats.backingStoreReloads} (Faults = ${wsclockStats.totalPageFaults})`);
  console.log(`  Random:  First-time(${randomStats.firstTimeLoads}) + Clean(${randomStats.cleanReloads}) + BackingStore(${randomStats.backingStoreReloads}) = ${randomStats.firstTimeLoads + randomStats.cleanReloads + randomStats.backingStoreReloads} (Faults = ${randomStats.totalPageFaults})`);
  console.log('='.repeat(80));
}

runDemo();
