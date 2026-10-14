import { PTE } from './pte';

/**
 * PageTable — represents a process's page table.
 * Implemented as a one-dimensional array of PTEs.
 * Belongs to one specific process.
 */
export class PageTable {
  public readonly entries: PTE[];
  public readonly size: number;

  constructor(numVirtualPages: number) {
    this.size = numVirtualPages;
    this.entries = new Array<PTE>(numVirtualPages);
    for (let i = 0; i < numVirtualPages; i++) {
      this.entries[i] = new PTE();
    }
  }

  /**
   * Get the PTE corresponding to a virtual page number.
   */
  getPTE(virtualPage: number): PTE {
    if (virtualPage < 0 || virtualPage >= this.size) {
      throw new Error(
        `Invalid virtual page ${virtualPage} for page table of size ${this.size}`
      );
    }
    return this.entries[virtualPage];
  }
}
