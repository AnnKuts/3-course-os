import { PhysicalPage } from './physicalPage';
import { BackingStore } from './backingStore';
import { ReplacementStrategy } from './replacementStrategy';
import { Process } from './process';
import { PTE } from './pte';
import { AccessType } from './types';
import { Logger } from './logger';
import { MMU, MMUResult } from './mmu';

/**
 * Kernel — Software component responsible for:
 * - Process creation and termination
 * - Page fault handling
 * - Physical frame management
 * - Global page replacement
 * - Page mapping and unmapping
 * - Backing store operations
 */
export class Kernel {
  private readonly frames: PhysicalPage[];
  private readonly backingStore: BackingStore;
  private replacementStrategy: ReplacementStrategy;
  private readonly logger: Logger;
  private readonly mmu: MMU;

  // Statistics
  public totalPageFaults: number = 0;
  public totalEvictions: number = 0;
  public dirtyWriteBacks: number = 0;
  public firstTimeLoads: number = 0;
  public backingStoreReloads: number = 0;

  constructor(
    numFrames: number,
    replacementStrategy: ReplacementStrategy,
    logger: Logger,
    mmu: MMU,
  ) {
    this.frames = [];
    for (let i = 0; i < numFrames; i++) {
      this.frames.push(new PhysicalPage(i));
    }
    this.backingStore = new BackingStore();
    this.replacementStrategy = replacementStrategy;
    this.logger = logger;
    this.mmu = mmu;
  }

  /** Set/change the replacement strategy */
  setReplacementStrategy(strategy: ReplacementStrategy): void {
    this.replacementStrategy = strategy;
  }

  /** Get all physical frames (for algorithms/testing) */
  getFrames(): PhysicalPage[] {
    return this.frames;
  }

  /** Get the backing store (for testing) */
  getBackingStore(): BackingStore {
    return this.backingStore;
  }

  /**
   * Handle a memory access for a process.
   * Coordinates with MMU for address translation.
   * Handles page faults when they occur.
   * 
   * A page fault + retry = ONE logical memory access (no double time increment).
   * 
   * @returns true if a page fault occurred
   */
  handleMemoryAccess(
    process: Process,
    virtualPage: number,
    accessType: AccessType,
    currentTime: number,
  ): boolean {
    // Step 1: MMU attempts address translation
    let result: MMUResult = this.mmu.access(process.pageTable, virtualPage, accessType);

    if (result.pageFault) {
      // Step 2: Handle page fault (software / kernel)
      this.totalPageFaults++;
      process.recordPageFault();

      this.logger.debug(
        `Page fault: PID=${process.pid}, VP=${virtualPage}, time=${currentTime}`
      );

      this.handlePageFault(process, virtualPage, currentTime);

      // Step 3: Retry the access — MMU now succeeds
      result = this.mmu.access(process.pageTable, virtualPage, accessType);
      if (result.pageFault) {
        throw new Error(
          `Page fault retry failed: PID=${process.pid}, VP=${virtualPage}`
        );
      }

      return true; // page fault occurred
    }

    return false; // no page fault
  }

  /**
   * Handle a page fault — allocate or evict, load the page.
   */
  private handlePageFault(
    process: Process,
    virtualPage: number,
    currentTime: number,
  ): void {
    // Try to find a free frame
    let frame = this.findFreeFrame();

    if (frame) {
      this.logger.debug(`Allocated free frame ${frame.frameId}`);
    } else {
      // No free frame — invoke page replacement
      frame = this.evictPage(currentTime);
    }

    // Load the new page into the frame
    this.loadPage(process, virtualPage, frame, currentTime);
  }

  /** Find a free physical frame, or return null */
  private findFreeFrame(): PhysicalPage | null {
    for (const frame of this.frames) {
      if (frame.isFree()) {
        return frame;
      }
    }
    return null;
  }

  /**
   * Evict a page using the configured replacement strategy.
   * If the evicted page is dirty, write it back to backing store.
   */
  private evictPage(currentTime: number): PhysicalPage {
    const victim = this.replacementStrategy.selectVictim(
      this.frames,
      currentTime,
      this.logger,
    );

    this.totalEvictions++;

    const pte = victim.mappedPTE!;
    const pid = victim.ownerPid!;
    const vp = victim.virtualPageNumber!;

    this.logger.debug(
      `Evicting: frame ${victim.frameId}, PID=${pid}, VP=${vp}, ` +
      `R=${pte.R ? 1 : 0}, M=${pte.M ? 1 : 0}`
    );

    // If dirty, write back to backing store
    if (pte.M) {
      this.dirtyWriteBacks++;
      this.backingStore.savePage(pid, vp);
      this.logger.debug(
        `Dirty write-back: PID=${pid}, VP=${vp} → backing store`
      );
    }

    // Invalidate the old mapping
    pte.invalidate();

    // Release the frame
    victim.release();

    return victim;
  }

