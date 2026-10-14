import { PhysicalPage } from './physicalPage';
import { ReplacementStrategy } from './replacementStrategy';
import { Logger } from './logger';

/**
 * WSClock (Working Set Clock) Page Replacement Algorithm.
 *
 * Implements a global circular clock hand over physical frames.
 * Parameter TAU represents the working set window measured in logical memory accesses.
 *
 * Inspection rules (per lecture and Carr & Hennessy):
 * - If frame is free: skip and advance.
 * - If R = 1:
 *     Clear R bit to 0.
 *     Update PhysicalPage.lastAccessTime = currentTime.
 *     Advance hand and continue scanning.
 * - If R = 0:
 *     age = currentTime - PhysicalPage.lastAccessTime
 *     If age > TAU:
 *       If M = 0 (clean): immediate victim. Advance hand past victim and return frame.
 *       If M = 1 (dirty): track as candidate for write-back.
 *     If age <= TAU:
 *       Page is in current working set; advance hand.
 *
 * Terminating Fallback Policy (as clarified by instructor):
 * If a complete cycle yields no clean page with age > TAU:
 * 1. Return the oldest dirty candidate with age > TAU if any was found.
 * 2. Return the first unreferenced page (R=0) encountered during the scan.
 * 3. Return the first busy page encountered from the clock hand ("беремо першу сторінку за списком").
 *
 * Clock hand is always advanced past the evicted frame.
 */
export class WSClockReplacement implements ReplacementStrategy {
  public readonly name: string = 'WSClock';
  public readonly tau: number;
  private clockHand: number = 0;

  constructor(tau: number) {
    this.tau = tau;
  }

  getClockHand(): number {
    return this.clockHand;
  }

  setClockHand(hand: number): void {
    this.clockHand = hand;
  }

  selectVictim(
    frames: PhysicalPage[],
    currentTime: number,
    logger: Logger
  ): PhysicalPage {
    const numFrames = frames.length;
    if (numFrames === 0) {
      throw new Error('WSClock: No physical frames in system');
    }

    let scannedCount = 0;
    let oldestDirtyCandidate: PhysicalPage | null = null;
    let oldestDirtyAge: number = -1;
    let firstUnreferencedFrame: PhysicalPage | null = null;
    const initialHand = this.clockHand % numFrames;

    // Scan one complete cycle of frames
    while (scannedCount < numFrames) {
      const idx = (initialHand + scannedCount) % numFrames;
      const frame = frames[idx];

      if (!frame.busy) {
        scannedCount++;
        continue;
      }

      const pte = frame.mappedPTE!;

      // Case 1: R = 1 (recently referenced)
      if (pte.R) {
        pte.R = false;
        frame.lastAccessTime = currentTime;
        logger.debug(
          `WSClock: frame ${frame.frameId} has R=1 -> cleared R, updated lastAccessTime=${currentTime}`
        );
        scannedCount++;
        continue;
      }

      // Case 2: R = 0
      if (firstUnreferencedFrame === null) {
        firstUnreferencedFrame = frame;
      }

      const age = currentTime - frame.lastAccessTime;

      if (age > this.tau) {
        // Page is outside working set window
        if (!pte.M) {
          // Clean page: immediately evict
          logger.debug(
            `WSClock: frame ${frame.frameId} (clean, age=${age} > TAU=${this.tau}) selected for eviction`
          );
          this.clockHand = (frame.frameId + 1) % numFrames;
          return frame;
        } else {
          // Dirty page: record candidate
          logger.debug(
            `WSClock: frame ${frame.frameId} (dirty, age=${age} > TAU=${this.tau}) marked as dirty candidate`
          );
          if (oldestDirtyCandidate === null || age > oldestDirtyAge) {
            oldestDirtyCandidate = frame;
            oldestDirtyAge = age;
          }
        }
      }

      scannedCount++;
    }

    // Fallback 1: Oldest dirty candidate outside working set
    if (oldestDirtyCandidate) {
      logger.debug(
        `WSClock fallback: evicting oldest dirty candidate frame ${oldestDirtyCandidate.frameId} (age=${oldestDirtyAge})`
      );
      this.clockHand = (oldestDirtyCandidate.frameId + 1) % numFrames;
      return oldestDirtyCandidate;
    }

    // Fallback 2: First unreferenced page seen during scan
    if (firstUnreferencedFrame) {
      logger.debug(
        `WSClock fallback: evicting first unreferenced frame ${firstUnreferencedFrame.frameId}`
      );
      this.clockHand = (firstUnreferencedFrame.frameId + 1) % numFrames;
      return firstUnreferencedFrame;
    }

    // Fallback 3: First busy frame encountered starting from initial hand
    for (let i = 0; i < numFrames; i++) {
      const idx = (initialHand + i) % numFrames;
      const frame = frames[idx];
      if (frame.busy) {
        logger.debug(
          `WSClock fallback: evicting first busy frame ${frame.frameId}`
        );
        this.clockHand = (frame.frameId + 1) % numFrames;
        return frame;
      }
    }

    throw new Error('WSClock: No busy frames found to evict');
  }

  onFrameFreed(frameId: number): void {
    // When a frame is released, clock hand remains valid as it wraps modulo numFrames
    // and explicitly skips non-busy frames.
  }
}
