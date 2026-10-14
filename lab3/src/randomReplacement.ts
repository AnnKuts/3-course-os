import { PhysicalPage } from './physicalPage';
import { ReplacementStrategy } from './replacementStrategy';
import { SeededRNG } from './rng';
import { Logger } from './logger';

/**
 * Random Page Replacement Policy.
 *
 * Selects a uniformly random busy physical frame for eviction.
 * Completely ignores usage history, reference bits, and working set locality.
 * Uses a seeded PRNG for reproducible experiments.
 */
export class RandomReplacement implements ReplacementStrategy {
  public readonly name: string = 'Random';
  private readonly rng: SeededRNG;

  constructor(rng: SeededRNG) {
    this.rng = rng;
  }

  selectVictim(
    frames: PhysicalPage[],
    currentTime: number,
    logger: Logger
  ): PhysicalPage {
    const busyFrames = frames.filter((f) => f.busy);
    if (busyFrames.length === 0) {
      throw new Error('RandomReplacement: No busy frames available for eviction');
    }

    const index = this.rng.nextInt(busyFrames.length);
    const victim = busyFrames[index];

    logger.debug(
      `Random: chose frame ${victim.frameId} (PID=${victim.ownerPid}, VP=${victim.virtualPageNumber})`
    );

    return victim;
  }
}
