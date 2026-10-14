import {
  SimulationConfig,
  SimulationStats,
  ProcessStats,
  ProcessConfig,
  ReplacementAlgorithm,
  AccessType,
} from './types';
import { Kernel } from './kernel';
import { MMU } from './mmu';
import { Process } from './process';
import { Logger } from './logger';
import { SeededRNG } from './rng';
import { RandomReplacement } from './randomReplacement';
import { WSClockReplacement } from './wsclockReplacement';
import { ReplacementStrategy } from './replacementStrategy';

/**
 * An individual memory access record in the replayable trace.
 */
export interface TraceAccess {
  time: number;
  pid: number;
  virtualPage: number;
  accessType: AccessType;
}

/**
 * Complete replayable workload trace.
 * Guarantees that Random and WSClock are evaluated against the EXACT same sequence.
 */
export interface WorkloadTrace {
  /** Ordered list of process configurations with assigned PIDs */
  processConfigs: Array<{ pid: number; config: ProcessConfig }>;
  /** Sequence of memory accesses */
  accesses: TraceAccess[];
  /** Simulation time at which each process finishes its lifetime */
  terminationTimes: Map<number, number>;
}

/**
 * Simulation orchestrator.
 */
export class Simulation {
  private readonly config: SimulationConfig;
  private readonly logger: Logger;

  constructor(config: SimulationConfig) {
    this.config = config;
    this.logger = new Logger(config.verbose);
  }

  /**
   * Generate a completely deterministic, replayable workload trace.
   *
   * Simulates round-robin process scheduling, dynamic process arrival,
   * working set evolution, and process termination.
   */
  generateWorkload(): WorkloadTrace {
    const rng = new SeededRNG(this.config.seed);

    // Sort process configs by creation time
    const sortedConfigs = this.config.processes
      .map((cfg, index) => ({ cfg, originalIndex: index }))
      .sort((a, b) => a.cfg.creationTime - b.cfg.creationTime);

    const processMap = new Map<number, Process>();
    const processConfigs: Array<{ pid: number; config: ProcessConfig }> = [];
    const terminationTimes = new Map<number, number>();
    const accesses: TraceAccess[] = [];

    let nextPid = 1;
    let nextArrivalIdx = 0;
    const readyQueue: Process[] = [];

    let currentTime = 0;
    let currentProcessIndex = 0;
    let currentQuantumRemaining = 0;

    while (currentTime < this.config.totalAccesses) {
      // 1. Admit newly arriving processes whose creationTime <= currentTime
      while (
        nextArrivalIdx < sortedConfigs.length &&
        sortedConfigs[nextArrivalIdx].cfg.creationTime <= currentTime
      ) {
        // Enforce max concurrent processes
        const activeCount = readyQueue.filter((p) => !p.terminated).length;
        if (activeCount < this.config.maxConcurrentProcesses) {
          const item = sortedConfigs[nextArrivalIdx];
          const pid = nextPid++;
          const processRng = new SeededRNG(rng.getState());
          rng.next();

          const proc = new Process(
            pid,
            item.cfg,
            processRng,
            this.config.writeProbability,
            this.config.workingSetLocality
          );

          processMap.set(pid, proc);
          processConfigs.push({ pid, config: item.cfg });
          readyQueue.push(proc);
          nextArrivalIdx++;
        } else {
          // System at capacity; wait for next cycle
          break;
        }
      }

      // Filter out terminated processes
      const activeProcesses = readyQueue.filter((p) => !p.terminated);

      if (activeProcesses.length === 0) {
        if (nextArrivalIdx < sortedConfigs.length) {
          // Fast-forward to next arrival time
          currentTime = sortedConfigs[nextArrivalIdx].cfg.creationTime;
          continue;
        } else {
          // No more processes left
          break;
        }
      }

      // 2. Schedule next process (Round-Robin)
      if (currentQuantumRemaining <= 0 || currentProcessIndex >= activeProcesses.length) {
        currentProcessIndex = currentProcessIndex % activeProcesses.length;
        currentQuantumRemaining = this.config.timeQuantum;
      }

      const currentProcess = activeProcesses[currentProcessIndex];

      // 3. Generate memory access for current process
      currentProcess.checkWorkingSetChange();
      const access = currentProcess.generateAccess();

      accesses.push({
        time: currentTime,
        pid: currentProcess.pid,
        virtualPage: access.virtualPage,
        accessType: access.type,
      });

      currentProcess.recordAccess();
      currentQuantumRemaining--;
      currentTime++;

      // 4. Check if process completed its lifetime
      if (currentProcess.isFinished()) {
        currentProcess.terminated = true;
        terminationTimes.set(currentProcess.pid, currentTime);
        currentQuantumRemaining = 0;
        currentProcessIndex = currentProcessIndex % Math.max(1, activeProcesses.length - 1);
      } else if (currentQuantumRemaining <= 0) {
        currentProcessIndex = (currentProcessIndex + 1) % activeProcesses.length;
      }
    }

    return {
      processConfigs,
      accesses,
      terminationTimes,
    };
  }

