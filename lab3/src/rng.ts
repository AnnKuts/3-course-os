/**
 * Seeded Pseudo-Random Number Generator.
 * Uses the Mulberry32 algorithm for fast, high-quality 32-bit PRNG.
 */
export class SeededRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /**
   * Returns a pseudo-random floating point number in [0, 1).
   */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Returns a pseudo-random integer in [0, max).
   */
  nextInt(max: number): number {
    if (max <= 0) return 0;
    return Math.floor(this.next() * max);
  }

  /**
   * Returns true with the given probability p in [0, 1].
   */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /**
   * Clone the current RNG state.
   */
  clone(): SeededRNG {
    const copy = new SeededRNG(0);
    copy.state = this.state;
    return copy;
  }

  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }
}
