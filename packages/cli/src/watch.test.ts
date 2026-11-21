import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchFile, type WatchFn } from "./watch.js";

function fakeWatch() {
  let listener: ((event: string, filename: string | null) => void) | undefined;
  const closed = { value: false };
  const watch: WatchFn = (_dir, l) => {
    listener = l;
    return { close: () => void (closed.value = true), on: () => undefined };
  };
  return { watch, emit: (event: string, f: string | null) => listener?.(event, f), closed };
}

describe("watchFile", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces bursts of events (rename + change from one save) into one run", async () => {
    vi.useFakeTimers();
    const w = fakeWatch();
    const onChange = vi.fn();
    const h = watchFile({ file: "/p/schema.cyphra", onChange, debounceMs: 100, watch: w.watch });
    w.emit("rename", "schema.cyphra");
    w.emit("rename", "schema.cyphra");
    await vi.advanceTimersByTimeAsync(50);
    w.emit("change", "schema.cyphra");
    await vi.advanceTimersByTimeAsync(99);
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    h.close();
    expect(w.closed.value).toBe(true);
  });

  it("ignores other files in the directory but counts events without a file name", async () => {
    vi.useFakeTimers();
    const w = fakeWatch();
    const onChange = vi.fn();
    watchFile({ file: "/p/schema.cyphra", onChange, debounceMs: 10, watch: w.watch });
    w.emit("change", "cyphra.gen.ts");
    w.emit("rename", "schema.cyphra.swp");
    await vi.advanceTimersByTimeAsync(20);
    expect(onChange).not.toHaveBeenCalled();
    w.emit("change", null);
    await vi.advanceTimersByTimeAsync(20);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not overlap runs and queues one more for changes made during a run", async () => {
    vi.useFakeTimers();
    const w = fakeWatch();
    let release!: () => void;
    const onChange = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    watchFile({ file: "/p/schema.cyphra", onChange, debounceMs: 10, watch: w.watch });
    w.emit("change", "schema.cyphra");
    await vi.advanceTimersByTimeAsync(10);
    expect(onChange).toHaveBeenCalledTimes(1);
    w.emit("change", "schema.cyphra");
    await vi.advanceTimersByTimeAsync(10);
    expect(onChange).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("keeps watching after a failing run and cancels pending runs on close", async () => {
    vi.useFakeTimers();
    const w = fakeWatch();
    const onError = vi.fn();
    const onChange = vi.fn(() => {
      throw new Error("boom");
    });
    const h = watchFile({
      file: "/p/schema.cyphra",
      onChange,
      onError,
      debounceMs: 10,
      watch: w.watch,
    });
    w.emit("change", "schema.cyphra");
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    w.emit("change", "schema.cyphra");
    await vi.advanceTimersByTimeAsync(10);
    expect(onChange).toHaveBeenCalledTimes(2);
    w.emit("change", "schema.cyphra");
    h.close();
    await vi.advanceTimersByTimeAsync(50);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("sees a save that replaces the file by rename (real fs.watch)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cyphra-watch-"));
    const file = path.join(dir, "schema.cyphra");
    await writeFile(file, "v1");
    const seen: string[] = [];
    const h = watchFile({
      file,
      debounceMs: 50,
      onChange: async () => {
        seen.push(await readFile(file, "utf8"));
      },
    });
    try {
      // Editors such as vim save to a temporary file and rename it over the original.
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(path.join(dir, "schema.cyphra.tmp"), "v2");
      await rename(path.join(dir, "schema.cyphra.tmp"), file);
      await vi.waitFor(() => expect(seen).toContain("v2"), { timeout: 3000, interval: 25 });
      await writeFile(file, "v3");
      await vi.waitFor(() => expect(seen).toContain("v3"), { timeout: 3000, interval: 25 });
    } finally {
      h.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
