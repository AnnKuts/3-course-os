export const BLOCK_SIZE = 256;
export const DISK_SIZE = 1024 * 1024;
export const INODE_SIZE = 64;
export const INODES_PER_BLOCK = BLOCK_SIZE / INODE_SIZE;
export const DIRECT_COUNT = 6;
export const POINTERS_PER_BLOCK = BLOCK_SIZE / 4;
export const MAX_FILE_BLOCKS = DIRECT_COUNT + POINTERS_PER_BLOCK;
export const MAX_FILE_SIZE = MAX_FILE_BLOCKS * BLOCK_SIZE;
export const MAX_FILENAME = 24;
export const NAME_REGEX = /^[A-Za-z0-9_.-]{1,24}$/;
export const DIR_ENTRY_SIZE = 32;
export const INACTIVE_INODE = -1;

export const ROOT_INODE = 0;
export const MAX_OPEN_FILES = 64;

export const MAGIC = 0x3442414c;
export const SUPERBLOCK_BLOCK = 0;
export const SUPERBLOCK_FIELDS = 9;

export type FsErrorCode =
  | 'EINVAL'
  | 'ENOENT'
  | 'EEXIST'
  | 'EBADF'
  | 'EMFILE'
  | 'ENFILE'
  | 'ENOSPC'
  | 'EFBIG'
  | 'EISDIR'
  | 'ENOTFORMATTED'
  | 'ECORRUPT';

export class FsError extends Error {
  constructor(readonly code: FsErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FsError';
  }
}

export type InodeType = 'free' | 'regular' | 'directory';
const TYPE_TO_CODE: Record<InodeType, number> = { free: 0, regular: 1, directory: 2 };
const CODE_TO_TYPE: InodeType[] = ['free', 'regular', 'directory'];

export interface Superblock {
  magic: number;
  blockSize: number;
  totalBlocks: number;
  inodeCount: number;
  bitmapStart: number;
  bitmapBlocks: number;
  inodeTableStart: number;
  inodeTableBlocks: number;
  dataStart: number;
}

export interface Layout {
  bitmapStart: number;
  bitmapBlocks: number;
  inodeTableStart: number;
  inodeTableBlocks: number;
  dataStart: number;
}

export function computeLayout(totalBlocks: number, inodeCount: number): Layout {
  const bitmapStart = SUPERBLOCK_BLOCK + 1;
  const bitmapBlocks = Math.ceil(totalBlocks / (BLOCK_SIZE * 8));
  const inodeTableStart = bitmapStart + bitmapBlocks;
  const inodeTableBlocks = Math.ceil(inodeCount / INODES_PER_BLOCK);
  const dataStart = inodeTableStart + inodeTableBlocks;
  return { bitmapStart, bitmapBlocks, inodeTableStart, inodeTableBlocks, dataStart };
}

export function serializeSuperblock(sb: Superblock): Buffer {
  const buf = Buffer.alloc(BLOCK_SIZE);
  const fields = [
    sb.magic, sb.blockSize, sb.totalBlocks, sb.inodeCount, sb.bitmapStart,
    sb.bitmapBlocks, sb.inodeTableStart, sb.inodeTableBlocks, sb.dataStart,
  ];
  fields.forEach((value, i) => buf.writeUInt32LE(value, i * 4));
  return buf;
}

export function parseSuperblock(buf: Buffer): Superblock {
  const f = Array.from({ length: SUPERBLOCK_FIELDS }, (_, i) => buf.readUInt32LE(i * 4));
  return {
    magic: f[0], blockSize: f[1], totalBlocks: f[2], inodeCount: f[3], bitmapStart: f[4],
    bitmapBlocks: f[5], inodeTableStart: f[6], inodeTableBlocks: f[7], dataStart: f[8],
  };
}

export interface Inode {
  number: number;
  type: InodeType;
  nlink: number;
  size: number;
  direct: number[];
  indirect: number;
}

const OFF_NLINK = 4;
const OFF_SIZE = 8;
const OFF_DIRECT = 12;
const OFF_INDIRECT = OFF_DIRECT + DIRECT_COUNT * 4;

export function emptyInode(number: number): Inode {
  return { number, type: 'free', nlink: 0, size: 0, direct: new Array<number>(DIRECT_COUNT).fill(0), indirect: 0 };
}

export function serializeInode(inode: Inode): Buffer {
  const buf = Buffer.alloc(INODE_SIZE);
  buf.writeUInt8(TYPE_TO_CODE[inode.type], 0);
  buf.writeUInt32LE(inode.nlink, OFF_NLINK);
  buf.writeUInt32LE(inode.size, OFF_SIZE);
  inode.direct.forEach((b, i) => buf.writeUInt32LE(b, OFF_DIRECT + i * 4));
  buf.writeUInt32LE(inode.indirect, OFF_INDIRECT);
  return buf;
}

export function parseInode(number: number, buf: Buffer): Inode {
  const type = CODE_TO_TYPE[buf.readUInt8(0)];
  if (type === undefined) throw new FsError('ECORRUPT', `inode ${number} має невідомий тип`);
  const direct = Array.from({ length: DIRECT_COUNT }, (_, i) => buf.readUInt32LE(OFF_DIRECT + i * 4));
  return {
    number, type, nlink: buf.readUInt32LE(OFF_NLINK), size: buf.readUInt32LE(OFF_SIZE),
    direct, indirect: buf.readUInt32LE(OFF_INDIRECT),
  };
}

export function serializeDirEntry(name: string, inode: number): Buffer {
  const buf = Buffer.alloc(DIR_ENTRY_SIZE);
  buf.write(name, 0, MAX_FILENAME, 'ascii');
  buf.writeInt32LE(inode, MAX_FILENAME);
  return buf;
}

export function parseDirEntry(buf: Buffer): { name: string; inode: number } {
  let end = 0;
  while (end < MAX_FILENAME && buf[end] !== 0) end++;
  return { name: buf.toString('ascii', 0, end), inode: buf.readInt32LE(MAX_FILENAME) };
}

export function isZeroBuffer(buf: Uint8Array): boolean {
  return buf.every((b) => b === 0);
}

export interface Stat {
  id: number;
  type: 'reg' | 'dir';
  nlink: number;
  size: number;
  nblock: number;
  direct: number[];
  indirect: number;
}

export interface DirListing {
  name: string;
  inode: number;
  type: 'reg' | 'dir';
}
