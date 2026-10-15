import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { PTE, PageTable, PhysicalPage } from '../memory';
import { Kernel } from '../kernel';
import { SeededRNG } from '../rng';
import { Process, AccessType } from '../process';
import { RandomReplacement, WSClockReplacement } from '../algorithms';
import { getDefaultConfig } from '../main';
import { Simulation } from '../simulation';

describe('1. Data Structures', () => {
  test('PTE contains exactly P, R, M, PPN fields', () => {
    const pte = new PTE();
    assert.deepEqual(Object.keys(pte).sort(), ['M', 'P', 'PPN', 'R']);
    assert.equal(typeof pte.P, 'boolean');
    assert.equal(typeof pte.R, 'boolean');
    assert.equal(typeof pte.M, 'boolean');
    assert.equal(typeof pte.PPN, 'number');
    assert.equal((pte as any).lastUsed, undefined);
    assert.equal((pte as any).lastAccessTime, undefined);
  });

  test('PhysicalPage holds lastAccessTime (for WSClock), not PTE', () => {
    const frame = new PhysicalPage(0);
    assert.equal(frame.lastAccessTime, 0);
    assert.equal(frame.isFree(), true);
    const pte = new PTE();
    frame.allocate(pte, 1, 5, 100);
    assert.equal(frame.lastAccessTime, 100);
    assert.equal(frame.ownerPid, 1);
    assert.equal(frame.virtualPageNumber, 5);
    assert.equal(frame.busy, true);
    frame.release();
    assert.equal(frame.isFree(), true);
    assert.equal(frame.mappedPTE, null);
    assert.equal(frame.lastAccessTime, 0);
  });
});

describe('2. MMU Behaviour (via Kernel)', () => {
  test('READ sets R=1, does not set M', () => {
    const kernel = new Kernel(2, new RandomReplacement(new SeededRNG(42)));
    const proc = new Process(1, { creationTime: 0, lifetime: 10, virtualPages: 4, workingSetSize: 2, workingSetChangeInterval: 10 }, new SeededRNG(1));
    kernel.handleAccess(proc, 0, AccessType.READ, 1);
    const pte = proc.pageTable.getPTE(0);
    assert.equal(pte.P, true);
    assert.equal(pte.R, true);
    assert.equal(pte.M, false);
  });

  test('WRITE sets R=1 and M=1', () => {
    const kernel = new Kernel(2, new RandomReplacement(new SeededRNG(42)));
    const proc = new Process(1, { creationTime: 0, lifetime: 10, virtualPages: 4, workingSetSize: 2, workingSetChangeInterval: 10 }, new SeededRNG(1));
    kernel.handleAccess(proc, 1, AccessType.WRITE, 1);
    const pte = proc.pageTable.getPTE(1);
    assert.equal(pte.R, true);
    assert.equal(pte.M, true);
  });

  test('MMU does NOT update lastAccessTime in PTE (stays in PhysicalPage)', () => {
    const kernel = new Kernel(2, new RandomReplacement(new SeededRNG(42)));
    const proc = new Process(1, { creationTime: 0, lifetime: 10, virtualPages: 4, workingSetSize: 2, workingSetChangeInterval: 10 }, new SeededRNG(1));
    kernel.handleAccess(proc, 0, AccessType.READ, 50);
    const frame = kernel.getFrames().find((f) => f.busy)!;
    assert.equal(frame.lastAccessTime, 50);
    kernel.handleAccess(proc, 0, AccessType.READ, 99);
    assert.equal(frame.lastAccessTime, 50);
  });
});

