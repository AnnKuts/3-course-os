/**
 * Page Table Entry (PTE)
 *
 * CRITICAL INSTRUCTOR REQUIREMENT:
 * Each PTE must contain ONLY these four attributes:
 * - P: presence bit
 * - R: reference/access bit
 * - M: modification/dirty bit
 * - PPN: physical page number
 *
 * NEVER add lastUsed, lastAccessTime, timestamps, access counters,
 * or replacement metadata to the PTE.
 */
export class PTE {
  /** Presence bit: true if virtual page is mapped to a physical frame in RAM */
  public P: boolean = false;

  /** Reference bit: set to true by MMU hardware on each memory access */
  public R: boolean = false;

  /** Modification bit: set to true by MMU hardware on write operations */
  public M: boolean = false;

  /** Physical Page Number: frame index in physical memory when P is true */
  public PPN: number = -1;

  /** Invalidate the mapping */
  invalidate(): void {
    this.P = false;
    this.R = false;
    this.M = false;
    this.PPN = -1;
  }
}
