import { Disk } from './disk';
import {
  BLOCK_SIZE, DIR_ENTRY_SIZE, DIRECT_COUNT, FsError, INACTIVE_INODE, INODES_PER_BLOCK, INODE_SIZE,
  MAGIC, MAX_FILE_BLOCKS, MAX_FILE_SIZE, NAME_REGEX, POINTERS_PER_BLOCK, ROOT_INODE,
  SUPERBLOCK_BLOCK, computeLayout, emptyInode, isZeroBuffer, parseDirEntry, parseInode,
  parseSuperblock, serializeDirEntry, serializeInode, serializeSuperblock,
} from './types';
import type { DirListing, Inode, Stat, Superblock } from './types';

const BITS_PER_BITMAP_BLOCK = BLOCK_SIZE * 8;

export class FileSystem {
  private superblock: Superblock | null = null;

  constructor(private readonly disk: Disk) {}

  mkfs(inodeCount: number): void {
    if (!Number.isInteger(inodeCount) || inodeCount < 1) {
      throw new FsError('EINVAL', 'кількість inode має бути цілим числом >= 1 (root входить у це число)');
    }
    const total = this.disk.blockCount;
    const layout = computeLayout(total, inodeCount);
    if (layout.dataStart >= total) {
      throw new FsError('EINVAL', `${inodeCount} inode не вміщуються на диск: службові структури займають усі блоки`);
    }

    const zero = Buffer.alloc(BLOCK_SIZE);
    for (let b = 0; b < total; b++) this.disk.writeBlock(b, zero);

    const sb: Superblock = { magic: MAGIC, blockSize: BLOCK_SIZE, totalBlocks: total, inodeCount, ...layout };
    this.disk.writeBlock(SUPERBLOCK_BLOCK, serializeSuperblock(sb));

    const bitmap = Buffer.alloc(layout.bitmapBlocks * BLOCK_SIZE);
    for (let b = 0; b < layout.dataStart; b++) bitmap[b >> 3] |= 1 << (b & 7);
    for (let i = 0; i < layout.bitmapBlocks; i++) {
      this.disk.writeBlock(layout.bitmapStart + i, bitmap.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE));
    }

