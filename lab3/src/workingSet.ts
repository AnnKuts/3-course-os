import { SeededRNG } from './rng';

/**
 * WorkingSet — Simulates page locality and working set evolution.
 *
 * Characteristics:
 * - 90% of accesses target pages from the current working set.
 * - 10% of accesses target uniformly random pages across the entire address space.
 * - Working set shifts periodically every `changeInterval` accesses.
 */
export class WorkingSet {
  private currentPages: number[] = [];
  public readonly virtualPages: number;
  public readonly wsSize: number;
  public readonly changeInterval: number;
  public readonly locality: number;
  private accessesSinceChange: number = 0;

  constructor(
    virtualPages: number,
    wsSize: number,
    changeInterval: number,
    rng: SeededRNG,
    locality: number = 0.9
  ) {
    this.virtualPages = virtualPages;
    this.wsSize = Math.max(1, Math.min(wsSize, virtualPages));
    this.changeInterval = changeInterval;
    this.locality = locality;
    this.generateNewSet(rng);
  }

  /**
   * Randomly picks a new set of active pages.
   */
  public generateNewSet(rng: SeededRNG): void {
    const pageSet = new Set<number>();
    while (pageSet.size < this.wsSize && pageSet.size < this.virtualPages) {
      pageSet.add(rng.nextInt(this.virtualPages));
    }
    this.currentPages = Array.from(pageSet);
    this.accessesSinceChange = 0;
  }

  /**
   * Generates next virtual page number based on locality rules.
   */
  public getNextPage(rng: SeededRNG): number {
    this.accessesSinceChange++;

    // 90% locality to active working set (if available)
    if (this.currentPages.length > 0 && rng.chance(this.locality)) {
      const idx = rng.nextInt(this.currentPages.length);
      return this.currentPages[idx];
    }

    // 10% uniform random across entire virtual address space
    return rng.nextInt(this.virtualPages);
  }

  /**
   * Checks whether it is time to regenerate the working set.
   */
  public shouldChange(): boolean {
    return this.accessesSinceChange >= this.changeInterval;
  }

  public getCurrentPages(): readonly number[] {
    return this.currentPages;
  }
}