describe('3. WSClock Algorithm', () => {
  test('Clears R=1 and updates lastAccessTime when sweeping referenced frame', () => {
    const wsclock = new WSClockReplacement(50);
    const frame0 = new PhysicalPage(0);
    const pte0 = new PTE();
    pte0.P = true; pte0.R = true; pte0.M = false; pte0.PPN = 0;
    frame0.allocate(pte0, 1, 0, 10);

    const frame1 = new PhysicalPage(1);
    const pte1 = new PTE();
    pte1.P = true; pte1.R = false; pte1.M = false; pte1.PPN = 1;
    frame1.allocate(pte1, 1, 1, 10);

    const victim = wsclock.selectVictim([frame0, frame1], 100, false);
    assert.equal(pte0.R, false);
    assert.equal(frame0.lastAccessTime, 100);
    assert.equal(victim.frameId, 1);
  });

  test('Prefers clean page (M=0) over dirty page (M=1) when both outside WS', () => {
    const wsclock = new WSClockReplacement(40);
    const frame0 = new PhysicalPage(0);
    const pte0 = new PTE();
    pte0.P = true; pte0.R = false; pte0.M = true; pte0.PPN = 0;
    frame0.allocate(pte0, 1, 0, 20);

    const frame1 = new PhysicalPage(1);
    const pte1 = new PTE();
    pte1.P = true; pte1.R = false; pte1.M = false; pte1.PPN = 1;
    frame1.allocate(pte1, 1, 1, 30);

    const victim = wsclock.selectVictim([frame0, frame1], 100, false);
    assert.equal(victim.frameId, 1);
  });

  test('Falls back to oldest dirty when no clean pages outside WS exist', () => {
    const wsclock = new WSClockReplacement(10);
    const mkFrame = (id: number, lastAccess: number): PhysicalPage => {
      const f = new PhysicalPage(id);
      const p = new PTE();
      p.P = true; p.R = false; p.M = true; p.PPN = id;
      f.allocate(p, 1, id, lastAccess);
      return f;
    };
    const frames = [mkFrame(0, 50), mkFrame(1, 30)];
    const victim = wsclock.selectVictim(frames, 100, false);
    assert.equal(victim.frameId, 1);
  });
});

describe('4. Kernel', () => {
  test('Page fault allocates frame and sets PTE.P=true, lastAccessTime', () => {
    const kernel = new Kernel(2, new RandomReplacement(new SeededRNG(42)));
    const proc = new Process(1, { creationTime: 0, lifetime: 10, virtualPages: 4, workingSetSize: 2, workingSetChangeInterval: 10 }, new SeededRNG(1));
    const fault = kernel.handleAccess(proc, 0, AccessType.READ, 10);
    assert.equal(fault, true);
    const pte = proc.pageTable.getPTE(0);
    assert.equal(pte.P, true);
    assert.equal(pte.PPN, 0);
    const frame = kernel.getFrames()[0];
    assert.equal(frame.busy, true);
    assert.equal(frame.ownerPid, 1);
    assert.equal(frame.lastAccessTime, 10);
    assert.equal(kernel.validateInvariants([proc]).length, 0);
  });

  test('Three-way load classification sum equals total page faults', () => {
    const kernel = new Kernel(1, new RandomReplacement(new SeededRNG(0)));
    const proc = new Process(1, { creationTime: 0, lifetime: 20, virtualPages: 4, workingSetSize: 2, workingSetChangeInterval: 10 }, new SeededRNG(1));
    kernel.handleAccess(proc, 0, AccessType.READ, 1);
    assert.equal(kernel.firstTimeLoads, 1);
    kernel.handleAccess(proc, 1, AccessType.READ, 2);
    assert.equal(kernel.firstTimeLoads, 2);
    kernel.handleAccess(proc, 0, AccessType.READ, 3);
    assert.equal(kernel.cleanReloads, 1);
    kernel.handleAccess(proc, 0, AccessType.WRITE, 4);
    kernel.handleAccess(proc, 1, AccessType.READ, 5);
    assert.equal(kernel.dirtyWriteBacks, 1);
    kernel.handleAccess(proc, 0, AccessType.READ, 6);
    assert.equal(kernel.backingStoreReloads, 1);
    assert.equal(
      kernel.firstTimeLoads + kernel.cleanReloads + kernel.backingStoreReloads,
      kernel.totalPageFaults
    );
  });

  test('Dirty eviction triggers write-back; reload counts as backingStoreReload', () => {
    const kernel = new Kernel(1, new RandomReplacement(new SeededRNG(0)));
    const proc = new Process(1, { creationTime: 0, lifetime: 10, virtualPages: 4, workingSetSize: 2, workingSetChangeInterval: 10 }, new SeededRNG(1));
    kernel.handleAccess(proc, 0, AccessType.WRITE, 5);
    assert.equal(proc.pageTable.getPTE(0).M, true);
    kernel.handleAccess(proc, 1, AccessType.READ, 10);
    assert.equal(kernel.dirtyWriteBacks, 1);
    assert.equal(kernel.hasSavedPage(1, 0), true);
    kernel.handleAccess(proc, 0, AccessType.READ, 15);
    assert.equal(kernel.backingStoreReloads, 1);
  });

  test('Process termination releases all frames', () => {
    const kernel = new Kernel(4, new RandomReplacement(new SeededRNG(0)));
    const proc = new Process(1, { creationTime: 0, lifetime: 10, virtualPages: 4, workingSetSize: 2, workingSetChangeInterval: 10 }, new SeededRNG(1));
    kernel.handleAccess(proc, 0, AccessType.READ, 1);
    kernel.handleAccess(proc, 1, AccessType.READ, 2);
    assert.equal(kernel.getFrames().filter((f) => f.busy).length, 2);
    kernel.terminateProcess(proc);
    assert.ok(kernel.getFrames().every((f) => f.isFree()));
    assert.equal(proc.pageTable.getPTE(0).P, false);
    assert.equal(kernel.validateInvariants([proc]).length, 0);
  });

  test('validateInvariants detects two PTEs referencing the same frame', () => {
    const kernel = new Kernel(4, new RandomReplacement(new SeededRNG(0)));
    const proc = new Process(1, { creationTime: 0, lifetime: 10, virtualPages: 4, workingSetSize: 2, workingSetChangeInterval: 10 }, new SeededRNG(1));
    kernel.handleAccess(proc, 0, AccessType.READ, 1);
    const pte0 = proc.pageTable.getPTE(0);
    const pte1 = proc.pageTable.getPTE(1);
    pte1.P = true;
    pte1.PPN = pte0.PPN;
    const errors = kernel.validateInvariants([proc]);
    assert.ok(errors.length > 0, 'Must detect shared frame reference');
    pte1.P = false; pte1.PPN = -1;
  });
});