  /**
   * Execute the simulation with a specified replacement algorithm using the workload trace.
   */
  runWithWorkload(
    algorithm: ReplacementAlgorithm,
    workload: WorkloadTrace
  ): SimulationStats {
    const mmu = new MMU();
    let strategy: ReplacementStrategy;

    if (algorithm === 'random') {
      // Seeded RNG dedicated to algorithm choices (independent of workload seed)
      strategy = new RandomReplacement(new SeededRNG(this.config.seed + 1000));
    } else {
      strategy = new WSClockReplacement(this.config.tau);
    }

    const kernel = new Kernel(
      this.config.numPhysicalFrames,
      strategy,
      this.logger,
      mmu
    );

    // Instantiate process state for this run
    const processMap = new Map<number, Process>();
    const processStatsMap = new Map<number, ProcessStats>();

    for (const { pid, config } of workload.processConfigs) {
      const dummyRng = new SeededRNG(0);
      const proc = new Process(pid, config, dummyRng, 0, 0);
      processMap.set(pid, proc);
      processStatsMap.set(pid, {
        pid,
        totalAccesses: 0,
        pageFaults: 0,
        pagesAllocated: 0,
      });
    }

    const createdPids = new Set<number>();
    const terminatedPids = new Set<number>();

    // Replay the workload trace
    for (const access of workload.accesses) {
      const proc = processMap.get(access.pid);
      if (!proc) continue;

      // Log process arrival on first access
      if (!createdPids.has(access.pid)) {
        createdPids.add(access.pid);
        this.logger.event(
          `[t=${access.time}] Process PID=${proc.pid} started ` +
          `(${proc.virtualPages} virtual pages, lifetime=${proc.lifetime})`
        );
      }

      // Memory access
      const pageFault = kernel.handleMemoryAccess(
        proc,
        access.virtualPage,
        access.accessType,
        access.time
      );

      proc.recordAccess();
      const stats = processStatsMap.get(access.pid)!;
      stats.totalAccesses++;
      if (pageFault) {
        stats.pageFaults++;
      }

      if (this.config.verbose) {
        this.logger.debug(
          `[t=${access.time}] PID=${access.pid} ${access.accessType} VP=${access.virtualPage}` +
          (pageFault ? ' [PAGE FAULT]' : '')
        );
      }

      // Check if process finished at this time
      const termTime = workload.terminationTimes.get(access.pid);
      if (termTime !== undefined && access.time + 1 >= termTime && !terminatedPids.has(access.pid)) {
        terminatedPids.add(access.pid);
        kernel.terminateProcess(proc);
      }
    }

    // Clean up any remaining processes that did not reach their end time
    for (const [pid, proc] of processMap) {
      if (createdPids.has(pid) && !terminatedPids.has(pid)) {
        terminatedPids.add(pid);
        kernel.terminateProcess(proc);
      }
    }

    // Validate system invariants
    const invariantErrors = kernel.validateInvariants();
    if (invariantErrors.length > 0) {
      this.logger.warn('Simulation finished with invariant violations:');
      for (const err of invariantErrors) {
        this.logger.warn(`  - ${err}`);
      }
    }

    return {
      algorithmName: strategy.name,
      config: this.config,
      totalAccesses: workload.accesses.length,
      totalPageFaults: kernel.totalPageFaults,
      totalEvictions: kernel.totalEvictions,
      dirtyWriteBacks: kernel.dirtyWriteBacks,
      firstTimeLoads: kernel.firstTimeLoads,
      backingStoreReloads: kernel.backingStoreReloads,
      perProcessStats: processStatsMap,
    };
  }

