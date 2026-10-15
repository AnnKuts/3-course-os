import { PhysicalPage, PTE, PageTable } from './memory';
import { ReplacementStrategy } from './algorithms';
import { Process, AccessType } from './process';

function mmuAccess(
  pageTable: PageTable,
  virtualPage: number,
  type: AccessType
): { pageFault: boolean; pte: PTE; ppn: number } {
  const pte = pageTable.getPTE(virtualPage);
  if (!pte.P) return { pageFault: true, pte, ppn: -1 };
  pte.R = true;
  if (type === AccessType.WRITE) pte.M = true;
  return { pageFault: false, pte, ppn: pte.PPN };
}

export class Kernel {
  private readonly frames: PhysicalPage[];
  private readonly backingStore = new Set<string>();
  private readonly everLoaded = new Set<string>();
  private strategy: ReplacementStrategy;
  private readonly verbose: boolean;

  public totalPageFaults = 0;
  public totalEvictions = 0;
  public dirtyWriteBacks = 0;
  public firstTimeLoads = 0;
  public cleanReloads = 0;
  public backingStoreReloads = 0;

  constructor(numFrames: number, strategy: ReplacementStrategy, verbose: boolean = false) {
    this.frames = Array.from({ length: numFrames }, (_, i) => new PhysicalPage(i));
    this.strategy = strategy;
    this.verbose = verbose;
  }

  setStrategy(strategy: ReplacementStrategy): void {
    this.strategy = strategy;
  }

  getFrames(): PhysicalPage[] { return this.frames; }

  hasSavedPage(pid: number, vp: number): boolean {
    return this.backingStore.has(`${pid}:${vp}`);
  }

  handleAccess(proc: Process, virtualPage: number, type: AccessType, time: number): boolean {
    let result = mmuAccess(proc.pageTable, virtualPage, type);
    if (!result.pageFault) return false;

    this.totalPageFaults++;
    proc.recordPageFault();
    if (this.verbose) {
      console.log(`[EVENT] Page fault: PID=${proc.pid}, VP=${virtualPage}, t=${time}`);
    }

    const frame = this.findFreeFrame() ?? this.evict(time);
    this.load(proc, virtualPage, frame, time);

    result = mmuAccess(proc.pageTable, virtualPage, type);
    if (result.pageFault) {
      throw new Error(`Page fault retry failed: PID=${proc.pid}, VP=${virtualPage}`);
    }
    return true;
  }

  private findFreeFrame(): PhysicalPage | null {
    return this.frames.find((f) => f.isFree()) ?? null;
  }

  private evict(time: number): PhysicalPage {
    const victim = this.strategy.selectVictim(this.frames, time, this.verbose);
    this.totalEvictions++;
    const pte = victim.mappedPTE!;
    const pid = victim.ownerPid!;
    const vp = victim.virtualPageNumber!;

    if (pte.M) {
      this.dirtyWriteBacks++;
      this.backingStore.add(`${pid}:${vp}`);
      if (this.verbose) {
        console.log(`  [DEBUG] Dirty write-back: PID=${pid}, VP=${vp}`);
      }
    }
    pte.invalidate();
    victim.release();
    return victim;
  }

  private load(proc: Process, virtualPage: number, frame: PhysicalPage, time: number): void {
    const pte = proc.pageTable.getPTE(virtualPage);
    const key = `${proc.pid}-${virtualPage}`;

    if (!this.everLoaded.has(key)) {
      this.firstTimeLoads++;
      this.everLoaded.add(key);
    } else if (this.backingStore.has(`${proc.pid}:${virtualPage}`)) {
      this.backingStoreReloads++;
    } else {
      this.cleanReloads++;
    }

    frame.allocate(pte, proc.pid, virtualPage, time);
    pte.P = true;
    pte.R = false;
    pte.M = false;
    pte.PPN = frame.frameId;
    proc.stats.pagesAllocated++;
  }

  terminateProcess(proc: Process): void {
    for (const frame of this.frames) {
      if (frame.busy && frame.ownerPid === proc.pid) {
        frame.mappedPTE!.invalidate();
        frame.release();
        this.strategy.onFrameFreed?.(frame.frameId);
      }
    }
    const bsPrefix = `${proc.pid}:`;
    for (const k of this.backingStore) {
      if (k.startsWith(bsPrefix)) this.backingStore.delete(k);
    }
    const elPrefix = `${proc.pid}-`;
    for (const k of this.everLoaded) {
      if (k.startsWith(elPrefix)) this.everLoaded.delete(k);
    }
    proc.terminated = true;
    if (this.verbose) {
      console.log(`[EVENT] Process PID=${proc.pid} terminated`);
    }
  }

  validateInvariants(processes: Process[] = []): string[] {
    const errors: string[] = [];
    const pteToFrame = new Map<PTE, number>();

    for (const frame of this.frames) {
      if (frame.busy) {
        if (!frame.mappedPTE) {
          errors.push(`Frame ${frame.frameId}: busy but mappedPTE=null`);
          continue;
        }
        const pte = frame.mappedPTE;
        if (!pte.P) errors.push(`Frame ${frame.frameId}: busy but PTE.P=false`);
        if (pte.PPN !== frame.frameId)
          errors.push(`Frame ${frame.frameId}: PTE.PPN=${pte.PPN} != frameId`);
        if (frame.ownerPid === null)
          errors.push(`Frame ${frame.frameId}: busy but ownerPid=null`);
        if (pteToFrame.has(pte))
          errors.push(`Frame ${frame.frameId} and ${pteToFrame.get(pte)}: share same PTE`);
        else pteToFrame.set(pte, frame.frameId);
      } else {
        if (frame.mappedPTE !== null)
          errors.push(`Frame ${frame.frameId}: free but mappedPTE!=null`);
        if (frame.ownerPid !== null)
          errors.push(`Frame ${frame.frameId}: free but ownerPid!=null`);
      }
    }

    for (const proc of processes) {
      if (proc.terminated) continue;
      for (let vp = 0; vp < proc.pageTable.size; vp++) {
        const pte = proc.pageTable.getPTE(vp);
        if (!pte.P) continue;
        if (pte.PPN < 0 || pte.PPN >= this.frames.length) {
          errors.push(`PID=${proc.pid} VP=${vp}: PPN=${pte.PPN} out of range`);
          continue;
        }
        const frame = this.frames[pte.PPN];
        if (!frame.busy) errors.push(`PID=${proc.pid} VP=${vp}: PPN=${pte.PPN} points to free frame`);
        else if (frame.mappedPTE !== pte) errors.push(`PID=${proc.pid} VP=${vp}: frame's PTE mismatch`);
        else if (frame.ownerPid !== proc.pid) errors.push(`PID=${proc.pid} VP=${vp}: frame owned by PID=${frame.ownerPid}`);
        else if (frame.virtualPageNumber !== vp) errors.push(`PID=${proc.pid} VP=${vp}: frame.VP=${frame.virtualPageNumber}`);
      }
    }
    return errors;
  }
}
