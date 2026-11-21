import { watch as fsWatch } from "node:fs";
import path from "node:path";

/** The part of `fs.FSWatcher` the schema watcher uses. */
export type DirWatcher = {
  close(): void;
  on(event: "error", listener: (err: Error) => void): unknown;
};

/** Same shape as `fs.watch(dir, listener)`; injectable for tests. */
export type WatchFn = (
  dir: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => DirWatcher;

export type WatchFileOptions = {
  /** File to watch (absolute). Its directory is watched, so writes via rename are seen. */
  readonly file: string;
  /** Runs after changes settle; never runs twice at once (a change during a run queues one more). */
  readonly onChange: () => Promise<void> | void;
  /** Quiet period before `onChange` runs (default 100 ms). */
  readonly debounceMs?: number;
  /** Called when the watcher itself fails (for example the directory was removed). */
  readonly onError?: (err: Error) => void;
  readonly watch?: WatchFn;
};

export type FileWatchHandle = {
  /** Stop watching; a pending debounced run is cancelled. */
  close(): void;
};

/**
 * Watch one file by watching its directory (editors often save by writing a temporary file and
 * renaming it over the original, which replaces the inode a file watcher would follow). Events for
 * other files in the directory are ignored; events without a file name (some platforms) count.
 *
 * @param opts - File, callback, debounce and injectable `fs.watch`.
 */
export function watchFile(opts: WatchFileOptions): FileWatchHandle {
  const dir = path.dirname(opts.file);
  const base = path.basename(opts.file);
  const debounceMs = opts.debounceMs ?? 100;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  let closed = false;

  const fire = async (): Promise<void> => {
    timer = undefined;
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await opts.onChange();
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      running = false;
    }
    if (again && !closed) {
      again = false;
      schedule();
    }
  };

  const schedule = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void fire(), debounceMs);
  };

  const watcher = (opts.watch ?? (fsWatch as unknown as WatchFn))(dir, (_event, filename) => {
    if (filename != null && path.basename(filename.toString()) !== base) return;
    schedule();
  });
  watcher.on("error", (err) => opts.onError?.(err));

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      watcher.close();
    },
  };
}

/**
 * Resolve when the process receives SIGINT or SIGTERM (Ctrl+C), then remove the listeners.
 */
export function untilInterrupted(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}