  /**
   * Load a virtual page into a physical frame.
   * Update PTE and PhysicalPage descriptor.
   */
  private loadPage(
    process: Process,
    virtualPage: number,
    frame: PhysicalPage,
    currentTime: number,
  ): void {
    const pte = process.pageTable.getPTE(virtualPage);

    // Track whether this is a first-time load or a reload
    if (this.backingStore.hasSavedPage(process.pid, virtualPage)) {
      this.backingStoreReloads++;
      this.logger.debug(
        `Backing store reload: PID=${process.pid}, VP=${virtualPage} → frame ${frame.frameId}`
      );
    } else {
      this.firstTimeLoads++;
      this.logger.debug(
        `First-time load: PID=${process.pid}, VP=${virtualPage} → frame ${frame.frameId}`
      );
    }

    // Allocate the frame
    frame.allocate(pte, process.pid, virtualPage, currentTime);

    // Update PTE
    pte.P = true;
    pte.R = false;
    pte.M = false;
    pte.PPN = frame.frameId;

    process.stats.pagesAllocated++;
  }

  /**
   * Terminate a process — release ALL its physical frames and invalidate mappings.
   */
  terminateProcess(process: Process): void {
    this.logger.event(
      `Process PID=${process.pid} terminating, releasing frames`
    );

    let framesReleased = 0;
    for (const frame of this.frames) {
      if (frame.busy && frame.ownerPid === process.pid) {
        const pte = frame.mappedPTE!;
        pte.invalidate();
        frame.release();
        if (this.replacementStrategy.onFrameFreed) {
          this.replacementStrategy.onFrameFreed(frame.frameId);
        }
        framesReleased++;
      }
    }

    // Clean up backing store for this process
    this.backingStore.removeProcess(process.pid);

    this.logger.debug(
      `PID=${process.pid}: released ${framesReleased} frames`
    );

    process.terminated = true;
  }

  /** Reset all statistics (for running multiple experiments) */
  resetStats(): void {
    this.totalPageFaults = 0;
    this.totalEvictions = 0;
    this.dirtyWriteBacks = 0;
    this.firstTimeLoads = 0;
    this.backingStoreReloads = 0;
  }

  /** Reset all physical frames */
  resetFrames(): void {
    for (const frame of this.frames) {
      if (frame.busy && frame.mappedPTE) {
        frame.mappedPTE.invalidate();
      }
      frame.release();
    }
  }

  /**
   * Validate invariants (for testing and debug mode)
   */
  validateInvariants(): string[] {
    const errors: string[] = [];

    // Every busy frame must have exactly one valid mapping
    for (const frame of this.frames) {
      if (frame.busy) {
        if (!frame.mappedPTE) {
          errors.push(`Frame ${frame.frameId}: busy but no mapped PTE`);
        } else if (!frame.mappedPTE.P) {
          errors.push(`Frame ${frame.frameId}: busy but PTE.P=false`);
        } else if (frame.mappedPTE.PPN !== frame.frameId) {
          errors.push(
            `Frame ${frame.frameId}: PTE.PPN=${frame.mappedPTE.PPN} mismatch`
          );
        }
        if (frame.ownerPid === null) {
          errors.push(`Frame ${frame.frameId}: busy but no ownerPid`);
        }
      } else {
        // Free frame must have no mapping
        if (frame.mappedPTE !== null) {
          errors.push(`Frame ${frame.frameId}: free but has mapped PTE`);
        }
        if (frame.ownerPid !== null) {
          errors.push(`Frame ${frame.frameId}: free but has ownerPid`);
        }
      }
    }

    // No two busy frames should have the same PTE
    const pteSet = new Set<PTE>();
    for (const frame of this.frames) {
      if (frame.busy && frame.mappedPTE) {
        if (pteSet.has(frame.mappedPTE)) {
          errors.push(
            `Frame ${frame.frameId}: PTE is shared with another frame`
          );
        }
        pteSet.add(frame.mappedPTE);
      }
    }

    return errors;
  }
}
