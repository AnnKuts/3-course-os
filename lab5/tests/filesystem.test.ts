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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab5-'));
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
const names = (kernel: Kernel, pathname?: string): string[] => kernel.ls(pathname).map((e) => e.name);

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
      { name: '.', inode: 0, type: 'dir' },
      { name: '..', inode: 0, type: 'dir' },
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
    assert.deepEqual(names(kernel), ['.', '..', 'file.txt', 'document.txt']);
  });

  it('8. nlink змінюється після link та unlink', () => {
    const { kernel } = setup();
    kernel.create('a');
    kernel.link('a', 'b');
    kernel.link('a', 'c');
    assert.equal(kernel.stat('a').nlink, 3);
    kernel.unlink('b');
    assert.equal(kernel.stat('c').nlink, 2);
    assert.deepEqual(names(kernel), ['.', '..', 'a', 'c']);
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
    assert.deepEqual(names(kernel), ['.', '..']);
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
    assert.deepEqual(names(kernel2), ['.', '..', 'file.txt', 'alias.txt']);
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
    assert.deepEqual(names(kernel), ['.', '..']);
    throwsCode(() => kernel.read(fd, 1), 'EBADF');
    kernel.create('b');
    assert.equal(kernel.stat('b').size, 0);
  });

  it('19c. mount за наявності відкритих fd викидає EBUSY', () => {
    const { kernel } = setup();
    kernel.create('a');
    kernel.open('a');
    throwsCode(() => kernel.mount(), 'EBUSY');
  });

  it('20a. некоректні імена та аргументи', () => {
    const { kernel } = setup();
    for (const bad of ['', '.', '..', '/', 'with space', 'x'.repeat(25), 'ключ']) {
      throwsCode(() => kernel.create(bad), 'EINVAL');
    }
    kernel.create('x'.repeat(24));
    kernel.create('a');
    throwsCode(() => kernel.create('a'), 'EEXIST');
    throwsCode(() => kernel.stat('nope'), 'ENOENT');
    throwsCode(() => kernel.open('nope'), 'ENOENT');
    throwsCode(() => kernel.link('nope', 'z'), 'ENOENT');
    throwsCode(() => kernel.link('a', 'a'), 'EEXIST');
    throwsCode(() => kernel.link('a', 'bad name'), 'EINVAL');
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
    assert.deepEqual(names(kernel), ['.', '..', 'a', 'b']);

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
    sb.writeUInt32LE(0x3442414c, 0);
    disk.writeBlock(0, sb);
    throwsCode(() => new Kernel(disk).mount(), 'ENOTFORMATTED');

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
    assert.deepEqual(names(kernel), ['.', '..', 'x']);
    assert.equal(kernel.fs.readInode(0).size, 128, 'неактивні записи перевикористовуються');
  });
});

const freeInodes = (kernel: Kernel): number => {
  let count = 0;
  for (let n = 0; n < kernel.fs.sb.inodeCount; n++) if (kernel.fs.readInode(n).type === 'free') count++;
  return count;
};

