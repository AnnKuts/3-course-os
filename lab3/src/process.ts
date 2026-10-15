import { PageTable } from './memory';
import { SeededRNG } from './rng';

export enum AccessType { READ = 'READ', WRITE = 'WRITE' }

export interface MemoryAccess {
  pid: number;
  virtualPage: number;
  type: AccessType;
}

export interface ProcessConfig {
  creationTime: number;
  lifetime: number;
  virtualPages: number;
  workingSetSize: number;
  workingSetChangeInterval: number;
}

export interface ProcessStats {
  pid: number;
  totalAccesses: number;
  pageFaults: number;
  pagesAllocated: number;
}

// ---------------------------------------------------------------------------
// Робочий набір — моделює локальність звернень
// ---------------------------------------------------------------------------
class WorkingSet {
  private currentPages: number[] = [];
  private accessesSinceChange: number = 0;
  public readonly wsSize: number;
  public readonly changeInterval: number;
  private readonly locality: number;
  private readonly totalPages: number;

  constructor(
    totalPages: number,
    wsSize: number,
    changeInterval: number,
    rng: SeededRNG,
    locality: number = 0.9
  ) {
    this.totalPages = totalPages;
    this.wsSize = Math.max(1, Math.min(wsSize, totalPages));
    this.changeInterval = changeInterval;
    this.locality = locality;
    this.regenerate(rng);
  }

  regenerate(rng: SeededRNG): void {
    const set = new Set<number>();
    while (set.size < this.wsSize && set.size < this.totalPages) {
      set.add(rng.nextInt(this.totalPages));
    }
    this.currentPages = Array.from(set);
    this.accessesSinceChange = 0;
  }

  nextPage(rng: SeededRNG): number {
    this.accessesSinceChange++;
    if (this.currentPages.length > 0 && rng.chance(this.locality)) {
      return this.currentPages[rng.nextInt(this.currentPages.length)];
    }
    return rng.nextInt(this.totalPages);
  }

  shouldChange(): boolean {
    return this.accessesSinceChange >= this.changeInterval;
  }

  getCurrentPages(): readonly number[] {
    return this.currentPages;
  }
}

// ---------------------------------------------------------------------------
// Процес — керує таблицею сторінок, робочим набором та статистикою
// ---------------------------------------------------------------------------
export class Process {
  public readonly pid: number;
  public readonly virtualPages: number;
  public readonly pageTable: PageTable;
  public readonly lifetime: number;
  public readonly creationTime: number;
  public accessesPerformed: number = 0;
  public terminated: boolean = false;
  public stats: ProcessStats;

  private readonly workingSet: WorkingSet;
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
    this.lifetime = config.lifetime;
    this.creationTime = config.creationTime;
    this.writeProbability = writeProbability;
    this.rng = rng;
    this.workingSet = new WorkingSet(
      config.virtualPages,
      config.workingSetSize,
      config.workingSetChangeInterval,
      rng,
      locality
    );
    this.stats = { pid, totalAccesses: 0, pageFaults: 0, pagesAllocated: 0 };
  }

  generateAccess(): MemoryAccess {
    const virtualPage = this.workingSet.nextPage(this.rng);
    const type = this.rng.chance(this.writeProbability) ? AccessType.WRITE : AccessType.READ;
    return { pid: this.pid, virtualPage, type };
  }

  checkWorkingSetChange(): boolean {
    if (this.workingSet.shouldChange()) {
      this.workingSet.regenerate(this.rng);
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

  getWorkingSetPages(): readonly number[] {
    return this.workingSet.getCurrentPages();
  }
}
