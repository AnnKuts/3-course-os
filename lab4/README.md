# Лабораторна робота №4 — Файлова система (частина 1)

## 1. Мета
Розробити драйвер файлової системи та частину підсистеми ядра (таблиця відкритих файлів) в програмі користувача.
Носієм є звичайний файл `disk.img`; усі дані, bitmap, inode та записи директорії фізично лежать у ньому.
Підтримано всі 12 команд методички: `mkfs, stat, ls, create, open, close, seek, read, write, link, unlink, truncate`.

## 2. Технології
TypeScript, Node.js 20+, `node:fs` (позиційні `readSync`/`writeSync`), `Buffer`, `node:test` + `node:assert/strict`.
Dev-залежності: `typescript`, `tsx`, `@types/node`.

## 3. Архітектура

| Файл | Роль |
|---|---|
| [src/types.ts](src/types.ts) | константи формату, типи, серіалізація superblock / inode / directory entry, `FsError` |
| [src/disk.ts](src/disk.ts) | `Disk`: читання/запис **цілих блоків** `disk.img`, перевірка меж |
| [src/filesystem.ts](src/filesystem.ts) | `FileSystem` (драйвер ФС): mkfs, bitmap, inode, директорія, direct/indirect, read/write/truncate |
| [src/kernel.ts](src/kernel.ts) | `Kernel`: таблиця відкритих файлів, fd, offset, відкладене видалення |
| [src/demo.ts](src/demo.ts) | демонстрація всіх команд |
| [tests/filesystem.test.ts](tests/filesystem.test.ts) | автотести |

Шари: `Kernel` → `FileSystem` → `Disk` → `disk.img`. Кешів немає: кожна операція читає/пише блоки диска.

## 4. Формат `disk.img`
BLOCK_SIZE = 256, DISK_SIZE = 1 MiB (4096 блоків), INODE_SIZE = 64, 6 direct + 1 single indirect (64 покажчики) → максимум 70 блоків = **17 920 байтів** на файл, ім'я ≤ 24 символи `[A-Za-z0-9_.-]`.

```text
блок 0            Superblock  (9 × uint32: magic, blockSize, totalBlocks, inodeCount,
                               bitmapStart, bitmapBlocks, inodeTableStart, inodeTableBlocks, dataStart)
блоки 1..B        Block bitmap (1 біт на блок, 4096 біт = 2 блоки)
далі              Inode table  (ceil(n / 4) блоків; inode №i за номером = позиція в масиві)
далі до кінця     Data region  (блоки директорії, дані файлів, indirect-блоки)
```
Межі обчислює `computeLayout` послідовно (без magic offsets); при `mount` вони перевіряються. Для `mkfs 100`: bitmap 1..2, inode table 3..27, дані 28..4095.
Усі службові блоки (superblock, bitmap, inode table) позначені в bitmap як зайняті, тому allocator їх не видасть. Блок №0 — superblock, тому номер `0` у покажчику означає «блоку немає».

**Inode (64 байти):** `type` (free / regular / directory), `nlink`, `size`, `direct[6]`, `indirect`. Імені в inode немає. Root — inode №0 (входить у `n` з `mkfs`).

**Запис директорії (32 байти):** 24 байти ASCII-ім'я, `int32` номер inode (`-1` = недійсний запис), 4 байти резерв. Недійсні записи повторно використовуються. Директорія — звичайний inode типу `directory`, її записи лежать у блоках.

### Direct / indirect
Логічний блок `lbn = floor(offset / 256)`, зсув у блоці `offset % 256`. `lbn 0..5` → `direct[lbn]`; `lbn 6..69` → елемент `lbn-6` блоку, на який вказує `indirect`. Indirect-блок виділяється лише при першому ненульовому покажчику і звільняється, коли всі його покажчики стали 0.

## 5. Hard links
Ім'я — це лише запис директорії `(name → inode)`. `link` додає запис і збільшує `nlink` (нових inode та копіювання даних немає). `unlink` деактивує запис і зменшує `nlink`. Файл (блоки + inode) звільняється, коли `nlink == 0` **і** `Kernel` не має відкритих fd на цей inode (звільнення виконується в `unlink` або в останньому `close`). Якщо програму зупинили з відкритим unlinked-файлом, при наступному `mount` такі «осиротілі» inode звільняються.

## 6. Sparse files
Покажчик 0 означає «нульовий блок»: читання повертає нулі, блок не виділено.
- `truncate` на більший розмір лише змінює `size` (`nblock=0`).
- Запис, після якого блок складається лише з нулів, блок не виділяє, а наявний — звільняє (так сказано в методичці).
- `truncate` на менший розмір звільняє блоки за межею, занулює хвіст останнього блоку (старі дані не повертаються) і звільняє його, якщо він став нульовим.
- `nblock` у `stat` — кількість реально виділених блоків даних (indirect-блок не рахується).

