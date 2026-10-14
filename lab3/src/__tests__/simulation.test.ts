import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { PTE } from '../pte';
import { PageTable } from '../pageTable';
import { PhysicalPage } from '../physicalPage';
import { MMU } from '../mmu';
import { Kernel } from '../kernel';
import { BackingStore } from '../backingStore';
import { SeededRNG } from '../rng';
import { WorkingSet } from '../workingSet';
import { Process } from '../process';
import { RandomReplacement } from '../randomReplacement';
import { WSClockReplacement } from '../wsclockReplacement';
import { getDefaultConfig } from '../main';
import { Simulation } from '../simulation';
import { AccessType, SimulationConfig } from '../types';
import { Logger } from '../logger';

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

describe('2. MMU Hardware Simulation Constraints', () => {
  test('MMU sets R=1 on READ and does not set M', () => {
    const mmu = new MMU();
    const pt = new PageTable(4);
    const pte = pt.getPTE(1);

    // Simulate page is already mapped
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

    // MMU access does not accept PhysicalPage and cannot modify its timestamp
    mmu.access(pt, 0, AccessType.READ);
    assert.equal(frame.lastAccessTime, 50); // Untouched!
  });
});

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

    // Frame 0 had R=1, so WSClock must clear R and update frame0.lastAccessTime to 100
    assert.equal(pte0.R, false);
    assert.equal(frame0.lastAccessTime, 100);

    // Frame 1 had R=0, age 90 > TAU 50, M=0 -> chosen victim!
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
    frame0.allocate(pte0, 1, 0, 20); // age = 100 - 20 = 80 > 40

    const frame1 = new PhysicalPage(1);
    const pte1 = new PTE();
    pte1.P = true;
    pte1.R = false;
    pte1.M = false; // Clean
    pte1.PPN = 1;
    frame1.allocate(pte1, 1, 1, 30); // age = 100 - 30 = 70 > 40

    const frames = [frame0, frame1];
    const victim = wsclock.selectVictim(frames, 100, logger);

    // Frame 1 is clean, so it should be evicted immediately
    assert.equal(victim.frameId, 1);
  });
});

describe('4. Kernel, Memory Allocation, and Invariants', () => {
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

    // Access virtual page 0
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

    assert.equal(kernel.validateInvariants().length, 0);
  });

  test('Evicting a dirty page triggers simulated write-back to BackingStore', () => {
    const logger = new Logger(false);
    const mmu = new MMU();
    const strategy = new RandomReplacement(new SeededRNG(0));
    const kernel = new Kernel(1, strategy, logger, mmu); // Only 1 physical frame!

    const proc = new Process(1, {
      creationTime: 0,
      lifetime: 10,
      virtualPages: 4,
      workingSetSize: 2,
      workingSetChangeInterval: 10,
    }, new SeededRNG(1));

    // 1. Write to page 0 -> causes page fault, loads into frame 0, sets M=1
    kernel.handleMemoryAccess(proc, 0, AccessType.WRITE, 5);
    const pte0 = proc.pageTable.getPTE(0);
    assert.equal(pte0.M, true);

    // 2. Access page 1 -> causes page fault, frame 0 must be evicted
    kernel.handleMemoryAccess(proc, 1, AccessType.READ, 10);

    // Page 0 should have been written to backing store
    assert.equal(kernel.dirtyWriteBacks, 1);
    assert.equal(kernel.getBackingStore().hasSavedPage(1, 0), true);
    assert.equal(pte0.P, false); // Invalidated

    // 3. Re-access page 0 -> should count as a backing store reload
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

    // Terminate process
    kernel.terminateProcess(proc);

    assert.equal(kernel.getFrames().every((f) => f.isFree()), true);
    assert.equal(proc.pageTable.getPTE(0).P, false);
    assert.equal(proc.pageTable.getPTE(1).P, false);
    assert.equal(kernel.validateInvariants().length, 0);
  });
});

describe('5. Simulation Workload Reproducibility and Fairness', () => {
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

    // Run both algorithms
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
});