describe('Дерево директорій', () => {
  it('22. root містить . та .., mkdir підтримує nlink (приклад з презентації)', () => {
    const { kernel } = setup();
    assert.deepEqual(kernel.ls(), [
      { name: '.', inode: 0, type: 'dir' },
      { name: '..', inode: 0, type: 'dir' },
    ]);
    assert.equal(kernel.stat('/').nlink, 2);
    kernel.mkdir('dir1');
    assert.deepEqual([kernel.stat('dir1').type, kernel.stat('dir1').nlink], ['dir', 2]);
    kernel.mkdir('dir1/dir2');
    assert.equal(kernel.stat('dir1').nlink, 3);
    assert.equal(kernel.stat('/').nlink, 3);
    const dir1 = kernel.stat('dir1').id;
    const dir2 = kernel.stat('dir1/dir2').id;
    assert.deepEqual(kernel.ls('dir1/dir2').map((e) => [e.name, e.inode]), [['.', dir2], ['..', dir1]]);
    kernel.create('dir1/file.txt');
    kernel.symlink('file.txt', 'dir1/sym');
    assert.equal(kernel.stat('dir1').nlink, 3, 'файли та symlink не змінюють nlink директорії');
    throwsCode(() => kernel.mkdir('dir1'), 'EEXIST');
    throwsCode(() => kernel.create('dir1/dir2'), 'EEXIST');
    throwsCode(() => kernel.mkdir('nope/x'), 'ENOENT');
  });

  it('23. абсолютні та відносні шляхи, . та .., cd', () => {
    const { kernel } = setup();
    kernel.mkdir('/a');
    kernel.mkdir('/a/b');
    kernel.create('/a/b/f');
    const id = kernel.stat('/a/b/f').id;
    assert.equal(kernel.stat('a/./b/../b/f').id, id);
    assert.equal(kernel.stat('/../../a/b/f').id, id);
    assert.equal(kernel.stat('//a///b//f').id, id);
    kernel.cd('a/b');
    assert.equal(kernel.stat('f').id, id);
    assert.equal(kernel.stat('./f').id, id);
    assert.equal(kernel.stat('../b/f').id, id);
    assert.deepEqual(names(kernel), ['.', '..', 'f']);
    kernel.cd('..');
    assert.deepEqual(names(kernel), ['.', '..', 'b']);
    kernel.cd('/');
    assert.deepEqual(names(kernel), ['.', '..', 'a']);
    throwsCode(() => kernel.cd('a/b/f'), 'ENOTDIR');
    throwsCode(() => kernel.stat('a/b/f/x'), 'ENOTDIR');
    throwsCode(() => kernel.create('a/b/f/x'), 'ENOTDIR');
    throwsCode(() => kernel.ls('a/b/f'), 'ENOTDIR');
    throwsCode(() => kernel.cd('a/zzz'), 'ENOENT');
    throwsCode(() => kernel.open('a'), 'EISDIR');
    throwsCode(() => kernel.truncate('a', 10), 'EISDIR');
  });

  it('24. rmdir: порожня, непорожня, root, . та .., не директорія', () => {
    const { kernel } = setup();
    kernel.mkdir('d');
    kernel.mkdir('d/e');
    kernel.create('f');
    kernel.symlink('d', 'ld');
    throwsCode(() => kernel.rmdir('d'), 'ENOTEMPTY');
    throwsCode(() => kernel.rmdir('/'), 'EINVAL');
    throwsCode(() => kernel.rmdir('d/.'), 'EINVAL');
    throwsCode(() => kernel.rmdir('d/e/..'), 'EINVAL');
    throwsCode(() => kernel.rmdir('f'), 'ENOTDIR');
    throwsCode(() => kernel.rmdir('ld'), 'ENOTDIR');
    throwsCode(() => kernel.rmdir('nope'), 'ENOENT');
    assert.equal(kernel.stat('d').nlink, 3);
    kernel.rmdir('d/e');
    assert.equal(kernel.stat('d').nlink, 2);
    kernel.rmdir('d');
    assert.equal(kernel.stat('/').nlink, 2);
    assert.deepEqual(names(kernel), ['.', '..', 'f', 'ld']);
  });

  it('25. rmdir звільняє inode і блоки директорії', () => {
    const { kernel } = setup();
    const freeBlocks = kernel.fs.countFreeBlocks();
    const inodes = freeInodes(kernel);
    kernel.mkdir('d');
    for (let i = 0; i < 10; i++) kernel.create(`d/f${i}`);
    assert.equal(kernel.stat('d').nblock, 2);
    for (let i = 0; i < 10; i++) kernel.unlink(`d/f${i}`);
    kernel.rmdir('d');
    assert.equal(kernel.fs.countFreeBlocks(), freeBlocks);
    assert.equal(freeInodes(kernel), inodes);
  });

  it('26. видалення CWD (приклад з презентації) та перевикористання inode', () => {
    const { kernel } = setup();
    kernel.mkdir('/1');
    kernel.mkdir('/1/2');
    kernel.cd('/1/2');
    const removed = kernel.stat('.').id;
    kernel.rmdir('../2');
    assert.deepEqual(kernel.ls(), []);
    throwsCode(() => kernel.create('file.txt'), 'ENOENT');
    throwsCode(() => kernel.stat('.'), 'ENOENT');
    throwsCode(() => kernel.cd('..'), 'ENOENT');
    kernel.mkdir('/3');
    assert.equal(kernel.stat('/3').id, removed, 'inode перевикористано');
    assert.deepEqual(kernel.ls(), [], 'CWD не стала новою директорією');
    throwsCode(() => kernel.create('file.txt'), 'ENOENT');
    kernel.create('/1/abs.txt');
    assert.equal(kernel.stat('/1/abs.txt').type, 'reg');
    kernel.cd('/1');
    assert.deepEqual(names(kernel), ['.', '..', 'abs.txt']);
  });

  it('27. link та unlink не працюють з директоріями', () => {
    const { kernel } = setup();
    kernel.mkdir('d');
    throwsCode(() => kernel.link('d', 'd2'), 'EPERM');
    throwsCode(() => kernel.unlink('d'), 'EPERM');
    throwsCode(() => kernel.unlink('d/.'), 'EINVAL');
    assert.equal(kernel.stat('d').nlink, 2);
  });

  it('28. дерево зберігається після mount, CWD скидається на root', () => {
    const { kernel, disk, imgPath } = setup();
    kernel.mkdir('d');
    kernel.cd('d');
    kernel.symlink('../t', 'l');
    kernel.create('/t');
    disk.close();
    const disk2 = Disk.open(imgPath);
    cleanups.push(() => disk2.close());
    const kernel2 = new Kernel(disk2);
    kernel2.mount();
    assert.deepEqual(names(kernel2), ['.', '..', 'd', 't']);
    assert.equal(kernel2.open('d/l'), 0);
    assert.equal(kernel2.stat('d').nlink, 2);
  });
});

