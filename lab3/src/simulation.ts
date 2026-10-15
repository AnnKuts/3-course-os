import { Kernel } from './kernel';
import { RandomReplacement, WSClockReplacement } from './algorithms';
import { Process, ProcessConfig, ProcessStats, AccessType, MemoryAccess } from './process';
import { SeededRNG } from './rng';

export interface SimulationConfig {
  numPhysicalFrames: number;
  maxConcurrentProcesses: number;
  processes: ProcessConfig[];
  timeQuantum: number;
  tau: number;
  totalAccesses: number;
  seed: number;
  verbose: boolean;
  writeProbability: number;
  workingSetLocality: number;
}

export interface SimulationStats {
  algorithmName: string;
  totalAccesses: number;
  totalPageFaults: number;
  totalEvictions: number;
  dirtyWriteBacks: number;
  firstTimeLoads: number;
  cleanReloads: number;
  backingStoreReloads: number;
  perProcessStats: Map<number, ProcessStats>;
}

// Запис трасування для відтворюваності
interface TraceAccess {
  time: number;
  pid: number;
  virtualPage: number;
  accessType: AccessType;
}

interface WorkloadTrace {
  processConfigs: Array<{ pid: number; config: ProcessConfig }>;
  accesses: TraceAccess[];
  terminationTimes: Map<number, number>;
}

export class Simulation {
  private readonly cfg: SimulationConfig;

  constructor(cfg: SimulationConfig) {
    this.cfg = cfg;
  }

  // Генерація детермінованого трасування за Round Robin
  generateWorkload(): WorkloadTrace {
    const rng = new SeededRNG(this.cfg.seed);
    const sortedCfgs = [...this.cfg.processes]
      .map((c, i) => ({ c, i }))
      .sort((a, b) => a.c.creationTime - b.c.creationTime);

    const processMap = new Map<number, Process>();
    const processConfigs: Array<{ pid: number; config: ProcessConfig }> = [];
    const terminationTimes = new Map<number, number>();
    const accesses: TraceAccess[] = [];
    const readyQueue: Process[] = [];

    let nextPid = 1;
    let nextArrivalIdx = 0;
    let currentProcess: Process | null = null;
    let quantum = 0;
    let t = 0;

    while (t < this.cfg.totalAccesses) {
      // Запуск нових процесів
      while (
        nextArrivalIdx < sortedCfgs.length &&
        sortedCfgs[nextArrivalIdx].c.creationTime <= t
      ) {
        const active =
          (currentProcess && !currentProcess.terminated ? 1 : 0) +
          readyQueue.filter((p) => !p.terminated).length;
        if (active >= this.cfg.maxConcurrentProcesses) break;

        const { c } = sortedCfgs[nextArrivalIdx];
        const pid = nextPid++;
        const proc = new Process(
          pid, c,
          new SeededRNG(rng.getState()),
          this.cfg.writeProbability,
          this.cfg.workingSetLocality
        );
        rng.next();
        processMap.set(pid, proc);
        processConfigs.push({ pid, config: c });
        readyQueue.push(proc);
        nextArrivalIdx++;
      }

      // Round-Robin планування
      if (currentProcess !== null) {
        if (quantum <= 0) {
          if (readyQueue.length > 0) {
            readyQueue.push(currentProcess);
            currentProcess = readyQueue.shift()!;
          }
          quantum = this.cfg.timeQuantum;
        }
      } else {
        if (readyQueue.length > 0) {
          currentProcess = readyQueue.shift()!;
          quantum = this.cfg.timeQuantum;
        } else if (nextArrivalIdx < sortedCfgs.length) {
          t = Math.min(sortedCfgs[nextArrivalIdx].c.creationTime, this.cfg.totalAccesses);
          continue;
        } else {
          break;
        }
      }

      currentProcess.checkWorkingSetChange();
      const access = currentProcess.generateAccess();
      accesses.push({ time: t, pid: currentProcess.pid, virtualPage: access.virtualPage, accessType: access.type });
      currentProcess.recordAccess();
      quantum--;
      t++;

      if (currentProcess.isFinished()) {
        currentProcess.terminated = true;
        terminationTimes.set(currentProcess.pid, t);
        currentProcess = null;
        quantum = 0;
      }
    }

    return { processConfigs, accesses, terminationTimes };
  }

