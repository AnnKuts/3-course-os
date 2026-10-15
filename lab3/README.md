# OS Lab 3 — Page Replacement Algorithms

**Варіант 3:** Random + WSClock (Working Set Clock)  
**Мова:** TypeScript / Node.js

## Структура проєкту

```
src/
  memory.ts        — PTE, PageTable, PhysicalPage
  algorithms.ts    — ReplacementStrategy, RandomReplacement, WSClockReplacement
  process.ts       — WorkingSet, Process (+ типи AccessType, ProcessConfig, ...)
  kernel.ts        — Kernel (MMU + BackingStore вбудовані)
  simulation.ts    — Simulation, SimulationConfig, printStats
  rng.ts           — SeededRNG (відтворюваний PRNG)
  main.ts          — основний запуск (npm start)
  demo.ts          — детальний verbose-вивід (npm run demo)
  experiment.ts    — серія дослідів (npm run experiment)
  __tests__/
    simulation.test.ts  — 19 тестів (Node built-in test runner)
```

## Команди

```bash
npm install          # встановити залежності
npm start            # компіляція + основна симуляція
npm run demo         # verbose демонстрація (малий приклад)
npm run experiment   # серія дослідів за розміром робочого набору
npm test             # компіляція + запуск тестів
npm run build        # тільки компіляція
```

## Конфігурація за замовчуванням (main)

| Параметр | Значення |
|---|---|
| Фізичні фрейми | 40 |
| Процеси | 3 (lifetime=500) |
| Квант Round Robin | 20 звернень |
| WSClock TAU | 180 звернень |
| Всього звернень | 1500 |
| Seed | 42 |
| Локальність | 90% |
| Ймовірність запису | 30% |

## Результати (основна симуляція, seed=42)

| Алгоритм | Сторінкові промахи | Частота | Виселень |
|---|---|---|---|
| Random   | 350 | 23.33% | 298 |
| WSClock  | 317 | 21.13% | 264 |
| **Різниця** | **−33** | **−2.20%** | — |

## Експерименти (вплив розміру WS)

| WS | Звернень | Random | Random% | WSClock | WSClock% | Результат |
|---|---|---|---|---|---|---|
| 4  | 1500 | 174 | 11.60% | 135 | 9.00%  | WSClock −22.4% |
| 8  | 1500 | 250 | 16.67% | 197 | 13.13% | WSClock −21.2% |
| 12 | 1500 | 426 | 28.40% | 408 | 27.20% | WSClock −4.2%  |
| 16 | 1500 | 575 | 38.33% | 567 | 37.80% | WSClock −1.4%  |
| 20 | 1500 | 715 | 47.67% | 646 | 43.07% | WSClock −9.7%  |
| 24 | 1500 | 770 | 51.33% | 759 | 50.60% | WSClock −1.4%  |

## Алгоритм WSClock

Кільцевий алгоритм. Для кожного фрейму при виселенні:

1. **R=1** → скидаємо R=0, оновлюємо `lastAccessTime = currentTime`, рухаємось далі  
2. **R=0, age ≤ TAU** → сторінка в робочому наборі, пропускаємо  
3. **R=0, age > TAU, M=0** → негайно виселяємо (чиста стара сторінка)  
4. **R=0, age > TAU, M=1** → брудна: запам'ятовуємо як кандидата, шукаємо далі  

Якщо після повного оберту чистої жертви немає — виселяємо найстарішого брудного кандидата (ініціюється запис на диск). Резервний варіант — перший незвернений фрейм.

## Тестовий набір

18 тестів у 6 групах:
1. Структури даних (PTE, PhysicalPage)
2. Поведінка MMU (через Kernel)
3. Алгоритм WSClock
4. Kernel (розподіл, статистика, інваріанти)
5. Round-Robin планування
6. Відтворюваність симуляції
