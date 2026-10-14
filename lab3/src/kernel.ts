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
  private readonly debugMode: boolean;

  /**
   * Tracks which virtual pages have ever been loaded into physical memory
   * during the lifetime of the process. Key = "${pid}-${vp}".
   *
   * This is separate from BackingStore: a page can be in everLoaded but NOT in
   * BackingStore if it was evicted clean (no write-back occurred). That
   * situation counts as a "clean reload", not a first-time load and not a
   * backing-store reload.
   */
  private readonly everLoaded: Set<string>;

  // ── Statistics ────────────────────────────────────────────────────────────
  public totalPageFaults: number = 0;
  public totalEvictions: number = 0;
  public dirtyWriteBacks: number = 0;
  /** Pages loaded for the very first time (never previously mapped). */
  public firstTimeLoads: number = 0;
  /**
   * Pages reloaded into memory after being evicted clean (no backing-store
   * entry exists, yet the page was previously mapped at least once).
   */
  public cleanReloads: number = 0;
  /**
   * Pages restored from the simulated backing store (evicted dirty ⇒
   * write-back occurred; now reloaded).
   */
  public backingStoreReloads: number = 0;

  constructor(
    numFrames: number,
    replacementStrategy: ReplacementStrategy,
    logger: Logger,
    mmu: MMU,
    debugMode: boolean = false,
  ) {
    this.frames = [];
    for (let i = 0; i < numFrames; i++) {
      this.frames.push(new PhysicalPage(i));
    }
    this.backingStore = new BackingStore();
    this.replacementStrategy = replacementStrategy;
    this.logger = logger;
    this.mmu = mmu;
    this.debugMode = debugMode;
    this.everLoaded = new Set<string>();
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

      // Step 3 (debug mode): validate after every page fault to catch bugs early
      if (this.debugMode) {
        // Pass array with current process to verify bidirectional mappings
        const errors = this.validateInvariants([process]);
        if (errors.length > 0) {
          throw new Error(`CRITICAL: Invariants violated during simulation!\n${errors.join('\n')}`);
        }
      }

      // Step 4: Retry the access — MMU now succeeds
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
   *
   * Statistics classification:
   *  - firstTimeLoads   : page never previously mapped (everLoaded does NOT contain key).
   *  - backingStoreReloads : page was evicted dirty and saved to backing store.
   *  - cleanReloads     : page was evicted clean (no backing-store write), reloaded now.
   *
   * Invariant: firstTimeLoads + cleanReloads + backingStoreReloads == totalPageFaults
   */
  private loadPage(
    process: Process,
    virtualPage: number,
    frame: PhysicalPage,
    currentTime: number,
  ): void {
    const pte = process.pageTable.getPTE(virtualPage);
    const pageKey = `${process.pid}-${virtualPage}`;

    if (!this.everLoaded.has(pageKey)) {
      // ── First-time load ────────────────────────────────────────────────
      this.firstTimeLoads++;
      this.everLoaded.add(pageKey);
      this.logger.debug(
        `First-time load: PID=${process.pid}, VP=${virtualPage} → frame ${frame.frameId}`
      );
    } else if (this.backingStore.hasSavedPage(process.pid, virtualPage)) {
      // ── Backing-store reload (was evicted dirty) ───────────────────────
      this.backingStoreReloads++;
      this.logger.debug(
        `Backing-store reload: PID=${process.pid}, VP=${virtualPage} → frame ${frame.frameId}`
      );
    } else {
      // ── Clean reload (was evicted without write-back) ──────────────────
      this.cleanReloads++;
      this.logger.debug(
        `Clean reload: PID=${process.pid}, VP=${virtualPage} → frame ${frame.frameId}`
      );
    }

    // Allocate the frame — this sets lastAccessTime in the PhysicalPage descriptor
    // (never in the PTE, per instructor requirement).
    frame.allocate(pte, process.pid, virtualPage, currentTime);

    // Update PTE (hardware-visible fields only: P, R, M, PPN)
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

    // Clean up everLoaded metadata for this process
    const pidPrefix = `${process.pid}-`;
    for (const key of Array.from(this.everLoaded)) {
      if (key.startsWith(pidPrefix)) {
        this.everLoaded.delete(key);
      }
    }

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
    this.cleanReloads = 0;
    this.backingStoreReloads = 0;
    this.everLoaded.clear();
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
   * Validate memory system invariants.
   *
   * Checks in BOTH directions:
   *   1. PhysicalPage → PTE:  every busy frame has a consistent, present PTE.
   *   2. PTE → PhysicalPage:  every present PTE whose owning process is known
   *      maps to the correct busy frame.
   *   3. No two present PTEs map to the same physical frame.
   *   4. Free frames have no mapping metadata.
   *
   * @param processList Optional list of active processes for the reverse check.
   */
  validateInvariants(processList?: Process[]): string[] {
    const errors: string[] = [];

    // ── Forward check: PhysicalPage → PTE ─────────────────────────────────
    const frameByPTE = new Map<PTE, number>(); // PTE → frameId

    for (const frame of this.frames) {
      if (frame.busy) {
        if (!frame.mappedPTE) {
          errors.push(`Frame ${frame.frameId}: busy but mappedPTE is null`);
          continue;
        }
        const pte = frame.mappedPTE;
        if (!pte.P) {
          errors.push(`Frame ${frame.frameId}: busy but PTE.P=false`);
        }
        if (pte.PPN !== frame.frameId) {
          errors.push(
            `Frame ${frame.frameId}: PTE.PPN=${pte.PPN} does not match frameId`
          );
        }
        if (frame.ownerPid === null) {
          errors.push(`Frame ${frame.frameId}: busy but ownerPid is null`);
        }
        // Detect shared PTE (two frames pointing to the same PTE)
        if (frameByPTE.has(pte)) {
          errors.push(
            `Frame ${frame.frameId} and Frame ${frameByPTE.get(pte)}: ` +
            `both reference the same PTE (PPN=${pte.PPN})`
          );
        } else {
          frameByPTE.set(pte, frame.frameId);
        }
      } else {
        // Free frame must have no mapping
        if (frame.mappedPTE !== null) {
          errors.push(`Frame ${frame.frameId}: free but mappedPTE is not null`);
        }
        if (frame.ownerPid !== null) {
          errors.push(`Frame ${frame.frameId}: free but ownerPid is not null`);
        }
      }
    }

    // ── Reverse check: present PTE → PhysicalPage ─────────────────────────
    // For every present PTE in every known process, verify:
    //   - The PPN it refers to is a valid frame index.
    //   - That frame is busy and maps back to this exact PTE.
    if (processList && processList.length > 0) {
      for (const proc of processList) {
        if (proc.terminated) continue;
        for (let vp = 0; vp < proc.pageTable.size; vp++) {
          const pte = proc.pageTable.getPTE(vp);
          if (!pte.P) continue;

          const ppn = pte.PPN;
          if (ppn < 0 || ppn >= this.frames.length) {
            errors.push(
              `PID=${proc.pid} VP=${vp}: PTE.PPN=${ppn} out of range [0, ${this.frames.length - 1}]`
            );
            continue;
          }

          const frame = this.frames[ppn];
          if (!frame.busy) {
            errors.push(
              `PID=${proc.pid} VP=${vp}: PTE.PPN=${ppn} points to a FREE frame`
            );
          } else if (frame.mappedPTE !== pte) {
            errors.push(
              `PID=${proc.pid} VP=${vp}: PTE.PPN=${ppn} — frame's mappedPTE is a DIFFERENT object`
            );
          } else if (frame.ownerPid !== proc.pid) {
            errors.push(
              `PID=${proc.pid} VP=${vp}: PTE.PPN=${ppn} — frame is owned by PID=${frame.ownerPid}`
            );
          } else if (frame.virtualPageNumber !== vp) {
            errors.push(
              `PID=${proc.pid} VP=${vp}: PTE.PPN=${ppn} — frame.virtualPageNumber=${frame.virtualPageNumber}`
            );
          }
        }
      }
    }

    return errors;
  }
}