// ---------------------------------------------------------------------------
// Запис у таблиці сторінок (Page Table Entry)
// Поля: P (Present), R (Referenced), M (Modified/Dirty), PPN (physical page #)
// ---------------------------------------------------------------------------
export class PTE {
  public P: boolean = false;
  public R: boolean = false;
  public M: boolean = false;
  public PPN: number = -1;

  invalidate(): void {
    this.P = false;
    this.R = false;
    this.M = false;
    this.PPN = -1;
  }
}

// ---------------------------------------------------------------------------
// Таблиця сторінок процесу
// ---------------------------------------------------------------------------
export class PageTable {
  public readonly entries: PTE[];
  public readonly size: number;

  constructor(numVirtualPages: number) {
    this.size = numVirtualPages;
    this.entries = Array.from({ length: numVirtualPages }, () => new PTE());
  }

  getPTE(virtualPage: number): PTE {
    if (virtualPage < 0 || virtualPage >= this.size) {
      throw new Error(
        `Invalid virtual page ${virtualPage} for page table of size ${this.size}`
      );
    }
    return this.entries[virtualPage];
  }
}

// ---------------------------------------------------------------------------
// Дескриптор фізичного фрейму оперативної пам'яті
// Зберігає lastAccessTime для WSClock (не в PTE — це апаратне поле)
// ---------------------------------------------------------------------------
export class PhysicalPage {
  public readonly frameId: number;
  public busy: boolean = false;
  public mappedPTE: PTE | null = null;
  public ownerPid: number | null = null;
  public virtualPageNumber: number | null = null;
  public lastAccessTime: number = 0;

  constructor(frameId: number) {
    this.frameId = frameId;
  }

  isFree(): boolean {
    return !this.busy;
  }

  allocate(pte: PTE, pid: number, virtualPage: number, currentTime: number): void {
    this.busy = true;
    this.mappedPTE = pte;
    this.ownerPid = pid;
    this.virtualPageNumber = virtualPage;
    this.lastAccessTime = currentTime;
  }

  release(): void {
    this.busy = false;
    this.mappedPTE = null;
    this.ownerPid = null;
    this.virtualPageNumber = null;
    this.lastAccessTime = 0;
  }
}
