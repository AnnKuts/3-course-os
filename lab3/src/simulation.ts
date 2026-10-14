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
 *
 * ## Round-Robin Scheduling Behaviour
 *
 * Processes are scheduled round-robin with a configurable time quantum.
 * The current process runs for up to `timeQuantum` accesses before yielding.
 * When the current process finishes (lifetime exhausted) mid-quantum the
 * quantum is reset and the scheduler moves to the next runnable process.
 * Newly arrived processes are admitted at the start of each scheduling
 * iteration (before the current quantum is consumed), so a process that
 * arrives at time T will be eligible for the *next* quantum after T.
 *
 * Both behaviours are tested in the regression suite.
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
    let currentProcess: Process | null = null;
    let currentQuantumRemaining = 0;

    while (currentTime < this.config.totalAccesses) {
      // 1. Admit newly arriving processes whose creationTime <= currentTime
      while (
        nextArrivalIdx < sortedConfigs.length &&
        sortedConfigs[nextArrivalIdx].cfg.creationTime <= currentTime
      ) {
        // Enforce max concurrent processes
        const activeCount =
          (currentProcess && !currentProcess.terminated ? 1 : 0) +
          readyQueue.filter((p) => !p.terminated).length;
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

      // 2. Quantum check and context switching
      if (currentProcess !== null) {
        if (currentQuantumRemaining <= 0) {
          if (readyQueue.length > 0) {
            // Quantum exhausted; switch to next ready process
            readyQueue.push(currentProcess);
            currentProcess = readyQueue.shift()!;
            currentQuantumRemaining = this.config.timeQuantum;
          } else {
            // No other process ready; renew quantum for current process
            currentQuantumRemaining = this.config.timeQuantum;
          }
        }
      } else {
        if (readyQueue.length > 0) {
          currentProcess = readyQueue.shift()!;
          currentQuantumRemaining = this.config.timeQuantum;
        } else {
          if (nextArrivalIdx < sortedConfigs.length) {
            // Fast-forward to next arrival time
            currentTime = Math.min(
              sortedConfigs[nextArrivalIdx].cfg.creationTime,
              this.config.totalAccesses
            );
            continue;
          } else {
            // No more processes left
            break;
          }
        }
      }

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
        currentProcess = null;
        currentQuantumRemaining = 0;
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

    const debugMode = this.config.debugMode ?? false;

    const kernel = new Kernel(
      this.config.numPhysicalFrames,
      strategy,
      this.logger,
      mmu,
      debugMode
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
        this.logger.event(`[t=${access.time + 1}] Process PID=${proc.pid} terminated`);
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

    // ── Final invariant check (bidirectional, with process list) ──────────
    const activeProcList = Array.from(processMap.values());
    const invariantErrors = kernel.validateInvariants(activeProcList);
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
      cleanReloads: kernel.cleanReloads,
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
 * Includes the three-way load classification and checks their sum == totalPageFaults.
 */
export function printStats(stats: SimulationStats): void {
  const faultRate = stats.totalAccesses > 0
    ? ((stats.totalPageFaults / stats.totalAccesses) * 100).toFixed(2)
    : '0.00';

  const loadSum = stats.firstTimeLoads + stats.cleanReloads + stats.backingStoreReloads;
  const loadSumOk = loadSum === stats.totalPageFaults;

  console.log(`\n============================================================`);
  console.log(`Algorithm:                ${stats.algorithmName}`);
  console.log(`============================================================`);
  console.log(`Physical Frames:          ${stats.config.numPhysicalFrames}`);
  console.log(`Total Memory Accesses:    ${stats.totalAccesses}`);
  console.log(`Total Page Faults:        ${stats.totalPageFaults}`);
  console.log(`Page Fault Rate:          ${faultRate}%`);
  console.log(`Total Evictions:          ${stats.totalEvictions}`);
  console.log(`Dirty Page Write-backs:   ${stats.dirtyWriteBacks}`);
  console.log(`------------------------------------------------------------`);
  console.log(`Page Load Breakdown (sum should equal total faults):`);
  console.log(`  First-time loads:       ${stats.firstTimeLoads}`);
  console.log(`  Clean reloads:          ${stats.cleanReloads}`);
  console.log(`  Backing-store reloads:  ${stats.backingStoreReloads}`);
  console.log(`  Sum:                    ${loadSum} ${loadSumOk ? '✓' : '✗ MISMATCH'}`);
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
 * Conclusions are derived from actual measured results.
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
    '| Result'
  );
  console.log('-'.repeat(88));

  let wsclockWins = 0;
  let randomWins = 0;
  let ties = 0;
  let prevRandomFaults: number | null = null;
  let monotonic = true;

  for (const r of results) {
    const rFaults = r.random.totalPageFaults;
    const wFaults = r.wsclock.totalPageFaults;
    const total = r.random.totalAccesses;
    const rRate = total > 0 ? (rFaults / total * 100).toFixed(2) + '%' : '0.00%';
    const wRate = total > 0 ? (wFaults / total * 100).toFixed(2) + '%' : '0.00%';
    const diff = rFaults - wFaults;

    // Track monotonicity of Random faults as WS grows
    if (prevRandomFaults !== null && rFaults < prevRandomFaults) {
      monotonic = false;
    }
    prevRandomFaults = rFaults;

    let result: string;
    if (diff > 0) {
      wsclockWins++;
      result = `WSClock -${((diff / rFaults) * 100).toFixed(1)}%`;
    } else if (diff < 0) {
      randomWins++;
      result = `Random -${((-diff / wFaults) * 100).toFixed(1)}%`;
    } else {
      ties++;
      result = 'Tie';
    }

    console.log(
      String(r.workingSetSize).padEnd(10) +
      `| ${String(total).padEnd(10)}` +
      `| ${String(rFaults).padEnd(14)}` +
      `| ${rRate.padEnd(12)}` +
      `| ${String(wFaults).padEnd(15)}` +
      `| ${wRate.padEnd(13)}` +
      `| ${result}`
    );
  }
  console.log(`========================================================================================\n`);

  // ── Data-driven conclusions ──────────────────────────────────────────────
  const total = results.length;
  console.log(`Measured Conclusions:`);

  console.log(
    `1. Fault rate trend with WS size: ` +
    (monotonic
      ? 'Monotonically increasing for Random — higher WS creates more contention.'
      : 'Non-monotonic — page fault rate may decrease at some working-set sizes due to ' +
        'interaction between WS shifts, quantum boundaries, and frame pool size.')
  );

  if (wsclockWins > randomWins) {
    console.log(
      `2. Algorithm winner: WSClock won in ${wsclockWins}/${total} cases, ` +
      `Random won in ${randomWins}/${total}, ties ${ties}/${total}.`
    );
    console.log(
      `   WSClock's locality-awareness (R bit + TAU window) reduces page faults ` +
      `when working-set size is small relative to physical memory.`
    );
  } else if (randomWins > wsclockWins) {
    console.log(
      `2. Algorithm winner: Random won in ${randomWins}/${total} cases, ` +
      `WSClock won in ${wsclockWins}/${total}, ties ${ties}/${total}.`
    );
    console.log(
      `   WSClock performs worse when the working set is larger than physical memory: ` +
      `protecting recently-referenced hot pages delays eviction of old pages and ` +
      `increases reload overhead. Consider reducing TAU.`
    );
  } else {
    console.log(
      `2. Algorithms were evenly matched: WSClock won ${wsclockWins}, ` +
      `Random won ${randomWins}, ties ${ties} (total ${total} experiments).`
    );
  }

  console.log(
    `3. Workload integrity: both algorithms evaluated against the identical ` +
    `pre-generated memory access trace (same process arrivals, lifetimes, ` +
    `virtual pages, read/write types, and working-set shifts).`
  );
}
