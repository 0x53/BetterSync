import { watch, type FSWatcher } from "node:fs";
import { Runner, type RunnerOptions } from "@bettersync/core";

/**
 * Keeps a folder in sync (design doc, "Headless client"): core's Runner,
 * told about local changes by native file watching. Writes the watcher
 * misses are caught by the runner's periodic pass.
 */
export interface FolderRunnerOptions extends RunnerOptions {
  folder: string;
}

const IGNORED = /(?:^|[\\/])\./;

export class FolderRunner {
  readonly runner: Runner;
  private watcher: FSWatcher | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly o: FolderRunnerOptions) {
    this.runner = new Runner(o);
  }

  get passes(): number {
    return this.runner.passes;
  }

  start(): void {
    this.watchFolder();
    this.runner.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    this.watcher?.close();
    await this.runner.stop();
  }

  idle(): Promise<void> {
    return this.runner.idle();
  }

  private watchFolder(): void {
    if (this.stopped) return;
    try {
      this.watcher = watch(this.o.folder, { recursive: true }, (_event, name) => {
        // Hidden paths never sync: .bettersync (state and temp files), .obsidian, .trash, .git, ...
        if (name !== null && IGNORED.test(String(name))) return;
        this.runner.localChange();
      });
      this.watcher.on("error", (e) => {
        this.o.log(`file watching failed (${e.message}); relying on the periodic rescan, retrying in 10 s`);
        this.watcher?.close();
        this.retry = setTimeout(() => this.watchFolder(), 10_000);
      });
    } catch (e) {
      this.o.log(`file watching unavailable (${(e as Error).message}); relying on the periodic rescan`);
    }
  }
}
