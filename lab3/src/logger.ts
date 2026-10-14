/**
 * Simulation event logger.
 * Supports verbose mode for detailed execution traces and concise mode for summary reports.
 */
export class Logger {
  public verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  info(message: string): void {
    console.log(message);
  }

  debug(message: string): void {
    if (this.verbose) {
      console.log(`  [DEBUG] ${message}`);
    }
  }

  event(message: string): void {
    if (this.verbose) {
      console.log(`[EVENT] ${message}`);
    }
  }

  warn(message: string): void {
    console.warn(`[WARN] ${message}`);
  }

  error(message: string): void {
    console.error(`[ERROR] ${message}`);
  }
}