## 7. Запуск
```bash
npm install
npm run demo     # демонстрація (створює disk.img у поточній теці)
npm test         # автотести (node:test, тимчасові образи)
npm run build    # tsc → dist/
```

## 8. Команди (програмний API `Kernel`)

| Команда методички | Виклик | Примітка |
|---|---|---|
| `mkfs n` | `kernel.mkfs(n)` | `n` — кількість inode; стирає попередню ФС |
| (підключення існуючого) | `kernel.mount()` | без змін даних; помилка для неформатованого/пошкодженого образу |
| `stat name` | `kernel.stat(name)` | `{id,type,nlink,size,nblock,direct,indirect}` |
| `ls` | `kernel.ls()` | `[{name, inode, type}]` |
| `create name` | `kernel.create(name)` | блоків не виділяє |
| `fd = open name` | `kernel.open(name)` | найменший вільний fd |
| `close fd` | `kernel.close(fd)` | можливе фінальне звільнення файлу |
| `seek fd offset` | `kernel.seek(fd, offset)` | offset може бути за EOF; розмір не змінюється |
| `read fd size` | `kernel.read(fd, size)` → `Buffer` | див. нижче |
| `write fd size` | `kernel.write(fd, data)` → кількість байтів | `size = data.length` |
| `link name1 name2` | `kernel.link(name1, name2)` | |
| `unlink name` | `kernel.unlink(name)` | |
| `truncate name size` | `kernel.truncate(name, size)` | |

**Поведінка `read` за EOF.** Дані за кінцем файлу не повертаються, тому буфер може бути коротшим за `size` (або порожнім). Згідно з методичкою offset завжди збільшується на запитане `size`.

Приклад (вивід `npm run demo`):
```text
> truncate some.dat 1024
> stat some.dat
id=2, type=reg, nlink=1, size=1024, nblock=0
> write 0 10
0123456789
> stat some.dat
id=2, type=reg, nlink=1, size=1024, nblock=1
> seek 0 512
> write 0 7
abcdefg
> stat some.dat
id=2, type=reg, nlink=1, size=1024, nblock=2
```
У презентації BLOCK_SIZE=128 (третій блок — offset 256), у нас 256, тому запис іде на offset 512. Номери inode відрізняються від прикладів презентації — вони лише ілюстративні.

## 9. Перевірені крайові випадки
Некоректні/задовгі/дубльовані імена; неіснуючі файли та fd; від'ємні й нецілі offset/size; вичерпання inode; вичерпання блоків (помилка до змін, без часткового запису); перевищення 17 920 байтів; запис через межі блоків і на границі; нулі як дані; sparse-читання; запис лише нулів; indirect (блок 6 і останній блок 69); звільнення indirect; повторне збільшення після truncate; відсутність перетину блоків між файлами; перевикористання inode, fd, блоків і записів директорії (немає «витоку»); `unlink` відкритого файлу; перезапуск без `mkfs`; повторний `mkfs`; неформатований і пошкоджений образ.

## 10. Що потрібно знати для захисту
- **Чому диск — файл?** Методичка дозволяє використати звичайний файл як носій. `Disk` вміє лише читати/писати блоки по 256 байтів; вся логіка ФС — наша.
- **Inode vs fd.** Inode — постійний номер об'єкта в таблиці на диску. fd — тимчасовий номер відкриття в пам'яті ядра (з власним offset); видається найменший вільний.
- **Ім'я не в inode.** Ім'я — запис директорії `(ім'я, inode)`. Тому в одного файлу може бути кілька імен (hard links), а `nlink` рахує їх.
- **Bitmap.** 1 біт на блок; allocator шукає перший вільний біт у data region, `free` скидає біт і прибирає покажчик у inode/indirect (щоб не було dangling pointers).
- **Direct + indirect.** 6 прямих покажчиків + 1 блок з 64 покажчиками = 70 блоків.
- **Sparse.** Покажчик 0 = нульовий блок, не займає місця; `truncate` вгору лише змінює `size`.
- **Відкладене видалення.** `unlink` не чіпає дані, якщо файл відкритий; остаточно файл звільняється в останньому `close`.
- **Узгодженість при помилках.** `write` спочатку перевіряє розмір і кількість потрібних блоків, і лише потім змінює диск. `create`/`link` спочатку додають запис директорії, потім змінюють inode.

## 11. Обмеження
Одна плоска директорія (до 560 імен, 70 блоків × 8 записів); без журналу — аварійне завершення посеред операції може лишити диск неузгодженим; offset після `read` збільшується на `size`, а не на фактично прочитане (за методичкою).
