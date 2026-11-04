# Архітектура та діаграма класів файлової системи

У цьому документі наведено аналіз структури розробленої файлової системи (Лабораторна робота №4) та діаграму класів у форматі Mermaid.

---

## 1. Архітектурний аналіз

Архітектура побудована за принципом чіткого розділення відповідальності на три основні рівні:

1. **Рівень блокового носія (`Disk`)**:
   - Абстрагує файл віртуального диска `disk.img` як послідовність фізичних блоків фіксованого розміру (256 байтів).
   - Забезпечує суворо блоковий ввід/вивід (`readBlock`, `writeBlock`) із контролем меж диска.
   - Не містить знань про структуру самої файлової системи.

2. **Рівень драйвера файлової системи (`FileSystem`)**:
   - Реалізує внутрішню логіку дискових структур:
     - **Superblock**: читання та ініціалізація метаданих розміщення.
     - **Block Bitmap**: бітова карта зайнятості блоків, виділення (`allocBlock`) та звільнення (`freeBlock`).
     - **Inode Table**: збереження та завантаження дескрипторів файлів (тип, розмір, `nlink`, прямі та непрямі покажчики).
     - **Директорія**: збереження записів `(name, inode)` у блоках кореневої директорії, повторне використання вільних слотів (`INACTIVE_INODE = -1`).
     - **Блокова адресація**: 6 прямих покажчиків (`direct`) + 1 непрямий покажчик (`indirect` на блок із 64 номерами).
     - **Sparse-файли**: підтримка нерозподілених нульових блоків без їх фізичного створення на диску.

3. **Рівень підсистеми ядра (`Kernel`)**:
   - Керує станом у пам'яті (in-memory kernel state):
     - Таблиця відкритих файлів (`openFiles`) та видача мінімального вільного цілочисельного дескриптора `fd`.
     - Незалежні покажчики позиції читання/запису (`offset`) для кожного відкритого `fd`.
     - Лічильники відкритих файлів (`openCount`) для реалізації семантики POSIX: відкладене фізичне видалення файлу після `unlink`, якщо він залишається відкритим у процесі.

---

## 2. Діаграма класів (Mermaid Class Diagram)

