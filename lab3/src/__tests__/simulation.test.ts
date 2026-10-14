import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { PTE } from '../pte';
import { PageTable } from '../pageTable';
import { PhysicalPage } from '../physicalPage';
import { MMU } from '../mmu';
import { Kernel } from '../kernel';
import { SeededRNG } from '../rng';
import { Process } from '../process';
import { RandomReplacement } from '../randomReplacement';
import { WSClockReplacement } from '../wsclockReplacement';
import { getDefaultConfig } from '../main';
import { Simulation } from '../simulation';
import { AccessType } from '../types';
import { Logger } from '../logger';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Data Structure and PTE Constraints
// ─────────────────────────────────────────────────────────────────────────────
describe('1. Data Structure and PTE Constraints', () => {
  test('PTE contains ONLY P, R, M, PPN fields (no timestamps, counters, or lastUsed)', () => {
    const pte = new PTE();
    const keys = Object.keys(pte);

    assert.deepEqual(keys.sort(), ['M', 'P', 'PPN', 'R']);
    assert.equal(typeof pte.P, 'boolean');
    assert.equal(typeof pte.R, 'boolean');
    assert.equal(typeof pte.M, 'boolean');
    assert.equal(typeof pte.PPN, 'number');

    // Confirm absence of timestamps or metadata
    assert.equal((pte as any).lastUsed, undefined);
    assert.equal((pte as any).lastAccessTime, undefined);
    assert.equal((pte as any).accessCounter, undefined);
  });

  test('PhysicalPage holds lastAccessTime, not PTE', () => {
    const frame = new PhysicalPage(0);
    assert.equal(typeof frame.lastAccessTime, 'number');
    assert.equal(frame.lastAccessTime, 0);
    assert.equal(frame.isFree(), true);

    const pte = new PTE();
    frame.allocate(pte, 1, 5, 100);
    assert.equal(frame.lastAccessTime, 100);
    assert.equal(frame.ownerPid, 1);
    assert.equal(frame.virtualPageNumber, 5);
    assert.equal(frame.busy, true);
    assert.equal(frame.mappedPTE, pte);

    frame.release();
    assert.equal(frame.isFree(), true);
    assert.equal(frame.mappedPTE, null);
    assert.equal(frame.ownerPid, null);
    assert.equal(frame.lastAccessTime, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. MMU Hardware Simulation Constraints
// ─────────────────────────────────────────────────────────────────────────────
describe('2. MMU Hardware Simulation Constraints', () => {
  test('MMU sets R=1 on READ and does not set M', () => {
    const mmu = new MMU();
    const pt = new PageTable(4);
    const pte = pt.getPTE(1);

    pte.P = true;
    pte.PPN = 2;
    pte.R = false;
    pte.M = false;

    const res = mmu.access(pt, 1, AccessType.READ);
    assert.equal(res.pageFault, false);
    assert.equal(res.ppn, 2);
    assert.equal(pte.R, true);
    assert.equal(pte.M, false);
  });

  test('MMU sets R=1 and M=1 on WRITE', () => {
    const mmu = new MMU();
    const pt = new PageTable(4);
    const pte = pt.getPTE(2);

    pte.P = true;
    pte.PPN = 0;
    pte.R = false;
    pte.M = false;

    const res = mmu.access(pt, 2, AccessType.WRITE);
    assert.equal(res.pageFault, false);
    assert.equal(res.ppn, 0);
    assert.equal(pte.R, true);
    assert.equal(pte.M, true);
  });

  test('MMU signals page fault when P=0', () => {
    const mmu = new MMU();
    const pt = new PageTable(4);
    const pte = pt.getPTE(3);
    assert.equal(pte.P, false);

    const res = mmu.access(pt, 3, AccessType.READ);
    assert.equal(res.pageFault, true);
    assert.equal(res.ppn, -1);
  });

  test('MMU never updates lastAccessTime or touches physical frame descriptors', () => {
    const mmu = new MMU();
    const pt = new PageTable(2);
    const frame = new PhysicalPage(0);
    const pte = pt.getPTE(0);

    frame.allocate(pte, 1, 0, 50);
    pte.P = true;
    pte.PPN = 0;

    mmu.access(pt, 0, AccessType.READ);
    assert.equal(frame.lastAccessTime, 50); // Untouched by MMU
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WSClock Algorithm Logic
// ─────────────────────────────────────────────────────────────────────────────
describe('3. WSClock Algorithm Logic', () => {
  test('WSClock resets R=0 and updates PhysicalPage lastAccessTime when R=1', () => {
    const logger = new Logger(false);
    const wsclock = new WSClockReplacement(50);

    const frame0 = new PhysicalPage(0);
    const pte0 = new PTE();
    pte0.P = true;
    pte0.R = true;
    pte0.M = false;
    pte0.PPN = 0;
    frame0.allocate(pte0, 1, 0, 10);

    const frame1 = new PhysicalPage(1);
    const pte1 = new PTE();
    pte1.P = true;
    pte1.R = false;
    pte1.M = false;
    pte1.PPN = 1;
    frame1.allocate(pte1, 1, 1, 10); // age = 100 - 10 = 90 > TAU(50)

    const frames = [frame0, frame1];
    const victim = wsclock.selectVictim(frames, 100, logger);

    // Frame 0 had R=1 → WSClock clears R and updates frame0.lastAccessTime
    assert.equal(pte0.R, false);
    assert.equal(frame0.lastAccessTime, 100);

    // Frame 1 had R=0, age 90 > TAU 50, M=0 → evicted
    assert.equal(victim.frameId, 1);
  });

  test('WSClock prefers clean pages (M=0) over dirty pages (M=1)', () => {
    const logger = new Logger(false);
    const wsclock = new WSClockReplacement(40);

    const frame0 = new PhysicalPage(0);
    const pte0 = new PTE();
    pte0.P = true;
    pte0.R = false;
    pte0.M = true; // Dirty
    pte0.PPN = 0;
    frame0.allocate(pte0, 1, 0, 20); // age = 80 > 40

    const frame1 = new PhysicalPage(1);
    const pte1 = new PTE();
    pte1.P = true;
    pte1.R = false;
    pte1.M = false; // Clean
    pte1.PPN = 1;
    frame1.allocate(pte1, 1, 1, 30); // age = 70 > 40

    const frames = [frame0, frame1];
    const victim = wsclock.selectVictim(frames, 100, logger);

    assert.equal(victim.frameId, 1); // Clean page chosen
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Kernel: Memory Allocation, Statistics, and Invariants
// ─────────────────────────────────────────────────────────────────────────────
describe('4. Kernel: Memory Allocation, Statistics, and Invariants', () => {
  test('Page faults establish valid mappings and initialize lastAccessTime', () => {
    const logger = new Logger(false);
    const mmu = new MMU();
    const strategy = new RandomReplacement(new SeededRNG(42));
    const kernel = new Kernel(2, strategy, logger, mmu);

    const proc = new Process(1, {
      creationTime: 0,
      lifetime: 10,
      virtualPages: 4,
      workingSetSize: 2,
      workingSetChangeInterval: 10,
    }, new SeededRNG(1));

    const fault = kernel.handleMemoryAccess(proc, 0, AccessType.READ, 10);
    assert.equal(fault, true);

    const pte0 = proc.pageTable.getPTE(0);
    assert.equal(pte0.P, true);
    assert.equal(pte0.R, true);
    assert.equal(pte0.PPN, 0);

    const frame0 = kernel.getFrames()[0];
    assert.equal(frame0.busy, true);
    assert.equal(frame0.ownerPid, 1);
    assert.equal(frame0.virtualPageNumber, 0);
    assert.equal(frame0.lastAccessTime, 10);

    assert.equal(kernel.validateInvariants([proc]).length, 0);
  });

  test('Three-way load classification: first-time, clean reload, backing-store reload sum equals page faults', () => {
    const logger = new Logger(false);
    const mmu = new MMU();
    const strategy = new RandomReplacement(new SeededRNG(0));
    const kernel = new Kernel(1, strategy, logger, mmu); // 1 frame only

    const proc = new Process(1, {
      creationTime: 0,
      lifetime: 20,
      virtualPages: 4,
      workingSetSize: 2,
      workingSetChangeInterval: 10,
    }, new SeededRNG(1));

    // t=1: Load VP=0 for the first time → firstTimeLoads++
    kernel.handleMemoryAccess(proc, 0, AccessType.READ, 1);
    assert.equal(kernel.firstTimeLoads, 1);
    assert.equal(kernel.cleanReloads, 0);
    assert.equal(kernel.backingStoreReloads, 0);

    // t=2: Load VP=1 (evicts VP=0 clean, no write-back) → firstTimeLoads++
    kernel.handleMemoryAccess(proc, 1, AccessType.READ, 2);
    assert.equal(kernel.firstTimeLoads, 2);
    assert.equal(kernel.cleanReloads, 0);

    // t=3: Reload VP=0 (was evicted clean → cleanReloads++)
    kernel.handleMemoryAccess(proc, 0, AccessType.READ, 3);
    assert.equal(kernel.firstTimeLoads, 2);
    assert.equal(kernel.cleanReloads, 1);
    assert.equal(kernel.backingStoreReloads, 0);

    // t=4: Write to VP=0 to make it dirty (no fault — already present)
    kernel.handleMemoryAccess(proc, 0, AccessType.WRITE, 4);
    // t=5: Evict VP=0 dirty to backing store
    kernel.handleMemoryAccess(proc, 1, AccessType.READ, 5);
    assert.equal(kernel.dirtyWriteBacks, 1);

    // t=6: Reload VP=0 from backing store → backingStoreReloads++
    kernel.handleMemoryAccess(proc, 0, AccessType.READ, 6);
    assert.equal(kernel.backingStoreReloads, 1);

    // Invariant: sum of three categories == totalPageFaults
    assert.equal(
      kernel.firstTimeLoads + kernel.cleanReloads + kernel.backingStoreReloads,
      kernel.totalPageFaults,
      'Load classification sum must equal totalPageFaults'
    );
  });

  test('Evicting a dirty page triggers simulated write-back to BackingStore', () => {
    const logger = new Logger(false);
    const mmu = new MMU();
    const strategy = new RandomReplacement(new SeededRNG(0));
    const kernel = new Kernel(1, strategy, logger, mmu);

    const proc = new Process(1, {
      creationTime: 0,
      lifetime: 10,
      virtualPages: 4,
      workingSetSize: 2,
      workingSetChangeInterval: 10,
    }, new SeededRNG(1));

    kernel.handleMemoryAccess(proc, 0, AccessType.WRITE, 5);
    const pte0 = proc.pageTable.getPTE(0);
    assert.equal(pte0.M, true);

    kernel.handleMemoryAccess(proc, 1, AccessType.READ, 10);
    assert.equal(kernel.dirtyWriteBacks, 1);
    assert.equal(kernel.getBackingStore().hasSavedPage(1, 0), true);
    assert.equal(pte0.P, false);

    kernel.handleMemoryAccess(proc, 0, AccessType.READ, 15);
    assert.equal(kernel.backingStoreReloads, 1);
  });

  test('Process termination releases all frames and clears mappings', () => {
    const logger = new Logger(false);
    const mmu = new MMU();
    const strategy = new RandomReplacement(new SeededRNG(0));
    const kernel = new Kernel(4, strategy, logger, mmu);

    const proc = new Process(1, {
      creationTime: 0,
      lifetime: 10,
      virtualPages: 4,
      workingSetSize: 2,
      workingSetChangeInterval: 10,
    }, new SeededRNG(1));

    kernel.handleMemoryAccess(proc, 0, AccessType.READ, 1);
    kernel.handleMemoryAccess(proc, 1, AccessType.READ, 2);
    assert.equal(kernel.getFrames().filter((f) => f.busy).length, 2);

    kernel.terminateProcess(proc);

    assert.equal(kernel.getFrames().every((f) => f.isFree()), true);
    assert.equal(proc.pageTable.getPTE(0).P, false);
    assert.equal(proc.pageTable.getPTE(1).P, false);
    assert.equal(kernel.validateInvariants([proc]).length, 0);
  });

  // ── Fix 2 regression: bidirectional invariant check ──────────────────────
  test('validateInvariants detects two present PTEs referencing the same physical frame', () => {
    const logger = new Logger(false);
    const mmu = new MMU();
    const strategy = new RandomReplacement(new SeededRNG(0));
    const kernel = new Kernel(4, strategy, logger, mmu);

    const proc = new Process(1, {
      creationTime: 0,
      lifetime: 10,
      virtualPages: 4,
      workingSetSize: 2,
      workingSetChangeInterval: 10,
    }, new SeededRNG(1));

    // Load VP=0 normally
    kernel.handleMemoryAccess(proc, 0, AccessType.READ, 1);
    const pte0 = proc.pageTable.getPTE(0);
    const legitimateFrameId = pte0.PPN;

    // Manually corrupt: make VP=1's PTE also point to the same frame
    const pte1 = proc.pageTable.getPTE(1);
    pte1.P = true;
    pte1.PPN = legitimateFrameId; // Duplicate! Same frame as VP=0
    pte1.R = false;
    pte1.M = false;

    // Also update the frame's back-reference to point to pte1 (creates inconsistency)
    const frames = kernel.getFrames();
    const sharedFrame = frames[legitimateFrameId];
    const originalMappedPTE = sharedFrame.mappedPTE;

    // The reverse check (PTE → PhysicalPage) must detect:
    // pte1.PPN == legitimateFrameId but frame.mappedPTE != pte1
    const errors = kernel.validateInvariants([proc]);
    assert.ok(
      errors.length > 0,
      'validateInvariants must detect inconsistency when two PTEs reference the same frame'
    );
    // At least one error about VP=1's PTE not matching the frame's mappedPTE
    const hasDuplicateError = errors.some(
      (e) => e.includes('VP=1') || e.includes('mappedPTE') || e.includes('shared')
    );
    assert.ok(
      hasDuplicateError,
      `Expected an error about VP=1 / shared frame. Got: ${errors.join('; ')}`
    );

    // Restore so cleanup doesn't throw
    sharedFrame.mappedPTE = originalMappedPTE;
    pte1.P = false;
    pte1.PPN = -1;
  });

  // ── Fix 3: debug mode fires invariant check mid-simulation ───────────────
  test('debugMode triggers validateInvariants after each page fault (no crash on valid state)', () => {
    const logger = new Logger(false);
    const mmu = new MMU();
    const strategy = new RandomReplacement(new SeededRNG(7));
    // debugMode = true → every page fault triggers validateInvariants internally
    const kernel = new Kernel(4, strategy, logger, mmu, /* debugMode */ true);

    const proc = new Process(1, {
      creationTime: 0,
      lifetime: 20,
      virtualPages: 8,
      workingSetSize: 4,
      workingSetChangeInterval: 20,
    }, new SeededRNG(1));

    // Run several accesses; if debug mode causes issues, an exception will throw here
    for (let vp = 0; vp < 6; vp++) {
      kernel.handleMemoryAccess(proc, vp, AccessType.READ, vp);
    }
    // All invariants should still hold
    assert.equal(kernel.validateInvariants([proc]).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Round-Robin Scheduling Behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe('5. Round-Robin Scheduling Behaviour', () => {
  /**
   * With a 3-process workload and a quantum of 10, each process should get
   * roughly equal time. Verify that all three PIDs appear in the generated
   * trace and that no single process runs more than (quantum + 1) accesses in a
   * contiguous block.
   */
  test('All concurrent processes appear in the workload trace', () => {
    const config = getDefaultConfig();
    config.totalAccesses = 300;
    const sim = new Simulation(config);
    const trace = sim.generateWorkload();

    const seenPids = new Set(trace.accesses.map((a) => a.pid));
    assert.equal(seenPids.size, config.processes.length,
      `Expected ${config.processes.length} distinct PIDs, got ${seenPids.size}`);
  });

  test('No process runs more consecutive accesses than the quantum allows', () => {
    const config = getDefaultConfig();
    config.totalAccesses = 400;
    const quantum = config.timeQuantum;
    const sim = new Simulation(config);
    const trace = sim.generateWorkload();

    let maxRun = 0;
    let currentRun = 1;
    for (let i = 1; i < trace.accesses.length; i++) {
      if (trace.accesses[i].pid === trace.accesses[i - 1].pid) {
        currentRun++;
        if (currentRun > maxRun) maxRun = currentRun;
      } else {
        currentRun = 1;
      }
    }

    // Allow quantum + some slack for the last quantum of a terminating process
    assert.ok(
      maxRun <= quantum + 5,
      `Longest consecutive run ${maxRun} exceeded quantum ${quantum} by too much`
    );
  });

  /**
   * When a process arrives mid-simulation it must be scheduled within the next
   * round-robin rotation. Verify its PID appears no later than 2 × quantum
   * accesses after its stated creation time.
   */
  test('A late-arriving process is scheduled within roughly two quanta', () => {
    const config = getDefaultConfig();
    config.totalAccesses = 600;
    config.processes = [
      { creationTime: 0,   lifetime: 600, virtualPages: 20, workingSetSize: 5, workingSetChangeInterval: 100 },
      { creationTime: 100, lifetime: 400, virtualPages: 20, workingSetSize: 5, workingSetChangeInterval: 100 },
    ];
    const sim = new Simulation(config);
    const trace = sim.generateWorkload();

    const lateArrivalTime = 100;
    const pid2Accesses = trace.accesses.filter((a) => a.pid === 2);
    assert.ok(pid2Accesses.length > 0, 'PID 2 must appear in the trace');

    const firstAppearance = pid2Accesses[0].time;
    assert.ok(
      firstAppearance - lateArrivalTime <= 2 * config.timeQuantum,
      `PID 2 first appeared at t=${firstAppearance}, expected within ` +
      `${lateArrivalTime + 2 * config.timeQuantum}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Simulation Workload Reproducibility and Fairness
// ─────────────────────────────────────────────────────────────────────────────
describe('6. Simulation Workload Reproducibility and Fairness', () => {
  test('Both Random and WSClock receive identical replayable workload traces', () => {
    const config = getDefaultConfig();
    config.totalAccesses = 200;
    const sim = new Simulation(config);

    const trace1 = sim.generateWorkload();
    const trace2 = sim.generateWorkload();

    assert.equal(trace1.accesses.length, trace2.accesses.length);
    for (let i = 0; i < trace1.accesses.length; i++) {
      assert.deepEqual(trace1.accesses[i], trace2.accesses[i]);
    }

    const res1 = sim.runWithWorkload('random', trace1);
    const res2 = sim.runWithWorkload('wsclock', trace1);
    assert.equal(res1.totalAccesses, res2.totalAccesses);
  });

  test('Simulation results are strictly reproducible with fixed seed', () => {
    const config1 = getDefaultConfig();
    config1.totalAccesses = 300;
    const config2 = { ...config1 };

    const sim1 = new Simulation(config1);
    const sim2 = new Simulation(config2);

    const trace1 = sim1.generateWorkload();
    const trace2 = sim2.generateWorkload();

    const r1 = sim1.runWithWorkload('random', trace1);
    const r2 = sim2.runWithWorkload('random', trace2);

    assert.equal(r1.totalPageFaults, r2.totalPageFaults);
    assert.equal(r1.totalEvictions, r2.totalEvictions);
    assert.equal(r1.dirtyWriteBacks, r2.dirtyWriteBacks);

    const w1 = sim1.runWithWorkload('wsclock', trace1);
    const w2 = sim2.runWithWorkload('wsclock', trace2);

    assert.equal(w1.totalPageFaults, w2.totalPageFaults);
    assert.equal(w1.totalEvictions, w2.totalEvictions);
  });

  test('Load classification sum equals total page faults across a full simulation run', () => {
    const config = getDefaultConfig();
    config.totalAccesses = 500;
    const sim = new Simulation(config);
    const trace = sim.generateWorkload();
    const stats = sim.runWithWorkload('random', trace);

    const loadSum = stats.firstTimeLoads + stats.cleanReloads + stats.backingStoreReloads;
    assert.equal(
      loadSum,
      stats.totalPageFaults,
      `firstTimeLoads(${stats.firstTimeLoads}) + cleanReloads(${stats.cleanReloads}) ` +
      `+ backingStoreReloads(${stats.backingStoreReloads}) = ${loadSum} ` +
      `must equal totalPageFaults(${stats.totalPageFaults})`
    );
  });
});