  // Виконання симуляції на готовому трасуванні
  runWithWorkload(algorithm: 'random' | 'wsclock', workload: WorkloadTrace): SimulationStats {
    const strategy =
      algorithm === 'random'
        ? new RandomReplacement(new SeededRNG(this.cfg.seed + 1000))
        : new WSClockReplacement(this.cfg.tau);

    const kernel = new Kernel(this.cfg.numPhysicalFrames, strategy, this.cfg.verbose);

    const processMap = new Map<number, Process>();
    const statsMap = new Map<number, ProcessStats>();
    for (const { pid, config } of workload.processConfigs) {
      const proc = new Process(pid, config, new SeededRNG(0), 0, 0);
      processMap.set(pid, proc);
      statsMap.set(pid, { pid, totalAccesses: 0, pageFaults: 0, pagesAllocated: 0 });
    }

    const started = new Set<number>();
    const terminated = new Set<number>();

    for (const acc of workload.accesses) {
      const proc = processMap.get(acc.pid);
      if (!proc) continue;

      if (!started.has(acc.pid)) {
        started.add(acc.pid);
        if (this.cfg.verbose) {
          console.log(`[EVENT] t=${acc.time}: PID=${proc.pid} started`);
        }
      }

      const fault = kernel.handleAccess(proc, acc.virtualPage, acc.accessType, acc.time);
      proc.recordAccess();

      const ps = statsMap.get(acc.pid)!;
      ps.totalAccesses++;
      if (fault) ps.pageFaults++;

      // Завершення процесу
      const termTime = workload.terminationTimes.get(acc.pid);
      if (termTime !== undefined && acc.time + 1 >= termTime && !terminated.has(acc.pid)) {
        terminated.add(acc.pid);
        kernel.terminateProcess(proc);
      }
    }

    // Завершення процесів, що досягли ліміту, але не отримали термінаційного звернення
    for (const [pid, proc] of processMap) {
      if (started.has(pid) && !terminated.has(pid)) {
        terminated.add(pid);
        kernel.terminateProcess(proc);
      }
    }

    // Фінальна перевірка узгодженості
    const errs = kernel.validateInvariants(Array.from(processMap.values()));
    if (errs.length > 0) {
      console.warn('[WARN] Invariant violations at end of simulation:');
      errs.forEach((e) => console.warn(`  - ${e}`));
    }

    return {
      algorithmName: strategy.name,
      totalAccesses: workload.accesses.length,
      totalPageFaults: kernel.totalPageFaults,
      totalEvictions: kernel.totalEvictions,
      dirtyWriteBacks: kernel.dirtyWriteBacks,
      firstTimeLoads: kernel.firstTimeLoads,
      cleanReloads: kernel.cleanReloads,
      backingStoreReloads: kernel.backingStoreReloads,
      perProcessStats: statsMap,
    };
  }

  runComparison(): { random: SimulationStats; wsclock: SimulationStats } {
    if (this.cfg.verbose) console.log('=== Generating Workload ===');
    const workload = this.generateWorkload();
    if (this.cfg.verbose) {
      console.log(`Workload: ${workload.accesses.length} accesses, ${workload.processConfigs.length} processes.\n`);
    }
    const random = this.runWithWorkload('random', workload);
    const wsclock = this.runWithWorkload('wsclock', workload);
    return { random, wsclock };
  }
}

// ---------------------------------------------------------------------------
// Виведення статистики
// ---------------------------------------------------------------------------
export function printStats(stats: SimulationStats): void {
  const rate = stats.totalAccesses > 0
    ? ((stats.totalPageFaults / stats.totalAccesses) * 100).toFixed(2)
    : '0.00';
  const loadSum = stats.firstTimeLoads + stats.cleanReloads + stats.backingStoreReloads;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Algorithm:             ${stats.algorithmName}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Total Memory Accesses: ${stats.totalAccesses}`);
  console.log(`Total Page Faults:     ${stats.totalPageFaults}  (${rate}%)`);
  console.log(`Total Evictions:       ${stats.totalEvictions}`);
  console.log(`Dirty Write-backs:     ${stats.dirtyWriteBacks}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`Page Load Breakdown (sum = faults):`);
  console.log(`  First-time loads:    ${stats.firstTimeLoads}`);
  console.log(`  Clean reloads:       ${stats.cleanReloads}`);
  console.log(`  Backing-store:       ${stats.backingStoreReloads}`);
  console.log(`  Sum:                 ${loadSum} ${loadSum === stats.totalPageFaults ? '✓' : '✗ MISMATCH'}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`Per-Process:`);
  for (const [, ps] of stats.perProcessStats) {
    if (ps.totalAccesses > 0) {
      const r = ((ps.pageFaults / ps.totalAccesses) * 100).toFixed(2);
      console.log(`  PID ${ps.pid}: ${ps.totalAccesses} accesses, ${ps.pageFaults} faults (${r}%)`);
    }
  }
  console.log(`${'='.repeat(60)}\n`);
}
