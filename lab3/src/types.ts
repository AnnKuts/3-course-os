/**
 * Configuration and type definitions for virtual memory simulation.
 */

export enum AccessType {
  READ = 'READ',
  WRITE = 'WRITE',
}

export interface MemoryAccess {
  pid: number;
  virtualPage: number;
  type: AccessType;
}

export interface ProcessConfig {
  /** Process creation time (in simulation memory accesses) */
  creationTime: number;
  /** Process execution lifetime (number of memory accesses by this process) */
  lifetime: number;
  /** Virtual address space size (number of virtual pages) */
  virtualPages: number;
  /** Working set size (number of virtual pages in active set) */
  workingSetSize: number;
  /** Working set change interval (in memory accesses by this process) */
  workingSetChangeInterval: number;
}

export interface SimulationConfig {
  /** Number of physical page frames */
  numPhysicalFrames: number;
  /** Maximum number of concurrent active processes */
  maxConcurrentProcesses: number;
  /** Process configuration templates or instances */
  processes: ProcessConfig[];
  /** CPU scheduling quantum (in memory accesses) */
  timeQuantum: number;
  /** WSClock TAU parameter (in memory accesses) */
  tau: number;
  /** Total simulation memory accesses limit */
  totalAccesses: number;
  /** Random seed for reproducible workload */
  seed: number;
  /** Enable verbose console logging */
  verbose: boolean;
  /** Write access probability (e.g. 0.3 for 30% writes) */
  writeProbability: number;
  /** Locality probability (e.g. 0.9 for 90% accesses to working set) */
  workingSetLocality: number;
}

export interface ProcessStats {
  pid: number;
  totalAccesses: number;
  pageFaults: number;
  pagesAllocated: number;
}

export interface SimulationStats {
  algorithmName: string;
  config: SimulationConfig;
  totalAccesses: number;
  totalPageFaults: number;
  totalEvictions: number;
  dirtyWriteBacks: number;
  firstTimeLoads: number;
  backingStoreReloads: number;
  perProcessStats: Map<number, ProcessStats>;
}

export type ReplacementAlgorithm = 'random' | 'wsclock';