    this.superblock = sb;
    this.writeInode({ ...emptyInode(ROOT_INODE), type: 'directory', nlink: 1 });
  }

  mount(): void {
    const sb = parseSuperblock(this.disk.readBlock(SUPERBLOCK_BLOCK));
    if (sb.magic !== MAGIC) throw new FsError('ENOTFORMATTED', 'диск не відформатовано (невірний magic)');
    const layout = sb.inodeCount >= 1 ? computeLayout(sb.totalBlocks, sb.inodeCount) : null;
    if (
      sb.blockSize !== BLOCK_SIZE || sb.totalBlocks !== this.disk.blockCount || layout === null ||
      sb.bitmapStart !== layout.bitmapStart || sb.bitmapBlocks !== layout.bitmapBlocks ||
      sb.inodeTableStart !== layout.inodeTableStart || sb.inodeTableBlocks !== layout.inodeTableBlocks ||
      sb.dataStart !== layout.dataStart || sb.dataStart >= sb.totalBlocks
    ) {
      throw new FsError('ECORRUPT', 'superblock пошкоджено або не відповідає розміру диска');
    }
    this.superblock = sb;
    const root = this.readInode(ROOT_INODE);
    if (root.type !== 'directory') throw new FsError('ECORRUPT', 'root inode не є директорією');
  }

  get sb(): Superblock {
    if (this.superblock === null) throw new FsError('ENOTFORMATTED', 'диск не відформатовано або не змонтовано');
    return this.superblock;
  }

  isBlockUsed(block: number): boolean {
    const { buf, byte, mask } = this.bitmapLocation(block);
    return (buf[byte] & mask) !== 0;
  }

  countFreeBlocks(): number {
    let free = 0;
    for (let b = this.sb.dataStart; b < this.sb.totalBlocks; b++) if (!this.isBlockUsed(b)) free++;
    return free;
  }

  private allocBlock(): number {
    const { dataStart, totalBlocks, bitmapStart, bitmapBlocks } = this.sb;
    for (let i = 0; i < bitmapBlocks; i++) {
      const buf = this.disk.readBlock(bitmapStart + i);
      for (let bit = 0; bit < BITS_PER_BITMAP_BLOCK; bit++) {
        const block = i * BITS_PER_BITMAP_BLOCK + bit;
        if (block < dataStart) continue;
        if (block >= totalBlocks) break;
        if ((buf[bit >> 3] & (1 << (bit & 7))) === 0) {
          buf[bit >> 3] |= 1 << (bit & 7);
          this.disk.writeBlock(bitmapStart + i, buf);
          this.disk.writeBlock(block, Buffer.alloc(BLOCK_SIZE));
          return block;
        }
      }
    }
    throw new FsError('ENOSPC', 'немає вільних блоків');
  }

  private freeBlock(block: number): void {
    if (block < this.sb.dataStart || block >= this.sb.totalBlocks || !this.isBlockUsed(block)) {
      throw new FsError('ECORRUPT', `спроба звільнити некоректний блок ${block}`);
    }
    const { buf, byte, mask, bitmapBlock } = this.bitmapLocation(block);
    buf[byte] &= ~mask;
    this.disk.writeBlock(bitmapBlock, buf);
  }

  private bitmapLocation(block: number): { buf: Buffer; byte: number; mask: number; bitmapBlock: number } {
    if (!Number.isInteger(block) || block < 0 || block >= this.sb.totalBlocks) {
      throw new FsError('EINVAL', `блок ${block} поза межами диска`);
    }
    const bitmapBlock = this.sb.bitmapStart + Math.floor(block / BITS_PER_BITMAP_BLOCK);
    const bit = block % BITS_PER_BITMAP_BLOCK;
    return { buf: this.disk.readBlock(bitmapBlock), byte: bit >> 3, mask: 1 << (bit & 7), bitmapBlock };
  }

  readInode(number: number): Inode {
    const { block, offset } = this.inodePosition(number);
    return parseInode(number, this.disk.readBlock(block).subarray(offset, offset + INODE_SIZE));
  }

  writeInode(inode: Inode): void {
    const { block, offset } = this.inodePosition(inode.number);
    const buf = this.disk.readBlock(block);
    serializeInode(inode).copy(buf, offset);
    this.disk.writeBlock(block, buf);
  }

  private inodePosition(number: number): { block: number; offset: number } {
    if (!Number.isInteger(number) || number < 0 || number >= this.sb.inodeCount) {
      throw new FsError('EINVAL', `inode ${number} не існує`);
    }
    return {
      block: this.sb.inodeTableStart + Math.floor(number / INODES_PER_BLOCK),
      offset: (number % INODES_PER_BLOCK) * INODE_SIZE,
    };
  }

  private findFreeInode(): number {
    for (let n = 1; n < this.sb.inodeCount; n++) {
      if (this.readInode(n).type === 'free') return n;
    }
    throw new FsError('ENFILE', 'немає вільних inode');
  }

  private getBlock(inode: Inode, lbn: number): number {
    if (lbn < 0 || lbn >= MAX_FILE_BLOCKS) throw new FsError('EFBIG', `логічний блок ${lbn} поза межами файлу`);
    let phys: number;
    if (lbn < DIRECT_COUNT) {
      phys = inode.direct[lbn];
    } else if (inode.indirect === 0) {
      phys = 0;
    } else {
      phys = this.disk.readBlock(inode.indirect).readUInt32LE((lbn - DIRECT_COUNT) * 4);
    }
    if (phys !== 0 && (phys < this.sb.dataStart || phys >= this.sb.totalBlocks)) {
      throw new FsError('ECORRUPT', `inode ${inode.number} посилається на недопустимий блок ${phys}`);
    }
    return phys;
  }

  private setBlock(inode: Inode, lbn: number, phys: number): void {
    if (lbn < DIRECT_COUNT) {
      inode.direct[lbn] = phys;
      return;
    }
    if (inode.indirect === 0) {
      if (phys === 0) return;
      inode.indirect = this.allocBlock();
    }
    const table = this.disk.readBlock(inode.indirect);
    table.writeUInt32LE(phys, (lbn - DIRECT_COUNT) * 4);
    if (isZeroBuffer(table)) {
      this.freeBlock(inode.indirect);
      inode.indirect = 0;
    } else {
      this.disk.writeBlock(inode.indirect, table);
    }
  }

  private dataBlocks(inode: Inode): number[] {
    const result: number[] = [];
    for (let lbn = 0; lbn < MAX_FILE_BLOCKS; lbn++) {
      const phys = this.getBlock(inode, lbn);
      if (phys !== 0) result.push(phys);
    }
    return result;
  }

  readData(inodeNumber: number, offset: number, length: number): Buffer {
    checkNonNegative(offset, 'offset');
    checkNonNegative(length, 'size');
    const inode = this.readInode(inodeNumber);
    this.requireUsed(inode);
    const count = Math.max(0, Math.min(length, inode.size - offset));
    const result = Buffer.alloc(count);
    let done = 0;
    while (done < count) {
      const pos = offset + done;
      const lbn = Math.floor(pos / BLOCK_SIZE);
      const inBlock = pos % BLOCK_SIZE;
      const chunk = Math.min(BLOCK_SIZE - inBlock, count - done);
      const phys = this.getBlock(inode, lbn);
      if (phys !== 0) this.disk.readBlock(phys).copy(result, done, inBlock, inBlock + chunk);
      done += chunk;
    }
    return result;
  }

  writeData(inodeNumber: number, offset: number, data: Uint8Array): number {
    checkNonNegative(offset, 'offset');
    const inode = this.readInode(inodeNumber);
    this.requireUsed(inode);
    if (data.length === 0) return 0;
    const end = offset + data.length;
    if (end > MAX_FILE_SIZE) throw new FsError('EFBIG', `максимальний розмір файлу — ${MAX_FILE_SIZE} байтів`);

    const plans: { lbn: number; phys: number; content: Buffer }[] = [];
    let needed = 0;
    let needsIndirect = false;
    for (let lbn = Math.floor(offset / BLOCK_SIZE); lbn <= Math.floor((end - 1) / BLOCK_SIZE); lbn++) {
      const phys = this.getBlock(inode, lbn);
      const content = phys !== 0 ? this.disk.readBlock(phys) : Buffer.alloc(BLOCK_SIZE);
      const blockStart = lbn * BLOCK_SIZE;
      const from = Math.max(offset, blockStart);
      const to = Math.min(end, blockStart + BLOCK_SIZE);
      content.set(data.subarray(from - offset, to - offset), from - blockStart);
      plans.push({ lbn, phys, content });
      if (phys === 0 && !isZeroBuffer(content)) {
        needed++;
        if (lbn >= DIRECT_COUNT) needsIndirect = true;
      }
    }
    if (needsIndirect && inode.indirect === 0) needed++;
    if (needed > this.countFreeBlocks()) throw new FsError('ENOSPC', `потрібно ${needed} блоків, вільних менше`);

    for (const plan of plans) {
      let { phys } = plan;
      if (isZeroBuffer(plan.content)) {
        if (phys !== 0) {
          this.setBlock(inode, plan.lbn, 0);
          this.freeBlock(phys);
        }
        continue;
      }
      if (phys === 0) {
        phys = this.allocBlock();
        this.setBlock(inode, plan.lbn, phys);
      }
      this.disk.writeBlock(phys, plan.content);
    }
    inode.size = Math.max(inode.size, end);
    this.writeInode(inode);
    return data.length;
  }

  private truncateInode(inode: Inode, newSize: number): void {
    if (newSize > MAX_FILE_SIZE) throw new FsError('EFBIG', `максимальний розмір файлу — ${MAX_FILE_SIZE} байтів`);
    if (newSize < inode.size) {
      for (let lbn = Math.ceil(newSize / BLOCK_SIZE); lbn < MAX_FILE_BLOCKS; lbn++) {
        const phys = this.getBlock(inode, lbn);
        if (phys !== 0) {
          this.setBlock(inode, lbn, 0);
          this.freeBlock(phys);
        }
      }
      const tail = newSize % BLOCK_SIZE;
      if (tail !== 0) {
        const lbn = Math.floor(newSize / BLOCK_SIZE);
        const phys = this.getBlock(inode, lbn);
        if (phys !== 0) {
          const content = this.disk.readBlock(phys);
          content.fill(0, tail);
          if (isZeroBuffer(content)) {
            this.setBlock(inode, lbn, 0);
            this.freeBlock(phys);
          } else {
            this.disk.writeBlock(phys, content);
          }
        }
      }
    }
    inode.size = newSize;
    this.writeInode(inode);
  }

  releaseInode(inodeNumber: number): void {
    if (inodeNumber === ROOT_INODE) throw new FsError('EINVAL', 'root не можна звільнити');
    const inode = this.readInode(inodeNumber);
    this.requireUsed(inode);
    this.truncateInode(inode, 0);
    this.writeInode(emptyInode(inodeNumber));
  }

  reclaimOrphans(): number {
    let count = 0;
    for (let n = 1; n < this.sb.inodeCount; n++) {
      const inode = this.readInode(n);
      if (inode.type !== 'free' && inode.nlink === 0) {
        this.releaseInode(n);
        count++;
      }
    }
    return count;
  }

  private requireUsed(inode: Inode): void {
    if (inode.type === 'free') throw new FsError('ENOENT', `inode ${inode.number} вільний`);
  }

  private readEntries(): { name: string; inode: number; slot: number }[] {
    const root = this.readInode(ROOT_INODE);
    const data = this.readData(ROOT_INODE, 0, root.size);
    const entries: { name: string; inode: number; slot: number }[] = [];
    for (let off = 0; off + DIR_ENTRY_SIZE <= data.length; off += DIR_ENTRY_SIZE) {
      const entry = parseDirEntry(data.subarray(off, off + DIR_ENTRY_SIZE));
      if (entry.inode !== INACTIVE_INODE) entries.push({ ...entry, slot: off / DIR_ENTRY_SIZE });
    }
    return entries;
  }

  private addEntry(name: string, inode: number): void {
    const root = this.readInode(ROOT_INODE);
    const used = new Set(this.readEntries().map((e) => e.slot));
    const slots = root.size / DIR_ENTRY_SIZE;
    let slot = slots;
    for (let s = 0; s < slots; s++) {
      if (!used.has(s)) {
        slot = s;
        break;
      }
    }
    try {
      this.writeData(ROOT_INODE, slot * DIR_ENTRY_SIZE, serializeDirEntry(name, inode));
    } catch (e) {
      if (e instanceof FsError && (e.code === 'EFBIG' || e.code === 'ENOSPC')) {
        throw new FsError('ENOSPC', 'директорія заповнена або немає місця для її розширення');
      }
      throw e;
    }
  }

  private removeEntry(slot: number): void {
    this.writeData(ROOT_INODE, slot * DIR_ENTRY_SIZE, serializeDirEntry('', INACTIVE_INODE));
  }

  private findEntry(name: string): { name: string; inode: number; slot: number } | undefined {
    checkName(name);
    return this.readEntries().find((e) => e.name === name);
  }

  lookup(name: string): number {
    const entry = this.findEntry(name);
    if (!entry) throw new FsError('ENOENT', `файл '${name}' не знайдено`);
    return entry.inode;
  }

  create(name: string): number {
    checkName(name);
    if (this.findEntry(name)) throw new FsError('EEXIST', `ім'я '${name}' вже існує`);
    const number = this.findFreeInode();
    this.addEntry(name, number);
    this.writeInode({ ...emptyInode(number), type: 'regular', nlink: 1 });
    return number;
  }

  link(existing: string, newName: string): void {
    checkName(newName);
    const target = this.readInode(this.lookup(existing));
    if (target.type !== 'regular') throw new FsError('EISDIR', 'hard link дозволено лише на звичайний файл');
    if (this.findEntry(newName)) throw new FsError('EEXIST', `ім'я '${newName}' вже існує`);
    this.addEntry(newName, target.number);
    target.nlink++;
    this.writeInode(target);
  }

  removeLink(name: string): Inode {
    const entry = this.findEntry(name);
    if (!entry) throw new FsError('ENOENT', `файл '${name}' не знайдено`);
    const inode = this.readInode(entry.inode);
    this.removeEntry(entry.slot);
    inode.nlink--;
    this.writeInode(inode);
    return inode;
  }

  truncate(name: string, size: number): void {
    checkNonNegative(size, 'size');
    const inode = this.readInode(this.lookup(name));
    this.truncateInode(inode, size);
  }

  stat(name: string): Stat {
    return this.statInode(this.lookup(name));
  }

  statInode(inodeNumber: number): Stat {
    const inode = this.readInode(inodeNumber);
    this.requireUsed(inode);
    return {
      id: inode.number,
      type: inode.type === 'directory' ? 'dir' : 'reg',
      nlink: inode.nlink,
      size: inode.size,
      nblock: this.dataBlocks(inode).length,
      direct: [...inode.direct],
      indirect: inode.indirect,
    };
  }

  blocksOf(name: string): number[] {
    return this.dataBlocks(this.readInode(this.lookup(name)));
  }

  ls(): DirListing[] {
    return this.readEntries().map((e) => ({
      name: e.name,
      inode: e.inode,
      type: this.readInode(e.inode).type === 'directory' ? 'dir' : 'reg',
    }));
  }
}

export function checkName(name: string): void {
  if (typeof name !== 'string' || !NAME_REGEX.test(name)) {
    throw new FsError('EINVAL', `некоректне ім'я '${String(name)}': 1..24 символи з [A-Za-z0-9_.-]`);
  }
}

function checkNonNegative(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FsError('EINVAL', `${what} має бути невід'ємним цілим числом, отримано ${value}`);
  }
}