describe('5. Round-Robin Scheduling', () => {
  test('All configured processes appear in workload trace', () => {
    const cfg = getDefaultConfig();
    cfg.totalAccesses = 300;
    const trace = new Simulation(cfg).generateWorkload();
    const pids = new Set(trace.accesses.map((a) => a.pid));
    assert.equal(pids.size, cfg.processes.length);
  });

  test('No process runs more than quantum+5 consecutive accesses', () => {
    const cfg = getDefaultConfig();
    cfg.totalAccesses = 400;
    const trace = new Simulation(cfg).generateWorkload();
    let maxRun = 0, run = 1;
    for (let i = 1; i < trace.accesses.length; i++) {
      if (trace.accesses[i].pid === trace.accesses[i - 1].pid) { run++; if (run > maxRun) maxRun = run; }
      else run = 1;
    }
    assert.ok(maxRun <= cfg.timeQuantum + 5, `Run ${maxRun} > quantum ${cfg.timeQuantum}`);
  });
});

describe('6. Reproducibility', () => {
  test('Same seed produces identical workload traces', () => {
    const cfg = getDefaultConfig();
    cfg.totalAccesses = 200;
    const sim = new Simulation(cfg);
    const t1 = sim.generateWorkload();
    const t2 = sim.generateWorkload();
    assert.equal(t1.accesses.length, t2.accesses.length);
    for (let i = 0; i < t1.accesses.length; i++) {
      assert.deepEqual(t1.accesses[i], t2.accesses[i]);
    }
  });

  test('Both algorithms run on identical traces and get equal totalAccesses', () => {
    const cfg = getDefaultConfig();
    cfg.totalAccesses = 200;
    const sim = new Simulation(cfg);
    const trace = sim.generateWorkload();
    const r = sim.runWithWorkload('random', trace);
    const w = sim.runWithWorkload('wsclock', trace);
    assert.equal(r.totalAccesses, w.totalAccesses);
  });

  test('Load classification sum equals total page faults for full run', () => {
    const cfg = getDefaultConfig();
    cfg.totalAccesses = 500;
    const sim = new Simulation(cfg);
    const trace = sim.generateWorkload();
    const stats = sim.runWithWorkload('random', trace);
    const sum = stats.firstTimeLoads + stats.cleanReloads + stats.backingStoreReloads;
    assert.equal(sum, stats.totalPageFaults,
      `${stats.firstTimeLoads}+${stats.cleanReloads}+${stats.backingStoreReloads}=${sum} != ${stats.totalPageFaults}`);
  });
});
