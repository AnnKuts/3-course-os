import { PhysicalPage } from './memory';
import { SeededRNG } from './rng';

// ---------------------------------------------------------------------------
// Інтерфейс алгоритму заміни сторінок
// ---------------------------------------------------------------------------
export interface ReplacementStrategy {
  readonly name: string;
  selectVictim(frames: PhysicalPage[], currentTime: number, verbose: boolean): PhysicalPage;
  onFrameFreed?(frameId: number): void;
}

// ---------------------------------------------------------------------------
// Алгоритм Random — випадковий вибір жертви
// ---------------------------------------------------------------------------
export class RandomReplacement implements ReplacementStrategy {
  public readonly name = 'Random';
  private readonly rng: SeededRNG;

  constructor(rng: SeededRNG) {
    this.rng = rng;
  }

  selectVictim(frames: PhysicalPage[], _currentTime: number, verbose: boolean): PhysicalPage {
    const busy = frames.filter((f) => f.busy);
    if (busy.length === 0) throw new Error('Random: no busy frames to evict');
    const victim = busy[this.rng.nextInt(busy.length)];
    if (verbose) {
      console.log(
        `  [DEBUG] Random: evict frame ${victim.frameId} (PID=${victim.ownerPid}, VP=${victim.virtualPageNumber})`
      );
    }
    return victim;
  }
}

// ---------------------------------------------------------------------------
// Алгоритм WSClock (Working Set Clock)
//
// Кільцевий обхід фреймів. Для кожного:
//  - R=1 → скидаємо R=0, оновлюємо lastAccessTime, рухаємось далі
//  - R=0, age <= TAU → сторінка в робочому наборі, пропускаємо (але запам'ятовуємо)
//  - R=0, age > TAU, M=0 (чиста) → негайно виселяємо
//  - R=0, age > TAU, M=1 (брудна) → запам'ятовуємо як кандидата
// Після повного оберту:
//  1. Вибираємо найстарішого брудного кандидата (ініціюємо запис на диск)
//  2. Якщо немає → будь-який фрейм з R=0 (всі в WS, але без вибору)
//  3. Крайній випадок → перший зайнятий фрейм
// ---------------------------------------------------------------------------
export class WSClockReplacement implements ReplacementStrategy {
  public readonly name = 'WSClock';
  public readonly tau: number;
  private clockHand: number = 0;

  constructor(tau: number) {
    this.tau = tau;
  }

  getClockHand(): number { return this.clockHand; }
  setClockHand(hand: number): void { this.clockHand = hand; }

  selectVictim(frames: PhysicalPage[], currentTime: number, verbose: boolean): PhysicalPage {
    const n = frames.length;
    if (n === 0) throw new Error('WSClock: no frames');

    let oldestDirty: PhysicalPage | null = null;
    let oldestDirtyAge = -1;
    let firstUnreferenced: PhysicalPage | null = null;
    let scanned = 0;
    const start = this.clockHand % n;

    while (scanned < n) {
      const idx = (start + scanned) % n;
      const frame = frames[idx];
      scanned++;

      if (!frame.busy) continue;

      const pte = frame.mappedPTE!;

      if (pte.R) {
        // Сторінка нещодавно використана — скидаємо біт R, оновлюємо час
        pte.R = false;
        frame.lastAccessTime = currentTime;
        if (verbose) {
          console.log(
            `  [DEBUG] WSClock: frame ${frame.frameId} R=1→0, lastAccess=${currentTime}`
          );
        }
        continue;
      }

      // R=0: перевіряємо вік
      if (firstUnreferenced === null) firstUnreferenced = frame;

      const age = currentTime - frame.lastAccessTime;
      if (age > this.tau) {
        if (!pte.M) {
          // Чиста сторінка поза робочим набором — ідеальна жертва
          if (verbose) {
            console.log(
              `  [DEBUG] WSClock: evict frame ${frame.frameId} (clean, age=${age} > TAU=${this.tau})`
            );
          }
          this.clockHand = (idx + 1) % n;
          return frame;
        } else {
          // Брудна — запланувати запис, продовжити пошук чистої
          if (oldestDirty === null || age > oldestDirtyAge) {
            oldestDirty = frame;
            oldestDirtyAge = age;
          }
          if (verbose) {
            console.log(
              `  [DEBUG] WSClock: frame ${frame.frameId} dirty candidate (age=${age})`
            );
          }
        }
      }
      // age <= TAU → сторінка в робочому наборі, пропускаємо
    }

    // Повний оберт без чистої жертви
    if (oldestDirty !== null) {
      if (verbose) {
        console.log(
          `  [DEBUG] WSClock fallback: evict dirty frame ${oldestDirty.frameId} (age=${oldestDirtyAge})`
        );
      }
      const idx = frames.indexOf(oldestDirty);
      this.clockHand = (idx + 1) % n;
      return oldestDirty;
    }

    if (firstUnreferenced !== null) {
      if (verbose) {
        console.log(
          `  [DEBUG] WSClock fallback: evict first unreferenced frame ${firstUnreferenced.frameId}`
        );
      }
      const idx = frames.indexOf(firstUnreferenced);
      this.clockHand = (idx + 1) % n;
      return firstUnreferenced;
    }

    // Крайній випадок — всі фрейми мали R=1 і були скинуті
    const fallback = frames.find((f) => f.busy)!;
    this.clockHand = (frames.indexOf(fallback) + 1) % n;
    return fallback;
  }
}
