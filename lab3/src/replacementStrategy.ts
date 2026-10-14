import { PhysicalPage } from './physicalPage';
import { Logger } from './logger';

/**
 * Strategy interface for global page replacement algorithms.
 */
export interface ReplacementStrategy {
  /** Name of the algorithm */
  readonly name: string;

  /**
   * Select a victim physical frame to evict.
   *
   * @param frames All physical frame descriptors in the system
   * @param currentTime Current simulation time (in memory accesses)
   * @param logger Logger for recording decisions
   * @returns Selected victim PhysicalPage
   */
  selectVictim(
    frames: PhysicalPage[],
    currentTime: number,
    logger: Logger
  ): PhysicalPage;

  /**
   * Optional callback when a physical frame is freed (e.g. process termination).
   */
  onFrameFreed?(frameId: number): void;
}
