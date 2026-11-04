import { Disk } from './disk';
import { FileSystem, checkName } from './filesystem';
import { FsError, MAX_OPEN_FILES } from './types';
import type { DirListing, Stat } from './types';

interface OpenFile {
  inode: number;
  offset: number;
}

export class Kernel {
  readonly fs: FileSystem;
  private readonly openFiles: (OpenFile | undefined)[] = [];
  private readonly openCount = new Map<number, number>();

  constructor(disk: Disk) {
    this.fs = new FileSystem(disk);
  }

  mkfs(inodeCount: number): void {
    this.fs.mkfs(inodeCount);
    this.openFiles.length = 0;
    this.openCount.clear();
  }

  mount(): void {
    if (this.openFileCount > 0) {
      throw new FsError('EBUSY', 'не можна монтувати диск за наявності відкритих файлів');
    }
    this.fs.mount();
    this.fs.reclaimOrphans();
  }

  stat(name: string): Stat {
    return this.fs.stat(name);
  }

  ls(): DirListing[] {
    return this.fs.ls();
  }

  create(name: string): void {
    this.fs.create(name);
  }

  link(name1: string, name2: string): void {
    this.fs.link(name1, name2);
  }

  truncate(name: string, size: number): void {
    this.fs.truncate(name, size);
  }

  open(name: string): number {
    checkName(name);
    const inode = this.fs.lookup(name);
    let fd = this.openFiles.findIndex((f) => f === undefined);
    if (fd === -1) {
      if (this.openFiles.length >= MAX_OPEN_FILES) throw new FsError('EMFILE', 'забагато відкритих файлів');
      fd = this.openFiles.length;
    }
    this.openFiles[fd] = { inode, offset: 0 };
    this.openCount.set(inode, (this.openCount.get(inode) ?? 0) + 1);
    return fd;
  }

  close(fd: number): void {
    const file = this.getOpenFile(fd);
    this.openFiles[fd] = undefined;
    while (this.openFiles.length > 0 && this.openFiles[this.openFiles.length - 1] === undefined) {
      this.openFiles.pop();
    }
    const remaining = (this.openCount.get(file.inode) ?? 1) - 1;
    if (remaining > 0) this.openCount.set(file.inode, remaining);
    else this.openCount.delete(file.inode);
    this.releaseIfUnused(file.inode);
  }

  seek(fd: number, offset: number): void {
    const file = this.getOpenFile(fd);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new FsError('EINVAL', `offset має бути невід'ємним цілим числом, отримано ${offset}`);
    }
    file.offset = offset;
  }

  read(fd: number, size: number): Buffer {
    const file = this.getOpenFile(fd);
    const data = this.fs.readData(file.inode, file.offset, size);
    file.offset += size;
    return data;
  }

  write(fd: number, data: Uint8Array): number {
    const file = this.getOpenFile(fd);
    const written = this.fs.writeData(file.inode, file.offset, data);
    file.offset += written;
    return written;
  }

  unlink(name: string): void {
    const inode = this.fs.removeLink(name);
    this.releaseIfUnused(inode.number);
  }

  get openFileCount(): number {
    return this.openFiles.filter((f) => f !== undefined).length;
  }

  private releaseIfUnused(inodeNumber: number): void {
    if (this.openCount.has(inodeNumber)) return;
    const inode = this.fs.readInode(inodeNumber);
    if (inode.type !== 'free' && inode.nlink === 0) this.fs.releaseInode(inodeNumber);
  }

  private getOpenFile(fd: number): OpenFile {
    const file = Number.isInteger(fd) ? this.openFiles[fd] : undefined;
    if (!file) throw new FsError('EBADF', `fd ${fd} не відкрито`);
    return file;
  }
}
