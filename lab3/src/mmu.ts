import { PTE } from './pte';
import { PageTable } from './pageTable';
import { AccessType } from './types';

export interface MMUResult {
  /** True if virtual page is not mapped to physical memory */
  pageFault: boolean;
  /** The accessed PTE */
  pte: PTE;
  /** Physical page number (valid only when pageFault is false) */
  ppn: number;
}

/**
 * MMU — Hardware Memory Management Unit simulation.
 *
 * CRITICAL HARDWARE VS SOFTWARE SEPARATION:
 * - Operates strictly on PTE hardware fields (P, R, M, PPN).
 * - MUST NOT access PhysicalPage descriptors.
 * - MUST NOT update lastAccessTime.
 * - MUST NOT know the current system timestamp.
 * - MUST NOT select replacement victims.
 * - MUST NOT manage physical memory allocations.
 */
export class MMU {
  /**
   * Attempts logical address translation for a virtual page.
   *
   * @param pageTable Process page table
   * @param virtualPage Virtual page number
   * @param accessType READ or WRITE
   * @returns MMUResult indicating whether a page fault occurred
   */
  access(
    pageTable: PageTable,
    virtualPage: number,
    accessType: AccessType
  ): MMUResult {
    const pte = pageTable.getPTE(virtualPage);

    if (!pte.P) {
      // Page fault: page is not in physical memory
      return { pageFault: true, pte, ppn: -1 };
    }

    // Hardware sets reference bit on any access
    pte.R = true;

    // Hardware sets modification bit on write access
    if (accessType === AccessType.WRITE) {
      pte.M = true;
    }

    return { pageFault: false, pte, ppn: pte.PPN };
  }
}
