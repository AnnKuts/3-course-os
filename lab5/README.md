# Лабораторна робота №5 — Файлова система (частина 2)

## 1. Мета
Додати до драйвера ФС з лабораторної роботи №4 дерево директорій, шляхові імена, поточну робочу директорію (CWD) та символічні посилання. Усі команди ЛР4 працюють із шляховими іменами; додано `mkdir`, `rmdir`, `cd`, `symlink`.

## 2. Архітектура
`Kernel` → `FileSystem` → `Disk` → `disk.img` (окремий образ у `lab5/`).

| Файл | Роль |
|---|---|
| [src/types.ts](src/types.ts) | константи формату, типи inode (`free/regular/directory/symlink`), серіалізація, `FsError` |
| [src/disk.ts](src/disk.ts) | блоковий ввід/вивід (без змін) |
| [src/filesystem.ts](src/filesystem.ts) | драйвер ФС: bitmap, inode, директорії, `resolvePath`, `resolveParent`, `mkdir/rmdir/symlink/link/unlink` |
| [src/kernel.ts](src/kernel.ts) | таблиця відкритих файлів, fd, offset, відкладене видалення, **CWD**, `cd` |
| [src/demo.ts](src/demo.ts) | демонстрація: приклади з презентації + додаткові перевірки |
| [tests/filesystem.test.ts](tests/filesystem.test.ts) | автотести (регресія ЛР4 + ЛР5) |

