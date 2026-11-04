import * as path from 'node:path';
import { Disk } from './disk';
import { Kernel } from './kernel';
import { BLOCK_SIZE, DISK_SIZE, FsError, MAX_FILE_SIZE } from './types';
import type { Stat } from './types';

const IMAGE = path.join(process.cwd(), 'disk.img');

function show(buf: Buffer): string {
  let out = '';
  for (let i = 0; i < buf.length; ) {
    const b = buf[i];
    if (b === 0) {
      let run = 0;
      while (i + run < buf.length && buf[i + run] === 0) run++;
      out += run <= 4 ? '\\0'.repeat(run) : `\\0{x${run}}`;
      i += run;
    } else {
      out += b >= 0x20 && b < 0x7f ? (b === 0x5c ? '\\\\' : String.fromCharCode(b)) : `\\x${b.toString(16).padStart(2, '0')}`;
      i++;
    }
  }
  return out;
}

function formatRead(buf: Buffer, full = false): string {
  if (buf.length <= 32 || full) {
    return show(buf);
  }
  let zeros = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) zeros++;
  }
  const head = show(buf.subarray(0, 10));
  const tail = show(buf.subarray(buf.length - 7));
  return `bytes_read=${buf.length}, zeros=${zeros}, data=${head}...${tail}`;
}

const fmtStat = (s: Stat): string => `id=${s.id}, type=${s.type}, nlink=${s.nlink}, size=${s.size}, nblock=${s.nblock}`;

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function main(): void {
  let disk = Disk.create(IMAGE, DISK_SIZE);
  let k = new Kernel(disk);

  const cmd = (line: string, action: () => string | void): void => {
    console.log(`> ${line}`);
    const res = action();
    if (res !== undefined && res !== '') console.log(res);
    else if (res === undefined) console.log('OK');
  };

  const attempt = (line: string, action: () => unknown): void => {
    console.log(`> ${line}`);
    try {
      action();
      console.log('OK');
    } catch (e) {
      console.log(e instanceof FsError ? `ERROR: ${e.message}` : `ERROR: ${String(e)}`);
    }
  };

  const stat = (name: string) => cmd(`stat ${name}`, () => fmtStat(k.stat(name)));
  const ls = () => cmd('ls', () => k.ls().map((e) => `${e.name.padEnd(14)} => ${e.type}, ${e.inode}`).join('\n'));
  const write = (fd: number, text: string) => {
    const data = Buffer.from(text, 'ascii');
    console.log(`> write ${fd} ${data.length}\n${text}`);
    const written = k.write(fd, data);
    console.log(`written=${written}`);
  };
  const read = (fd: number, size: number, full = false) =>
    cmd(`read ${fd} ${size}`, () => formatRead(k.read(fd, size), full));

  console.log('OS Lab 4 | Block File System');
  console.log('Block size: 256 B | Disk: 1 MiB | Inodes: 100');

  section('FILE OPERATIONS');
  cmd('mkfs 100', () => { k.mkfs(100); });
  cmd('create file.txt', () => { k.create('file.txt'); });
  stat('file.txt');
  ls();
  cmd('open file.txt', () => `fd=${k.open('file.txt')}`);
  cmd('open file.txt', () => `fd=${k.open('file.txt')}`);
  cmd('close 0', () => { k.close(0); });
  cmd('open file.txt', () => `fd=${k.open('file.txt')}`);
  cmd('close 0', () => { k.close(0); });
  cmd('close 1', () => { k.close(1); });

  section('HARD LINKS');
  cmd('link file.txt document.txt', () => { k.link('file.txt', 'document.txt'); });
  stat('document.txt');
  ls();

  section('SPARSE FILES');
  cmd('create some.dat', () => { k.create('some.dat'); });
  cmd('truncate some.dat 1024', () => { k.truncate('some.dat', 1024); });
  stat('some.dat');
  cmd('open some.dat', () => `fd=${k.open('some.dat')}`);
  write(0, '0123456789');
  stat('some.dat');
  cmd('seek 0 7', () => { k.seek(0, 7); });
  read(0, 2);
  cmd('seek 0 512', () => { k.seek(0, 512); });
  write(0, 'abcdefg');
  stat('some.dat');
  cmd('seek 0 0', () => { k.seek(0, 0); });
  read(0, 10);
  cmd('seek 0 0', () => { k.seek(0, 0); });
  read(0, 519);
  cmd('unlink some.dat', () => { k.unlink('some.dat'); });
  ls();
  console.log(`free_blocks=${k.fs.countFreeBlocks()}`);
  cmd('seek 0 0', () => { k.seek(0, 0); });
  read(0, 10);
  cmd('close 0', () => { k.close(0); });
  console.log(`free_blocks=${k.fs.countFreeBlocks()}`);

  section('INDIRECT BLOCKS');
  cmd('create big.dat', () => { k.create('big.dat'); });
  cmd('open big.dat', () => `fd=${k.open('big.dat')}`);
  console.log(`free_blocks=${k.fs.countFreeBlocks()}`);
  cmd(`seek 0 ${6 * BLOCK_SIZE}`, () => { k.seek(0, 6 * BLOCK_SIZE); });
  write(0, 'seventh-block');
  cmd('stat big.dat', () => {
    const s7 = k.stat('big.dat');
    return `${fmtStat(s7)}\ndirect=[${s7.direct.join(', ')}], indirect=${s7.indirect}`;
  });
  console.log(`free_blocks=${k.fs.countFreeBlocks()}`);
  cmd(`seek 0 ${6 * BLOCK_SIZE}`, () => { k.seek(0, 6 * BLOCK_SIZE); });
  read(0, 13);
  cmd('truncate big.dat 100', () => { k.truncate('big.dat', 100); });
  cmd('stat big.dat', () => {
    const s8 = k.stat('big.dat');
    return `${fmtStat(s8)}\ndirect=[${s8.direct.join(', ')}], indirect=${s8.indirect}`;
  });
  console.log(`free_blocks=${k.fs.countFreeBlocks()}`);
  cmd('close 0', () => { k.close(0); });

  section('ERROR HANDLING');
  attempt('create bad/name', () => k.create('bad/name'));
  attempt('create file.txt', () => k.create('file.txt'));
  attempt('stat nope', () => k.stat('nope'));
  attempt('read 7 1', () => k.read(7, 1));
  const efd = k.open('file.txt');
  attempt(`seek ${efd} -1`, () => k.seek(efd, -1));
  k.close(efd);
  attempt(`truncate file.txt ${MAX_FILE_SIZE + 1}`, () => k.truncate('file.txt', MAX_FILE_SIZE + 1));
  attempt('mkfs 0', () => k.mkfs(0));

  section('PERSISTENCE');
  cmd('create persist.txt', () => { k.create('persist.txt'); });
  cmd('open persist.txt', () => `fd=${k.open('persist.txt')}`);
  write(0, 'survives restart');
  cmd('close 0', () => { k.close(0); });
  disk.close();
  disk = Disk.open(IMAGE);
  k = new Kernel(disk);
  cmd('mount', () => { k.mount(); });
  ls();
  cmd('open persist.txt', () => `fd=${k.open('persist.txt')}`);
  read(0, 16);
  cmd('close 0', () => { k.close(0); });
  disk.close();
}

main();
