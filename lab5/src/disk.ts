import * as fs from 'node:fs';
import { BLOCK_SIZE, DISK_SIZE, FsError } from './types';

export class Disk {
  private fd: number | null;
  readonly blockCount: number;

  private constructor(fd: number, blockCount: number) {
    this.fd = fd;
    this.blockCount = blockCount;
  }

  static create(path: string, size: number = DISK_SIZE): Disk {
    if (!Number.isInteger(size) || size <= 0 || size % BLOCK_SIZE !== 0) {
      throw new FsError('EINVAL', `розмір диска має бути кратним ${BLOCK_SIZE}`);
    }
    const fd = fs.openSync(path, 'w+');
    fs.ftruncateSync(fd, size);
    return new Disk(fd, size / BLOCK_SIZE);
  }

  static open(path: string): Disk {
    const fd = fs.openSync(path, 'r+');
    const size = fs.fstatSync(fd).size;
    if (size === 0 || size % BLOCK_SIZE !== 0) {
      fs.closeSync(fd);
      throw new FsError('ECORRUPT', 'розмір образу не кратний розміру блоку');
    }
    return new Disk(fd, size / BLOCK_SIZE);
  }

  readBlock(block: number): Buffer {
    const fd = this.checkAccess(block);
    const buf = Buffer.alloc(BLOCK_SIZE);
    const read = fs.readSync(fd, buf, 0, BLOCK_SIZE, block * BLOCK_SIZE);
    if (read !== BLOCK_SIZE) throw new FsError('ECORRUPT', `не вдалося прочитати блок ${block}`);
    return buf;
  }

  writeBlock(block: number, data: Uint8Array): void {
    const fd = this.checkAccess(block);
    if (data.length !== BLOCK_SIZE) {
      throw new FsError('EINVAL', `блок має містити рівно ${BLOCK_SIZE} байтів, отримано ${data.length}`);
    }
    const written = fs.writeSync(fd, data, 0, BLOCK_SIZE, block * BLOCK_SIZE);
    if (written !== BLOCK_SIZE) throw new FsError('ECORRUPT', `не вдалося записати блок ${block}`);
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  private checkAccess(block: number): number {
    if (this.fd === null) throw new FsError('EINVAL', 'диск закрито');
    if (!Number.isInteger(block) || block < 0 || block >= this.blockCount) {
      throw new FsError('EINVAL', `блок ${block} поза межами диска (0..${this.blockCount - 1})`);
    }
    return this.fd;
  }
}