describe('Символічні посилання', () => {
  it('29. абсолютні, відносні, проміжні symlink (приклад з презентації)', () => {
    const { kernel } = setup();
    kernel.mkdir('dir1');
    kernel.mkdir('dir1/dir2');
    kernel.cd('dir1/dir2');
    kernel.create('file.txt');
    const file = kernel.stat('file.txt').id;
    kernel.mkdir('/a');
    kernel.mkdir('/a/b');
    kernel.symlink('/dir1', '/a/b/l1');
    const l1 = kernel.stat('/a/b/l1').id;
    assert.deepEqual(kernel.ls('/a/b').at(-1), { name: 'l1', inode: l1, type: 'sym', target: '/dir1' });
    assert.equal(kernel.open('/a/b/l1/dir2/file.txt'), 0);
    kernel.symlink('dir2/./../../dir1/././dir2/file.txt', '/dir1/l2');
    kernel.cd('/a/b');
    assert.equal(kernel.open('l1/l2'), 1);
    kernel.write(0, text('same'));
    assert.equal(kernel.read(1, 4).toString(), 'same');
    assert.equal(kernel.stat('/dir1/dir2/file.txt').id, file);
    assert.equal(kernel.stat('/dir1/dir2/file.txt').nlink, 1, 'symlink не змінює nlink цілі');
  });

  it('30. відносний symlink розкривається від своєї директорії, а не від CWD', () => {
    const { kernel } = setup();
    kernel.mkdir('x');
    kernel.mkdir('y');
    kernel.create('x/t');
    kernel.create('y/t');
    kernel.symlink('t', 'x/l');
    kernel.link('x/l', 'y/l');
    kernel.cd('y');
    assert.equal(kernel.stat('/x/l').id, kernel.stat('/y/l').id);
    const xl = kernel.open('/x/l');
    const yl = kernel.open('/y/l');
    kernel.write(xl, text('X'));
    kernel.write(yl, text('Y'));
    assert.equal(kernel.stat('/x/t').size, 1);
    assert.equal(kernel.stat('/y/t').size, 1);
    kernel.seek(xl, 0);
    assert.equal(kernel.read(xl, 1).toString(), 'X');
    kernel.mkdir('/x/sub');
    kernel.symlink('..', '/x/sub/up');
    assert.equal(kernel.stat('/x/sub/up/t').id, kernel.stat('/x/t').id, '.. після symlink — від цілі');
    kernel.symlink('/x/sub', '/y/s');
    assert.equal(kernel.stat('/y/s/../t').id, kernel.stat('/x/t').id);
  });

  it('31. stat не розкриває останній symlink, ланцюжки symlink', () => {
    const { kernel } = setup();
    kernel.create('f');
    kernel.symlink('f', 'l1');
    kernel.symlink('l1', 'l2');
    kernel.symlink('/l2', 'l3');
    const st = kernel.stat('l3');
    assert.deepEqual([st.type, st.nlink, st.size, st.nblock], ['sym', 1, 3, 1]);
    assert.notEqual(st.id, kernel.stat('f').id);
    assert.equal(kernel.open('l3'), 0);
    kernel.write(0, text('abc'));
    kernel.truncate('l3', 1);
    assert.equal(kernel.stat('f').size, 1);
    assert.equal(kernel.stat('l3').size, 3);
    kernel.mkdir('d');
    kernel.symlink('d', 'ld');
    kernel.cd('ld');
    kernel.create('inside');
    assert.deepEqual(names(kernel, '/d'), ['.', '..', 'inside']);
  });

  it('32. цикли symlink повертають ELOOP', () => {
    const { kernel } = setup();
    kernel.symlink('self', 'self');
    kernel.symlink('b', 'a');
    kernel.symlink('a', 'b');
    kernel.mkdir('d');
    kernel.symlink('.', 'd/loop');
    throwsCode(() => kernel.open('self'), 'ELOOP');
    throwsCode(() => kernel.open('a'), 'ELOOP');
    throwsCode(() => kernel.cd('b'), 'ELOOP');
    throwsCode(() => kernel.stat('a/x'), 'ELOOP');
    assert.equal(kernel.stat('a').type, 'sym');
    assert.equal(kernel.stat('d' + '/loop'.repeat(40)).type, 'sym');
    assert.equal(kernel.stat('d' + '/loop'.repeat(40) + '/.').type, 'dir');
    throwsCode(() => kernel.stat('d' + '/loop'.repeat(41) + '/.'), 'ELOOP');
    kernel.unlink('self');
  });

  it('33. dangling symlink: ціль створюється пізніше (приклад з презентації)', () => {
    const { kernel } = setup();
    kernel.mkdir('dir1');
    kernel.mkdir('dir1/dir2');
    kernel.mkdir('/a');
    kernel.mkdir('/a/b');
    kernel.symlink('some', 'dir1/dir2/data.txt');
    assert.deepEqual(kernel.ls('dir1/dir2').at(-1)?.target, 'some');
    throwsCode(() => kernel.open('/dir1/dir2/data.txt'), 'ENOENT');
    throwsCode(() => kernel.create('/dir1/dir2/data.txt'), 'EEXIST');
    kernel.link('/dir1/dir2/data.txt', '/a/b/document');
    const st = kernel.stat('/a/b/document');
    assert.deepEqual([st.type, st.nlink], ['sym', 2]);
    assert.equal(kernel.stat('/dir1/dir2/data.txt').id, st.id);
    kernel.create('/dir1/dir2/some');
    assert.equal(kernel.open('/dir1/dir2/data.txt'), 0);
    throwsCode(() => kernel.open('/a/b/document'), 'ENOENT');
  });

  it('34. максимальна довжина вмісту symlink — 256 байтів UTF-8', () => {
    const { kernel } = setup();
    kernel.symlink('x'.repeat(BLOCK_SIZE), 'ascii');
    assert.equal(kernel.stat('ascii').size, BLOCK_SIZE);
    assert.equal(kernel.ls().at(-1)?.target, 'x'.repeat(BLOCK_SIZE));
    kernel.symlink('ї'.repeat(BLOCK_SIZE / 2), 'utf8');
    assert.equal(kernel.ls().at(-1)?.target, 'ї'.repeat(BLOCK_SIZE / 2));
    throwsCode(() => kernel.symlink('x'.repeat(BLOCK_SIZE + 1), 'long'), 'EINVAL');
    throwsCode(() => kernel.symlink('ї'.repeat(BLOCK_SIZE / 2 + 1), 'long'), 'EINVAL');
    throwsCode(() => kernel.stat('long'), 'ENOENT');
    kernel.mkdir('d');
    kernel.symlink('', 'd/empty');
    const st = kernel.stat('d/empty');
    assert.deepEqual([st.type, st.size, st.nblock], ['sym', 0, 0]);
    assert.equal(kernel.ls('d').at(-1)?.target, '');
    assert.equal(kernel.stat('d/empty/.').id, kernel.stat('d').id, 'порожній вміст — пошук з директорії посилання');
  });

  it('35. unlink symlink не чіпає ціль, останнє посилання звільняє inode і блок', () => {
    const { kernel } = setup();
    kernel.create('f');
    const freeBlocks = kernel.fs.countFreeBlocks();
    const inodes = freeInodes(kernel);
    kernel.symlink('f', 'l');
    kernel.link('l', 'l2');
    assert.equal(kernel.stat('l2').nlink, 2);
    kernel.unlink('l');
    assert.equal(kernel.stat('l2').nlink, 1);
    assert.equal(kernel.fs.countFreeBlocks(), freeBlocks - 1);
    kernel.unlink('l2');
    assert.equal(kernel.fs.countFreeBlocks(), freeBlocks);
    assert.equal(freeInodes(kernel), inodes);
    assert.equal(kernel.stat('f').nlink, 1);
  });
});