```mermaid
classDiagram
    direction TB

    class Error {
        <<built-in>>
    }

    class FsError {
        +FsErrorCode code
        +string message
        +constructor(code: FsErrorCode, message: string)
    }
    Error <|-- FsError

    class Disk {
        -number fd
        +number blockCount
        -Disk(fd: number, blockCount: number)
        +create(path: string, size: number) Disk$
        +open(path: string) Disk$
        +readBlock(block: number) Buffer
        +writeBlock(block: number, data: Uint8Array) void
        +close() void
        -checkAccess(block: number) number
    }

    class FileSystem {
        -Superblock superblock
        -Disk disk
        +constructor(disk: Disk)
        +mkfs(inodeCount: number) void
        +mount() void
        +get sb() Superblock
        +isBlockUsed(block: number) boolean
        +countFreeBlocks() number
        +readInode(number: number) Inode
        +writeInode(inode: Inode) void
        +readData(inodeNumber: number, offset: number, length: number) Buffer
        +writeData(inodeNumber: number, offset: number, data: Uint8Array) number
        +releaseInode(inodeNumber: number) void
        +reclaimOrphans() number
        +lookup(name: string) number
        +create(name: string) number
        +link(existing: string, newName: string) void
        +removeLink(name: string) Inode
        +truncate(name: string, size: number) void
        +stat(name: string) Stat
        +statInode(inodeNumber: number) Stat
        +blocksOf(name: string) number[]
        +ls() DirListing[]
        -allocBlock() number
        -freeBlock(block: number) void
        -bitmapLocation(block: number) Object
        -inodePosition(number: number) Object
        -findFreeInode() number
        -getBlock(inode: Inode, lbn: number) number
        -setBlock(inode: Inode, lbn: number, phys: number) void
        -dataBlocks(inode: Inode) number[]
        -truncateInode(inode: Inode, newSize: number) void
        -requireUsed(inode: Inode) void
        -readEntries() Object[]
        -addEntry(name: string, inode: number) void
        -removeEntry(slot: number) void
        -findEntry(name: string) Object
    }

    class Kernel {
        +FileSystem fs
        -OpenFile[] openFiles
        -Map openCount
        +constructor(disk: Disk)
        +mkfs(inodeCount: number) void
        +mount() void
        +stat(name: string) Stat
        +ls() DirListing[]
        +create(name: string) void
        +link(name1: string, name2: string) void
        +truncate(name: string, size: number) void
        +open(name: string) number
        +close(fd: number) void
        +seek(fd: number, offset: number) void
        +read(fd: number, size: number) Buffer
        +write(fd: number, data: Uint8Array) number
        +unlink(name: string) void
        +get openFileCount() number
        -releaseIfUnused(inodeNumber: number) void
        -getOpenFile(fd: number) OpenFile
    }

    class OpenFile {
        <<interface>>
        +number inode
        +number offset
    }

    class Superblock {
        <<interface>>
        +number magic
        +number blockSize
        +number totalBlocks
        +number inodeCount
        +number bitmapStart
        +number bitmapBlocks
        +number inodeTableStart
        +number inodeTableBlocks
        +number dataStart
    }

    class Inode {
        <<interface>>
        +number number
        +InodeType type
        +number nlink
        +number size
        +number[] direct
        +number indirect
    }

    class Stat {
        <<interface>>
        +number id
        +string type
        +number nlink
        +number size
        +number nblock
        +number[] direct
        +number indirect
    }

    class DirListing {
        <<interface>>
        +string name
        +number inode
        +string type
    }

    Kernel *-- FileSystem : керує через
    Kernel o-- OpenFile : зберігає в таблиці дескрипторів
    FileSystem o-- Disk : взаємодія через блоковий ввід/вивід
    FileSystem ..> Superblock : серіалізація / парсинг
    FileSystem ..> Inode : серіалізація / адресація
    FileSystem ..> Stat : формування результату
    FileSystem ..> DirListing : формування списку директорії
    Kernel ..> Stat : повертає користувачеві
    Kernel ..> DirListing : повертає користувачеві
    Disk ..> FsError : генерує помилки
    FileSystem ..> FsError : генерує помилки
    Kernel ..> FsError : генерує помилки
```

---

## 3. Взаємозв'язки та життєвий цикл операцій

- **Створення файлу (`Kernel.create`)**:
  `Kernel.create()` $\to$ `FileSystem.create()` $\to$ пошук вільного слота в кореневій директорії $\to$ пошук вільного `Inode` $\to$ запис `Inode` на диск із `nlink=1, size=0`.

- **Відкриття файлу (`Kernel.open`)**:
  `Kernel.open()` $\to$ `FileSystem.lookup()` (перевірка наявності в директорії) $\to$ виділення найменшого вільного числового `fd` в `Kernel.openFiles` $\to$ встановлення початкового `offset = 0` $\to$ збільшення лічильника в `Kernel.openCount`.

- **Читання та запис (`Kernel.read` / `Kernel.write`)**:
  `Kernel` транслює числовий `fd` у відповідний номер `inode` та поточний `offset`.
  `FileSystem.readData()` / `FileSystem.writeData()` обчислюють номери логічних блоків `lbn = Math.floor(pos / BLOCK_SIZE)` та зсув `pos % BLOCK_SIZE`, звертаючись до direct-масиву або indirect-блоку. Фізичний ввід/вивід делегується в `Disk.readBlock()` / `Disk.writeBlock()`.

- **Видалення (`Kernel.unlink`) та відкладене звільнення**:
  `Kernel.unlink()` видаляє запис із директорії через `FileSystem.removeLink()` та зменшує `nlink`. Якщо на момент видалення файл ще відкритий (`openCount > 0`), блоки та `Inode` залишаються цілими. Лише під час виклику `Kernel.close()`, коли лічильник відкриттів спадає до 0, викликається `FileSystem.releaseInode()` для остаточного звільнення блоків у bitmap.
