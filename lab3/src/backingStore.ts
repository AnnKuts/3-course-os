/**
 * BackingStore — Simulated backing store (swap space / file system).
 *
 * Tracks which virtual pages have been previously saved to disk.
 * Allows distinguishing first-time page loading from restoring previously
 * saved page contents.
 *
 * Kept completely separate from the PTE to avoid adding non-standard attributes.
 */
export class BackingStore {
  /**
   * Set of keys formatted as "${pid}:${virtualPage}" representing
   * pages saved to backing store.
   */
  private readonly savedPages = new Set<string>();

  private makeKey(pid: number, virtualPage: number): string {
    return `${pid}:${virtualPage}`;
  }

  /**
   * Record that a page was written to the backing store (e.g. dirty page eviction).
   */
  savePage(pid: number, virtualPage: number): void {
    this.savedPages.add(this.makeKey(pid, virtualPage));
  }

  /**
   * Check whether this virtual page was previously saved to backing store.
   */
  hasSavedPage(pid: number, virtualPage: number): boolean {
    return this.savedPages.has(this.makeKey(pid, virtualPage));
  }

  /**
   * Clean up all saved pages belonging to a terminated process.
   */
  removeProcess(pid: number): void {
    const prefix = `${pid}:`;
    for (const key of this.savedPages) {
      if (key.startsWith(prefix)) {
        this.savedPages.delete(key);
      }
    }
  }

  /**
   * Clear all records.
   */
  clear(): void {
    this.savedPages.clear();
  }
}