describe('Помилки без витоку ресурсів', () => {
  it('36. ENOSPC / ENFILE під час mkdir та symlink', () => {
    const { kernel } = setup(4, 32 * BLOCK_SIZE);
    kernel.create('a');
    for (let i = 0; i < 5; i++) kernel.link('a', `l${i}`);
    const fd = kernel.open('a');
    kernel.write(fd, pattern(BLOCK_SIZE * 26));
    assert.equal(kernel.fs.countFreeBlocks(), 1);
    const before = names(kernel);
    throwsCode(() => kernel.mkdir('x'), 'ENOSPC');
    throwsCode(() => kernel.symlink('a', 'y'), 'ENOSPC');
    assert.equal(kernel.fs.countFreeBlocks(), 1);
    assert.equal(freeInodes(kernel), 2);
    assert.deepEqual(names(kernel), before);
    assert.equal(kernel.stat('/').nlink, 2);
    kernel.unlink('l0');
    kernel.mkdir('x');
    throwsCode(() => kernel.mkdir('x/y'), 'ENOSPC');
    assert.equal(kernel.stat('x').nlink, 2);
    assert.equal(freeInodes(kernel), 1);
    kernel.create('x/f');
    throwsCode(() => kernel.symlink('a', 'x/z'), 'ENFILE');
    throwsCode(() => kernel.mkdir('x/y'), 'ENFILE');
    assert.deepEqual(names(kernel, 'x'), ['.', '..', 'f']);
  });
});