  /**
   * Run comparison between Random and WSClock on the identical workload.
   */
  runComparison(): { random: SimulationStats; wsclock: SimulationStats } {
    this.logger.info('=== Generating Deterministic Workload ===');
    const workload = this.generateWorkload();
    this.logger.info(`Workload generated: ${workload.accesses.length} memory accesses across ${workload.processConfigs.length} processes.\n`);

    this.logger.info('=== Executing Simulation: Random Replacement ===');
    const randomStats = this.runWithWorkload('random', workload);

    this.logger.info('\n=== Executing Simulation: WSClock Replacement ===');
    const wsclockStats = this.runWithWorkload('wsclock', workload);

    return { random: randomStats, wsclock: wsclockStats };
  }
}

/**
 * Formatted printer for single simulation run.
 */
export function printStats(stats: SimulationStats): void {
  const faultRate = stats.totalAccesses > 0
    ? ((stats.totalPageFaults / stats.totalAccesses) * 100).toFixed(2)
    : '0.00';

  console.log(`\n============================================================`);
  console.log(`Algorithm:                ${stats.algorithmName}`);
  console.log(`============================================================`);
  console.log(`Physical Frames:          ${stats.config.numPhysicalFrames}`);
  console.log(`Total Memory Accesses:    ${stats.totalAccesses}`);
  console.log(`Total Page Faults:        ${stats.totalPageFaults}`);
  console.log(`Page Fault Rate:          ${faultRate}%`);
  console.log(`Total Evictions:          ${stats.totalEvictions}`);
  console.log(`Dirty Page Write-backs:   ${stats.dirtyWriteBacks}`);
  console.log(`First-time Page Loads:    ${stats.firstTimeLoads}`);
  console.log(`Backing Store Reloads:    ${stats.backingStoreReloads}`);
  console.log(`------------------------------------------------------------`);
  console.log(`Per-Process Breakdown:`);
  for (const [pid, ps] of stats.perProcessStats) {
    if (ps.totalAccesses > 0) {
      const pRate = ((ps.pageFaults / ps.totalAccesses) * 100).toFixed(2);
      console.log(
        `  PID ${pid}: ${ps.totalAccesses} accesses, ${ps.pageFaults} faults (${pRate}%)`
      );
    }
  }
  console.log(`============================================================\n`);
}

/**
 * Formatted printer for comparative experiment tables.
 */
export function printComparisonTable(
  results: Array<{
    workingSetSize: number;
    random: SimulationStats;
    wsclock: SimulationStats;
  }>
): void {
  console.log(`\n========================================================================================`);
  console.log(`PAGE REPLACEMENT COMPARISON: Random vs WSClock across Working Set Sizes`);
  console.log(`========================================================================================`);
  console.log(
    'WS Size'.padEnd(10) +
    '| Total Acc'.padEnd(12) +
    '| Random Faults'.padEnd(16) +
    '| Random Rate'.padEnd(14) +
    '| WSClock Faults'.padEnd(17) +
    '| WSClock Rate'.padEnd(15) +
    '| Improvement'
  );
  console.log('-'.repeat(88));

  for (const r of results) {
    const rFaults = r.random.totalPageFaults;
    const wFaults = r.wsclock.totalPageFaults;
    const total = r.random.totalAccesses;
    const rRate = total > 0 ? (rFaults / total * 100).toFixed(2) + '%' : '0.00%';
    const wRate = total > 0 ? (wFaults / total * 100).toFixed(2) + '%' : '0.00%';
    const diff = rFaults - wFaults;
    const improvement = rFaults > 0 ? ((diff / rFaults) * 100).toFixed(1) + '%' : '0.0%';

    console.log(
      String(r.workingSetSize).padEnd(10) +
      `| ${String(total).padEnd(10)}` +
      `| ${String(rFaults).padEnd(14)}` +
      `| ${rRate.padEnd(12)}` +
      `| ${String(wFaults).padEnd(15)}` +
      `| ${wRate.padEnd(13)}` +
      `| ${diff >= 0 ? '-' + improvement : '+' + improvement}`
    );
  }
  console.log(`========================================================================================\n`);
}