## 3. Формат даних
Як у ЛР4, але з власним magic `0x3542414c` (`LAB5`): образ ЛР4 (`LAB4`) при `mount` відхиляється з `ENOTFORMATTED`. Блок 256 Б, диск 1 MiB, inode 64 Б (6 direct + 1 single indirect, максимум 17 920 Б), запис директорії 32 Б (24 Б ім'я ASCII + `int32` номер inode, `-1` — недійсний запис), root — inode №0.

**Типи inode:** `0` free, `1` regular (`reg`), `2` directory (`dir`), `3` symlink (`sym`).

**Директорія** — inode типу `directory`, записи лежать у блоках даних. Кожна директорія при створенні явно отримує записи `.` (на себе) та `..` (на батьківську); у root обидва вказують на root (`mkfs` ініціалізує їх).

**Лічильник жорстких посилань директорії:** нова директорія має `nlink = 2` (ім'я в батьківській + `.`); кожна піддиректорія додає 1 (її `..`). `mkdir` збільшує `nlink` батьківської, `rmdir` — зменшує. Файли та symlink не змінюють `nlink` директорії.

**Символічне посилання** — окремий inode з власними `nlink`, `size` та блоком; вміст — рядок (0..256 байтів UTF-8), записаний звичайним `writeData` (порожній рядок блоків не займає). При створенні рядок не інтерпретується, ціль може не існувати, `nlink` цілі не змінюється.

## 4. Пошук за шляховим іменем
`resolvePath(pathname, cwd, followFinal)`:
1. Старт: root, якщо шлях починається з `/`, інакше CWD.
2. Компоненти обробляються послідовно (без лексичної нормалізації); `.` та `..` — звичайні записи директорії.
3. Поточний об'єкт перед пошуком компонента має бути директорією, інакше `ENOTDIR`; відсутній компонент — `ENOENT`.
4. Якщо компонент — symlink (проміжний або останній при `followFinal`), його вміст підставляється перед рештою компонентів; пошук продовжується з root (вміст починається з `/`) або з **директорії, що містить жорстке посилання на symlink**.
5. Лічильник розкриттів спільний для всього пошуку; більше `MAX_SYMLINK_HOPS = 40` → `ELOOP`.

`resolveParent(pathname, cwd)` повертає батьківську директорію та останній компонент (перевіряється як ім'я: 1..24 символи `[A-Za-z0-9_.-]`, крім `.` та `..`). Використовується в `create`, `mkdir`, `symlink`, `link` (ціль), `unlink`, `rmdir`; останній symlink при цьому не розкривається.

| Команда | Проміжні symlink | Останній symlink |
|---|---|---|
| `open`, `cd`, `ls pathname`, `truncate` | так | так |
| `stat`, `link` (джерело), `unlink`, `rmdir` | так | ні |
| `create`, `mkdir`, `symlink`, `link` (ціль) | так | — (запис не повинен існувати, навіть dangling symlink → `EEXIST`) |

## 5. CWD
Зберігається в `Kernel` як номер inode, після `mkfs`/`mount` — root. Як у презентації, CWD можна видалити (`rmdir ../2`). Тоді CWD позначається як видалена (`INACTIVE_INODE`), а не скидається на root: `ls` виводить порожній список, відносні шляхи дають `ENOENT`, абсолютні працюють. Тому перевикористання звільненого inode новою директорією не «повертає» CWD.

## 6. Команди (`Kernel`)

| Команда | Виклик | Поведінка / помилки |
|---|---|---|
| `mkfs n` | `mkfs(n)` | root з `.` і `..` |
| `stat pathname` | `stat(p)` | інформація про сам symlink, якщо він останній |
| `ls [pathname]` | `ls(p?)` | без аргументу — CWD; включає `.`, `..`; для `sym` — `target` |
| `create pathname` | `create(p)` | `EEXIST` |
| `open pathname` | `open(p)` | лише звичайний файл (`EISDIR`) |
| `close`, `seek`, `read`, `write` | як у ЛР4 | offset після `read` збільшується на запитаний `size` |
| `link p1 p2` | `link(p1, p2)` | на файл або symlink; на директорію — `EPERM` |
| `unlink pathname` | `unlink(p)` | файл або symlink; директорія — `EPERM`; відкладене видалення |
| `truncate pathname size` | `truncate(p, n)` | лише звичайний файл |
| `mkdir pathname` | `mkdir(p)` | `EEXIST`, `ENOSPC`, `ENFILE` без витоку ресурсів |
| `rmdir pathname` | `rmdir(p)` | `ENOTEMPTY`, `ENOTDIR`, root / `.` / `..` — `EINVAL`; звільняє inode і блоки |
| `cd pathname` | `cd(p)` | `ENOTDIR` |
| `symlink str pathname` | `symlink(str, p)` | `str` до 256 байтів UTF-8 (зокрема порожній), інакше `EINVAL` |

## 7. Запуск
```bash
npm install
npm run build
npm test
npm run demo     # створює lab5/disk.img
```

Фрагмент `npm run demo` (номери inode відрізняються від презентації через інший формат):
```text
> mkdir dir1/dir2
> stat dir1
id=1, type=dir, nlink=3, size=96, nblock=1
> ls /a/b
.               => dir, 5
..              => dir, 4
l1              => sym, 6 -> /dir1
> unlink /dir1/dir2
Not allowed
> cd /1/2
> rmdir ../2
> ls
> create file.txt
No such file or directory
```

## 8. Відповідність вимогам

| Вимога ЛР5 | Реалізація | Перевірка |
|---|---|---|
| Дерево директорій, явні `.` та `..` | `FileSystem.mkfs`, `mkdir` | тести 22, 23; демо (презентація, приклад 1) |
| `nlink` директорій | `mkdir`, `rmdir` | тести 22, 24; демо |
| Абсолютні / відносні шляхи, `.`, `..` у всіх командах | `resolvePath`, `resolveParent` | тести 23, 29, 30 |
| CWD, `cd` | `Kernel.cd`, `Kernel.cwd` | тести 23, 26 |
| `mkdir` | `FileSystem.mkdir` | тести 22, 36 |
| `rmdir` лише порожньої директорії | `FileSystem.rmdir` | тести 24, 25; демо |
| Видалення CWD | `Kernel.rmdir` | тест 26; демо (приклад 6) |
| `symlink str pathname`, ≤ 1 блок | `FileSystem.symlink` | тести 34, 36; демо |
| Розкриття symlink: абсолютні та відносні від директорії посилання | `resolvePath` | тести 29, 30, 31 |
| Обмеження кількості переходів (цикли) | `MAX_SYMLINK_HOPS`, `ELOOP` | тест 32; демо |
| Dangling symlink, `nlink` цілі не змінюється | `symlink` | тести 29, 33; демо (приклад 5) |
| `link`/`unlink` працюють із самим symlink | `link`, `removeLink` | тести 33, 35; демо (приклад 4) |
| `link` не створює посилань на директорії, `unlink` не працює з ними | `link`, `removeLink` (`EPERM`) | тест 27; демо |
| Функціональність ЛР4 | без змін | тести 1–21; демо |

## 9. Обмеження
Ім'я компонента ≤ 24 символів ASCII; до 560 записів у директорії; без журналу; немає прав доступу, часу модифікації, `rename`; інтерактивного CLI немає — команди викликаються в `demo.ts` (дозволено методичкою).
