import { SimulationConfig } from './simulation';
import { Simulation } from './simulation';

export function runExperiments(): void {
  const FRAMES = 40;
  const WS_SIZES = [4, 8, 12, 16, 20, 24];

  console.log(`${'='.repeat(70)}`);
  console.log(`OS Lab 3 — Experiment: Effect of Working Set Size on Page Faults`);
  console.log(`Frames=${FRAMES}, Seed=42, Accesses=1500, Processes=3, TAU=180`);
  console.log(`${'='.repeat(70)}\n`);

  const header =
    'WS    '.padEnd(8) +
    '| Accesses '.padEnd(12) +
    '| Rnd Faults'.padEnd(13) +
    '| Rnd Rate '.padEnd(12) +
    '| WS Faults'.padEnd(12) +
    '| WS Rate  '.padEnd(12) +
    '| Winner';
  console.log(header);
  console.log('-'.repeat(83));

  for (const ws of WS_SIZES) {
    const cfg: SimulationConfig = {
      numPhysicalFrames: FRAMES,
      maxConcurrentProcesses: 3,
      processes: [
        { creationTime: 0,  lifetime: 500, virtualPages: 35, workingSetSize: ws, workingSetChangeInterval: 100 },
        { creationTime: 20, lifetime: 500, virtualPages: 35, workingSetSize: ws, workingSetChangeInterval: 100 },
        { creationTime: 50, lifetime: 500, virtualPages: 35, workingSetSize: ws, workingSetChangeInterval: 100 },
      ],
      timeQuantum: 20,
      tau: 180,
      totalAccesses: 1500,
      seed: 42,
      verbose: false,
      writeProbability: 0.3,
      workingSetLocality: 0.9,
    };

    const { random: r, wsclock: w } = new Simulation(cfg).runComparison();
    const total = r.totalAccesses;
    const rRate = ((r.totalPageFaults / total) * 100).toFixed(2) + '%';
    const wRate = ((w.totalPageFaults / total) * 100).toFixed(2) + '%';
    const diff = r.totalPageFaults - w.totalPageFaults;
    const winner =
      diff > 0 ? `WSClock -${((diff / r.totalPageFaults) * 100).toFixed(1)}%`
      : diff < 0 ? `Random -${((-diff / w.totalPageFaults) * 100).toFixed(1)}%`
      : 'Tie';

    console.log(
      String(ws).padEnd(8) +
      `| ${String(total).padEnd(10)}` +
      `| ${String(r.totalPageFaults).padEnd(11)}` +
      `| ${rRate.padEnd(10)}` +
      `| ${String(w.totalPageFaults).padEnd(10)}` +
      `| ${wRate.padEnd(10)}` +
      `| ${winner}`
    );
  }
  console.log(`${'='.repeat(70)}\n`);
}

if (require.main === module) {
  runExperiments();
}
