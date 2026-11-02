import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Disk } from '../src/disk';
import { Kernel } from '../src/kernel';
import { BLOCK_SIZE, FsError, MAX_FILE_SIZE } from '../src/types';
import type { FsErrorCode } from '../src/types';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Env {
  kernel: Kernel;
  disk: Disk;
  imgPath: string;
}

function setup(inodes = 16, diskSize?: number): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab4-'));
  const imgPath = path.join(dir, 'disk.img');
  const disk = Disk.create(imgPath, diskSize);
  const kernel = new Kernel(disk);
  kernel.mkfs(inodes);
  cleanups.push(() => {
    disk.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { kernel, disk, imgPath };
}

const text = (s: string): Buffer => Buffer.from(s, 'ascii');
const pattern = (length: number, seed = 1): Buffer =>
  Buffer.from(Array.from({ length }, (_, i) => ((i + seed) % 250) + 1));
const throwsCode = (fn: () => unknown, code: FsErrorCode): void =>
  assert.throws(fn, (e: unknown) => e instanceof FsError && e.code === code);

describe('Файлова система', () => {
  it('1. mkfs і створення порожнього файлу', () => {
    const { kernel } = setup();
    kernel.create('file.txt');
    const st = kernel.stat('file.txt');
    assert.deepEqual([st.type, st.nlink, st.size, st.nblock], ['reg', 1, 0, 0]);
    const { totalBlocks, dataStart } = kernel.fs.sb;
    assert.equal(kernel.fs.countFreeBlocks(), totalBlocks - dataStart - 1);
  });

  it('2. stat та ls показують правильні inode', () => {
    const { kernel } = setup();
    kernel.create('file.txt');
    kernel.create('some.dat');
    const listing = kernel.ls();
    assert.deepEqual(listing, [
      { name: 'file.txt', inode: 1, type: 'reg' },
      { name: 'some.dat', inode: 2, type: 'reg' },
    ]);
    assert.equal(kernel.stat('some.dat').id, 2);
  });

  it('3. запис і читання довільних байтів (включно з нулями)', () => {
    const { kernel } = setup();
    kernel.create('a');
    const fd = kernel.open('a');
    const data = Buffer.from([0, 1, 2, 0, 255, 0, 128, 0, 0, 7]);
    assert.equal(kernel.write(fd, data), 10);
    kernel.seek(fd, 0);
    assert.deepEqual(kernel.read(fd, 10), data);
    assert.equal(kernel.stat('a').size, 10);
  });

  it('4. читання і запис через межі блоків', () => {
    const { kernel } = setup();
    kernel.create('a');
    const fd = kernel.open('a');
    const data = pattern(BLOCK_SIZE * 2 + 50);
    kernel.seek(fd, 100);
    kernel.write(fd, data);
    kernel.seek(fd, 100);
    assert.deepEqual(kernel.read(fd, data.length), data);
    kernel.seek(fd, BLOCK_SIZE - 2);
    assert.deepEqual(kernel.read(fd, 4), Buffer.concat([Buffer.alloc(0), data.subarray(BLOCK_SIZE - 2 - 100, BLOCK_SIZE + 2 - 100)]));
  });

  it('5. незалежні offset для двох відкриттів одного inode', () => {
    const { kernel } = setup();
    kernel.create('a');
    const fd0 = kernel.open('a');
    const fd1 = kernel.open('a');
    kernel.write(fd0, text('0123456789'));
    kernel.seek(fd1, 3);
    assert.equal(kernel.read(fd1, 2).toString(), '34');
    kernel.write(fd0, text('AB'));
    kernel.seek(fd1, 10);
    assert.equal(kernel.read(fd1, 2).toString(), 'AB');
    kernel.seek(fd0, 0);
    assert.equal(kernel.read(fd0, 2).toString(), '01');
  });

  it('6. повторне використання найменшого вільного fd', () => {
    const { kernel } = setup();
    kernel.create('a');
    assert.equal(kernel.open('a'), 0);
    assert.equal(kernel.open('a'), 1);
    assert.equal(kernel.open('a'), 2);
    kernel.close(0);
    kernel.close(1);
    assert.equal(kernel.open('a'), 0);
    assert.equal(kernel.open('a'), 1);
    assert.equal(kernel.open('a'), 3);
  });

  it('7. hard link не створює новий inode і не копіює дані', () => {
    const { kernel } = setup();
    kernel.create('file.txt');
    const fd = kernel.open('file.txt');
    kernel.write(fd, text('hello'));
    const freeBefore = kernel.fs.countFreeBlocks();
    kernel.link('file.txt', 'document.txt');
    assert.equal(kernel.stat('document.txt').id, kernel.stat('file.txt').id);
    assert.equal(kernel.fs.countFreeBlocks(), freeBefore);
    const fd2 = kernel.open('document.txt');
    assert.equal(kernel.read(fd2, 5).toString(), 'hello');
    assert.equal(kernel.ls().length, 2);
  });

  it('8. nlink змінюється після link та unlink', () => {
    const { kernel } = setup();
    kernel.create('a');
    kernel.link('a', 'b');
    kernel.link('a', 'c');
    assert.equal(kernel.stat('a').nlink, 3);
    kernel.unlink('b');
    assert.equal(kernel.stat('c').nlink, 2);
    assert.deepEqual(kernel.ls().map((e) => e.name), ['a', 'c']);
  });

  it('9. unlink останнього посилання закритого файлу звільняє inode і блоки', () => {
    const { kernel } = setup();
    kernel.create('keep');
    kernel.create('a');
    const fd = kernel.open('a');
    kernel.write(fd, pattern(600));
    kernel.close(fd);
    const used = kernel.fs.countFreeBlocks();
    kernel.unlink('a');
    assert.equal(kernel.fs.countFreeBlocks(), used + 3);
    throwsCode(() => kernel.stat('a'), 'ENOENT');
    kernel.create('b');
    assert.equal(kernel.stat('b').id, 2);
  });

  it('10. unlink відкритого файлу: read/write ще працюють', () => {
    const { kernel } = setup();
    kernel.create('some.dat');
    const fd = kernel.open('some.dat');
    kernel.write(fd, text('0123456789'));
    kernel.unlink('some.dat');
    assert.deepEqual(kernel.ls(), []);
    throwsCode(() => kernel.open('some.dat'), 'ENOENT');
    kernel.seek(fd, 0);
    assert.equal(kernel.read(fd, 10).toString(), '0123456789');
    kernel.seek(fd, 10);
    kernel.write(fd, text('xyz'));
    kernel.seek(fd, 8);
    assert.equal(kernel.read(fd, 5).toString(), '89xyz');
  });

  it('11. ресурси звільняються після останнього close', () => {
    const { kernel } = setup();
    kernel.create('a');
    const fdA = kernel.open('a');
    const fdB = kernel.open('a');
    kernel.write(fdA, pattern(BLOCK_SIZE * 2));
    const freeWhileOpen = kernel.fs.countFreeBlocks();
    kernel.unlink('a');
    kernel.close(fdA);
    assert.equal(kernel.fs.countFreeBlocks(), freeWhileOpen, 'ще відкрито через fdB');
    kernel.close(fdB);
    assert.equal(kernel.fs.countFreeBlocks(), freeWhileOpen + 2);
    assert.equal(kernel.fs.readInode(1).type, 'free');
  });

  it('12. truncate 0 -> 1024 не виділяє блоків', () => {
    const { kernel } = setup();
    kernel.create('some.dat');
    const free = kernel.fs.countFreeBlocks();
    kernel.truncate('some.dat', 1024);
    const st = kernel.stat('some.dat');
    assert.equal(st.size, 1024);
    assert.equal(st.nblock, 0);
    assert.equal(kernel.fs.countFreeBlocks(), free);
  });

  it('13. sparse-ділянки читаються як нулі', () => {
    const { kernel } = setup();
    kernel.create('a');
    kernel.truncate('a', 1024);
    const fd = kernel.open('a');
    assert.deepEqual(kernel.read(fd, 1024), Buffer.alloc(1024));
    kernel.seek(fd, 1000);
    assert.equal(kernel.read(fd, 100).length, 24);
    assert.equal(kernel.read(fd, 100).length, 0);
  });

  it('14. запис у віддалений блок виділяє лише потрібні блоки', () => {
    const { kernel } = setup();
    kernel.create('a');
    const fd = kernel.open('a');
    kernel.truncate('a', 1024);
    kernel.write(fd, text('0123456789'));
    assert.equal(kernel.stat('a').nblock, 1);
    kernel.seek(fd, 512);
    kernel.write(fd, text('abcdefg'));
    const st = kernel.stat('a');
    assert.deepEqual([st.size, st.nblock], [1024, 2]);
    assert.equal(st.direct[1], 0);
    assert.equal(st.direct[3], 0);
    kernel.seek(fd, 0);
    const all = kernel.read(fd, 1024);
    assert.equal(all.subarray(0, 10).toString(), '0123456789');
    assert.equal(all.subarray(512, 519).toString(), 'abcdefg');
    assert.ok(all.subarray(10, 512).every((b) => b === 0));
    kernel.seek(fd, 768);
    kernel.write(fd, Buffer.alloc(100));
    assert.equal(kernel.stat('a').nblock, 2);
  });

  it('15. запис у сьомий логічний блок використовує single indirect', () => {
    const { kernel } = setup();
    kernel.create('a');
    const fd = kernel.open('a');
    const before = kernel.fs.countFreeBlocks();
    kernel.seek(fd, 6 * BLOCK_SIZE + 5);
    kernel.write(fd, text('indirect'));
    const st = kernel.stat('a');
    assert.equal(st.nblock, 1);
    assert.notEqual(st.indirect, 0);
    assert.deepEqual(st.direct, [0, 0, 0, 0, 0, 0]);
    assert.equal(kernel.fs.countFreeBlocks(), before - 2, 'блок даних + indirect-блок');
    kernel.seek(fd, 6 * BLOCK_SIZE + 5);
    assert.equal(kernel.read(fd, 8).toString(), 'indirect');
    kernel.seek(fd, MAX_FILE_SIZE - 1);
    kernel.write(fd, text('Z'));
    assert.equal(kernel.stat('a').size, MAX_FILE_SIZE);
    assert.equal(kernel.stat('a').nblock, 2);
  });

  it('16. зменшення файлу звільняє блоки та indirect-блок', () => {
    const { kernel } = setup();
    kernel.create('a');
    const fd = kernel.open('a');
    kernel.write(fd, pattern(BLOCK_SIZE * 8));
    const used = kernel.fs.countFreeBlocks();
    assert.equal(kernel.stat('a').nblock, 8);
    kernel.truncate('a', BLOCK_SIZE * 6 + 10);
    assert.equal(kernel.stat('a').nblock, 7);
    assert.equal(kernel.fs.countFreeBlocks(), used + 1);
    kernel.truncate('a', BLOCK_SIZE * 6);
    const st = kernel.stat('a');
    assert.equal(st.nblock, 6);
    assert.equal(st.indirect, 0);
    assert.equal(kernel.fs.countFreeBlocks(), used + 3);
    kernel.truncate('a', 100);
    assert.equal(kernel.stat('a').nblock, 1);
    kernel.truncate('a', 0);
    assert.equal(kernel.stat('a').nblock, 0);
  });

  it('17. повторне збільшення не повертає старі дані', () => {
    const { kernel } = setup();
    kernel.create('a');
    const fd = kernel.open('a');
    kernel.write(fd, pattern(BLOCK_SIZE * 3));
    kernel.truncate('a', 300);
    kernel.truncate('a', BLOCK_SIZE * 3);
    kernel.seek(fd, 0);
    const data = kernel.read(fd, BLOCK_SIZE * 3);
    assert.deepEqual(data.subarray(0, 300), pattern(300));
    assert.ok(data.subarray(300).every((b) => b === 0));
    kernel.truncate('a', 0);
    kernel.truncate('a', 500);
    kernel.seek(fd, 0);
    assert.ok(kernel.read(fd, 500).every((b) => b === 0));
    assert.equal(kernel.stat('a').nblock, 0);
  });

  it('18. звільнений блок не впливає на інший файл', () => {
    const { kernel } = setup();
    kernel.create('a');
    kernel.create('b');
    const fdA = kernel.open('a');
    const fdB = kernel.open('b');
    kernel.write(fdA, pattern(BLOCK_SIZE * 4, 10));
    kernel.write(fdB, pattern(BLOCK_SIZE * 4, 99));
    const oldA = kernel.fs.blocksOf('a');
    kernel.truncate('a', BLOCK_SIZE);
    kernel.seek(fdA, BLOCK_SIZE);
    kernel.write(fdA, pattern(BLOCK_SIZE * 3, 50));
    const blocksA = kernel.fs.blocksOf('a');
    const blocksB = kernel.fs.blocksOf('b');
    assert.equal(blocksA.length, 4);
    assert.equal(blocksA.filter((x) => blocksB.includes(x)).length, 0, 'блоки не перетинаються');
    assert.deepEqual(blocksA.slice(1).sort(), oldA.slice(1).sort(), 'звільнені блоки перевикористані');
    kernel.seek(fdB, 0);
    assert.deepEqual(kernel.read(fdB, BLOCK_SIZE * 4), pattern(BLOCK_SIZE * 4, 99));
  });

  it('19. після перезапуску диск відкривається без mkfs', () => {
    const { kernel, disk, imgPath } = setup();
    kernel.create('file.txt');
    kernel.link('file.txt', 'alias.txt');
    const fd = kernel.open('file.txt');
    kernel.seek(fd, 700);
    kernel.write(fd, text('persisted'));
    const open2 = kernel.open('file.txt');
    assert.equal(open2, 1);
    disk.close();

    const disk2 = Disk.open(imgPath);
    cleanups.push(() => disk2.close());
    const kernel2 = new Kernel(disk2);
    kernel2.mount();
    assert.deepEqual(kernel2.ls().map((e) => e.name), ['file.txt', 'alias.txt']);
    const st = kernel2.stat('alias.txt');
    assert.deepEqual([st.nlink, st.size, st.nblock], [2, 709, 1]);
    assert.equal(kernel2.open('alias.txt'), 0, 'таблиця fd не зберігається');
    kernel2.seek(0, 700);
    assert.equal(kernel2.read(0, 9).toString(), 'persisted');
  });

  it('19b. повторний mkfs очищає попередню ФС', () => {
    const { kernel } = setup();
    kernel.create('a');
    const fd = kernel.open('a');
    kernel.write(fd, pattern(500));
    kernel.mkfs(8);
    assert.deepEqual(kernel.ls(), []);
    throwsCode(() => kernel.read(fd, 1), 'EBADF');
    kernel.create('b');
    assert.equal(kernel.stat('b').size, 0);
  });

  it('20a. некоректні імена та аргументи', () => {
    const { kernel } = setup();
    for (const bad of ['', 'a/b', 'with space', 'x'.repeat(25), 'ключ']) {
      throwsCode(() => kernel.create(bad), 'EINVAL');
    }
    kernel.create('x'.repeat(24));
    kernel.create('a');
    throwsCode(() => kernel.create('a'), 'EEXIST');
    throwsCode(() => kernel.stat('nope'), 'ENOENT');
    throwsCode(() => kernel.open('nope'), 'ENOENT');
    throwsCode(() => kernel.link('nope', 'z'), 'ENOENT');
    throwsCode(() => kernel.link('a', 'a'), 'EEXIST');
    throwsCode(() => kernel.link('a', 'bad/name'), 'EINVAL');
    throwsCode(() => kernel.unlink('nope'), 'ENOENT');
    throwsCode(() => kernel.truncate('nope', 1), 'ENOENT');
    throwsCode(() => kernel.truncate('a', -1), 'EINVAL');
    throwsCode(() => kernel.truncate('a', MAX_FILE_SIZE + 1), 'EFBIG');
    throwsCode(() => kernel.read(5, 1), 'EBADF');
    throwsCode(() => kernel.close(0), 'EBADF');
    const fd = kernel.open('a');
    throwsCode(() => kernel.seek(fd, -1), 'EINVAL');
    throwsCode(() => kernel.seek(fd, 1.5), 'EINVAL');
    throwsCode(() => kernel.read(fd, -1), 'EINVAL');
    throwsCode(() => kernel.read(-1, 1), 'EBADF');
    throwsCode(() => kernel.mkfs(0), 'EINVAL');
    throwsCode(() => kernel.mkfs(100000), 'EINVAL');
  });

  it('20b. нестача inode, переповнення файлу, відсутність змін при помилці', () => {
    const { kernel } = setup(3);
    kernel.create('a');
    kernel.create('b');
    throwsCode(() => kernel.create('c'), 'ENFILE');
    assert.equal(kernel.ls().length, 2);

    const fd = kernel.open('a');
    kernel.seek(fd, MAX_FILE_SIZE - 1);
    throwsCode(() => kernel.write(fd, text('ab')), 'EFBIG');
    assert.deepEqual([kernel.stat('a').size, kernel.stat('a').nblock], [0, 0]);
  });

  it('20c. нестача блоків: помилка без часткових змін', () => {
    const { kernel } = setup(4, 32 * BLOCK_SIZE);
    kernel.create('a');
    kernel.create('b');
    const fdA = kernel.open('a');
    const fdB = kernel.open('b');
    const freeBefore = kernel.fs.countFreeBlocks();
    assert.equal(freeBefore, 32 - 3 - 1);
    throwsCode(() => kernel.write(fdA, pattern(BLOCK_SIZE * 71)), 'EFBIG');
    throwsCode(() => kernel.write(fdA, pattern(BLOCK_SIZE * 30)), 'ENOSPC');
    assert.equal(kernel.fs.countFreeBlocks(), freeBefore);
    assert.equal(kernel.stat('a').size, 0);
    kernel.write(fdA, pattern(BLOCK_SIZE * (freeBefore - 1)));
    assert.equal(kernel.fs.countFreeBlocks(), 0);
    throwsCode(() => kernel.write(fdB, text('x')), 'ENOSPC');
    assert.equal(kernel.stat('b').size, 0);
    kernel.truncate('a', 0);
    assert.equal(kernel.write(fdB, text('x')), 1);
  });

  it('20d. неформатований та пошкоджений диск', () => {
    const { disk, imgPath } = setup();
    const blank = Disk.create(imgPath + '.blank');
    cleanups.push(() => {
      blank.close();
      fs.rmSync(imgPath + '.blank', { force: true });
    });
    const k = new Kernel(blank);
    throwsCode(() => k.mount(), 'ENOTFORMATTED');
    throwsCode(() => k.create('a'), 'ENOTFORMATTED');

    const sb = disk.readBlock(0);
    sb.writeUInt32LE(7, 8);
    disk.writeBlock(0, sb);
    throwsCode(() => new Kernel(disk).mount(), 'ECORRUPT');

    fs.writeFileSync(imgPath + '.bad', Buffer.alloc(100));
    cleanups.push(() => fs.rmSync(imgPath + '.bad', { force: true }));
    throwsCode(() => Disk.open(imgPath + '.bad'), 'ECORRUPT');
    throwsCode(() => disk.readBlock(disk.blockCount), 'EINVAL');
    throwsCode(() => disk.writeBlock(1, Buffer.alloc(10)), 'EINVAL');
  });

  it('21. вільні inode, записи директорії та блоки не «витікають»', () => {
    const { kernel } = setup(4);
    const free = () => kernel.fs.countFreeBlocks();
    kernel.create('x');
    const baseline = free();
    for (let i = 0; i < 50; i++) {
      kernel.create('t' + i);
      const fd = kernel.open('t' + i);
      kernel.write(fd, pattern(BLOCK_SIZE * 7));
      kernel.close(fd);
      kernel.unlink('t' + i);
    }
    assert.equal(free(), baseline);
    assert.equal(kernel.ls().length, 1);
    assert.equal(kernel.fs.readInode(0).size, 64, 'неактивні записи перевикористовуються');
  });
});
