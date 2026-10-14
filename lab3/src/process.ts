import { PageTable } from './pageTable';
import { WorkingSet } from './workingSet';
import { SeededRNG } from './rng';
import { ProcessConfig, ProcessStats, AccessType, MemoryAccess } from './types';

/**
 * Process — Models an active or scheduled simulated process.
 */
export class Process {
  public readonly pid: number;
  public readonly virtualPages: number;
  public readonly pageTable: PageTable;
  public readonly workingSet: WorkingSet;
  public readonly creationTime: number;
  public readonly lifetime: number;

  public accessesPerformed: number = 0;
  public terminated: boolean = false;
  public stats: ProcessStats;

  private readonly writeProbability: number;
  private readonly rng: SeededRNG;

  constructor(
    pid: number,
    config: ProcessConfig,
    rng: SeededRNG,
    writeProbability: number = 0.3,
    locality: number = 0.9
  ) {
    this.pid = pid;
    this.virtualPages = config.virtualPages;
    this.pageTable = new PageTable(config.virtualPages);
    this.creationTime = config.creationTime;
    this.lifetime = config.lifetime;
    this.writeProbability = writeProbability;
    this.rng = rng;

    this.workingSet = new WorkingSet(
      config.virtualPages,
      config.workingSetSize,
      config.workingSetChangeInterval,
      rng,
      locality
    );

    this.stats = {
      pid,
      totalAccesses: 0,
      pageFaults: 0,
      pagesAllocated: 0,
    };
  }

  /**
   * Generates the next memory access (virtual page and READ/WRITE).
   */
  generateAccess(): MemoryAccess {
    const virtualPage = this.workingSet.getNextPage(this.rng);
    const type = this.rng.chance(this.writeProbability)
      ? AccessType.WRITE
      : AccessType.READ;
    return { pid: this.pid, virtualPage, type };
  }

  /**
   * Checks and performs working set shift if required.
   */
  checkWorkingSetChange(): boolean {
    if (this.workingSet.shouldChange()) {
      this.workingSet.generateNewSet(this.rng);
      return true;
    }
    return false;
  }

  isFinished(): boolean {
    return this.accessesPerformed >= this.lifetime;
  }

  recordAccess(): void {
    this.accessesPerformed++;
    this.stats.totalAccesses++;
  }

  recordPageFault(): void {
    this.stats.pageFaults++;
  }
}
