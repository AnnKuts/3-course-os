import { PTE } from './pte';

/**
 * PhysicalPage — Physical Frame Descriptor
 *
 * Represents a physical frame in RAM.
 *
 * Contains:
 * - Physical frame ID
 * - Status: free or busy
 * - Back-reference to the mapped PTE
 * - Information identifying the owning process or mapping
 * - lastAccessTime: used by WSClock
 *
 * CRITICAL INSTRUCTOR REQUIREMENT:
 * The lastAccessTime attribute belongs to the PhysicalPage descriptor, NEVER to the PTE.
 */
export class PhysicalPage {
  /** Physical frame identifier (0 .. N-1) */
  public readonly frameId: number;

  /** Status: true if currently allocated to a virtual page */
  public busy: boolean = false;

  /** Back-reference to the mapped PTE (null when free) */
  public mappedPTE: PTE | null = null;

  /** Process ID owning this physical frame (null when free) */
  public ownerPid: number | null = null;

  /** Virtual page number mapped to this frame (null when free) */
  public virtualPageNumber: number | null = null;

  /**
   * Last access time (in logical simulation memory accesses).
   * Initialized by Kernel on mapping.
   * Updated by WSClock when inspecting a page with R = 1.
   * MMU NEVER updates this attribute.
   */
  public lastAccessTime: number = 0;

  constructor(frameId: number) {
    this.frameId = frameId;
  }

  isFree(): boolean {
    return !this.busy;
  }

  /**
   * Release the frame and clear all mapping references.
   */
  release(): void {
    this.busy = false;
    this.mappedPTE = null;
    this.ownerPid = null;
    this.virtualPageNumber = null;
    this.lastAccessTime = 0;
  }

  /**
   * Allocate the frame to a specific process and virtual page.
   */
  allocate(
    pte: PTE,
    pid: number,
    virtualPage: number,
    currentTime: number
  ): void {
    this.busy = true;
    this.mappedPTE = pte;
    this.ownerPid = pid;
    this.virtualPageNumber = virtualPage;
    this.lastAccessTime = currentTime;
  }
}
