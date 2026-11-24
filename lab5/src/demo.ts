import * as path from 'node:path';
import { Disk } from './disk';
import { Kernel } from './kernel';
import { BLOCK_SIZE, DISK_SIZE, FsError } from './types';
import type { DirListing, FsErrorCode, Stat } from './types';

const IMAGE = path.join(process.cwd(), 'disk.img');

const ERROR_TEXT: Partial<Record<FsErrorCode, string>> = {
  ENOENT: 'No such file or directory',
  EPERM: 'Not allowed',
  EEXIST: 'File exists',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  EINVAL: 'Invalid argument',
};

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

const fmtStat = (s: Stat): string => `id=${s.id}, type=${s.type}, nlink=${s.nlink}, size=${s.size}, nblock=${s.nblock}`;
const fmtEntry = (e: DirListing): string =>
  `${e.name.padEnd(16)}=> ${e.type}, ${e.inode}${e.target !== undefined ? ` -> ${e.target}` : ''}`;

function execute(k: Kernel, line: string, data?: string): string | void {
  const [cmd, ...args] = line.split(' ');
  const num = (i: number): number => Number(args[i]);
  switch (cmd) {
    case 'mkfs': return k.mkfs(num(0));
    case 'mount': return k.mount();
    case 'stat': return fmtStat(k.stat(args[0]));
    case 'ls': return k.ls(args[0]).map(fmtEntry).join('\n');
    case 'create': return k.create(args[0]);
    case 'open': return `fd = ${k.open(args[0])}`;
    case 'close': return k.close(num(0));
    case 'seek': return k.seek(num(0), num(1));
    case 'read': return show(k.read(num(0), num(1)));
    case 'write': return void k.write(num(0), Buffer.from(data ?? '', 'utf8').subarray(0, num(1)));
    case 'link': return k.link(args[0], args[1]);
    case 'unlink': return k.unlink(args[0]);
    case 'truncate': return k.truncate(args[0], num(1));
    case 'mkdir': return k.mkdir(args[0]);
    case 'rmdir': return k.rmdir(args[0]);
    case 'cd': return k.cd(args[0]);
    case 'symlink': return k.symlink(args[0], args[1]);
    default: throw new Error(`невідома команда ${cmd}`);
  }
}

function main(): void {
  let disk = Disk.create(IMAGE, DISK_SIZE);
  let k = new Kernel(disk);

  const run = (line: string, data?: string): void => {
    console.log(`> ${line}`);
    if (data !== undefined) console.log(data);
    try {
      const out = execute(k, line, data);
      if (out) console.log(out);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      console.log(ERROR_TEXT[e.code] ?? e.message);
    }
  };
  const comment = (text: string): void => console.log(`\n// ${text}`);
  const section = (title: string): void => console.log(`\n=== ${title} ===`);
  const freeBlocks = (): void => console.log(`free_blocks=${k.fs.countFreeBlocks()}`);

  console.log(`OS Lab 5 | Block size: ${BLOCK_SIZE} B | Disk: 1 MiB | Inodes: 100`);
  run('mkfs 100');

  section('ПРИКЛАДИ З ПРЕЗЕНТАЦІЇ');

  comment('Створюємо директорію, на неї вказують жорсткі посилання dir1 у CWD та . у створеній директорії.');
  run('mkdir dir1');
  run('stat dir1');
  comment('Створимо директорію у dir1, тепер на dir1 вказує ще й .. у створеній директорії.');
  run('mkdir dir1/dir2');
  run('stat dir1');
  comment('Виведемо вміст CWD, зараз це директорія /.');
  run('ls');
  comment('Виведемо інформацію про директорію /.');
  run('stat /');

  comment('Створимо звичайний файл у /dir1/dir2 та звернемося до нього через різні шляхові імена.');
  run('cd dir1/dir2');
  run('create file.txt');
  run('mkdir /a');
  run('mkdir /a/b');
  run('symlink /dir1 /a/b/l1');
  run('ls /a/b');
  run('open /a/b/l1/dir2/file.txt');
  run('symlink dir2/./../../dir1/././dir2/file.txt /dir1/l2');
  run('cd /a/b');
  run('open l1/l2');

  comment('Перевіримо до яких типів файлів дозволено виконувати команду unlink.');
  run('cd /');
  run('unlink /dir1/l2');
  run('unlink /a/b/l1');
  run('unlink dir1/dir2/file.txt');
  run('unlink /dir1/dir2');

  comment('Можна створити додаткові жорсткі посилання на символічне посилання.');
  run('symlink some dir1/dir2/data.txt');
  run('ls dir1/dir2');
  run('link /dir1/dir2/data.txt /a/b/document');
  run('ls /a/b');
  run('stat /a/b/document');
  run('stat /dir1/dir2/data.txt');

  comment('Символічне посилання не обов\'язково має «вказувати» на файл.');
  run('open /dir1/dir2/data.txt');
  run('create /dir1/dir2/some');
  run('open /dir1/dir2/data.txt');

  comment('Директорія CWD не обов\'язково може існувати.');
  run('mkdir /1');
  run('mkdir /1/2');
  run('cd /1/2');
  run('rmdir ../2');
  run('ls');
  run('create file.txt');

  section('ДОДАТКОВІ ПЕРЕВІРКИ');

  comment('rmdir: непорожня та порожня директорія, root, звичайний файл.');
  run('cd /');
  run('rmdir /1/../dir1');
  run('rmdir /');
  run('rmdir /dir1/dir2/some');
  run('mkdir /tmp');
  run('stat /');
  run('rmdir tmp');
  run('stat /');

  comment('Жорсткі посилання на директорії заборонені.');
  run('link /a /a2');

  comment('Цикли символічних посилань.');
  run('symlink loop /loop');
  run('symlink /ping /pong');
  run('symlink /pong /ping');
  run('open /loop');
  run('cd /ping');
  run('stat /ping');

  comment(`Максимальна довжина вмісту символічного посилання — ${BLOCK_SIZE} байтів.`);
  run(`symlink ${'x'.repeat(BLOCK_SIZE)} /max`);
  run('stat /max');
  run('unlink /max');
  run(`symlink ${'x'.repeat(BLOCK_SIZE + 1)} /toolong`);

  comment('Відносний symlink розкривається від директорії, що містить жорстке посилання на нього: document -> /a/b/some.');
  run('open /a/b/document');

  comment('Читання та запис звичайного файлу через шляхові імена, sparse-файл, indirect-блок.');
  run('truncate /dir1/dir2/data.txt 1024');
  run('stat /dir1/dir2/some');
  run('open /dir1/dir2/data.txt');
  run('write 3 10', '0123456789');
  run('seek 3 7');
  run('read 3 2');
  run('seek 3 512');
  run('write 3 7', 'abcdefg');
  run('stat /dir1/dir2/some');
  run('seek 3 0');
  run('read 3 519');
  run(`seek 3 ${6 * BLOCK_SIZE}`);
  run('write 3 13', 'seventh-block');
  run('stat /dir1/dir2/some');

  comment('Відкладене видалення: файл без жорстких посилань доступний через відкритий fd.');
  run('close 2');
  run('unlink /dir1/dir2/some');
  run('ls /dir1/dir2');
  freeBlocks();
  run('seek 3 0');
  run('read 3 10');
  run('close 3');
  freeBlocks();

  comment('Збереження дерева після перезапуску (mount без mkfs).');
  run('close 0');
  run('close 1');
  disk.close();
  disk = Disk.open(IMAGE);
  k = new Kernel(disk);
  run('mount');
  run('ls');
  run('ls /a/b');
  disk.close();
}

main();
