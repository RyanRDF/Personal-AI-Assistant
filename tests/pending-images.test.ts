import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingImageCoordinator } from "../src/telegram/pending-images.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("pending image coordinator", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a newer image when an older download settles", async () => {
    const coordinator = new PendingImageCoordinator<string>();
    const first = deferred<string>();
    const second = deferred<string>();
    const firstOperation = coordinator.begin("chat", () => first.promise, 30_000, 60_000);
    await Promise.resolve();
    const secondOperation = coordinator.begin("chat", () => second.promise, 30_000, 60_000);

    await expect(firstOperation.promise).rejects.toThrow("Superseded");
    second.resolve("new-image");
    await expect(secondOperation.promise).resolves.toBe("new-image");

    expect(coordinator.take("chat")).toBe("new-image");
  });

  it("lets an older handler clean up only its own token", async () => {
    const coordinator = new PendingImageCoordinator<string>();
    const first = deferred<string>();
    const second = deferred<string>();
    const firstOperation = coordinator.begin("chat", () => first.promise, 30_000, 60_000);
    const secondOperation = coordinator.begin("chat", () => second.promise, 30_000, 60_000);

    expect(firstOperation.cancel(new Error("late busy rejection"))).toBe(false);
    expect(secondOperation.isCurrent()).toBe(true);
    second.resolve("current-image");
    await expect(secondOperation.promise).resolves.toBe("current-image");
    expect(coordinator.take("chat")).toBe("current-image");
  });

  it("aborts an in-flight download when the claimed request is cancelled", async () => {
    const coordinator = new PendingImageCoordinator<string>();
    let downloadSignal: AbortSignal | undefined;
    coordinator.begin(
      "chat",
      (signal) => {
        downloadSignal = signal;
        return new Promise<string>(() => undefined);
      },
      30_000,
      60_000,
    );
    await Promise.resolve();
    const source = coordinator.take("chat");
    expect(typeof source).toBe("function");
    const requestController = new AbortController();
    const loading = (source as (signal: AbortSignal) => Promise<string>)(requestController.signal);

    requestController.abort(new Error("cancelled"));

    await expect(loading).rejects.toThrow("cancelled");
    expect(downloadSignal?.aborted).toBe(true);
    expect(coordinator.has("chat")).toBe(false);
  });

  it("expires downloaded image bytes without requiring another message", async () => {
    vi.useFakeTimers();
    const coordinator = new PendingImageCoordinator<{ bytes: Uint8Array }>();
    const operation = coordinator.begin(
      "chat",
      async () => ({ bytes: Uint8Array.from([1, 2, 3]) }),
      30_000,
      1_000,
    );
    await operation.promise;
    expect(coordinator.has("chat")).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(coordinator.has("chat")).toBe(false);
    expect(coordinator.take("chat")).toBeNull();
  });

  it("enforces its deadline when the loader ignores abort", async () => {
    vi.useFakeTimers();
    const coordinator = new PendingImageCoordinator<string>();
    const loader = deferred<string>();
    const operation = coordinator.begin("chat", () => loader.promise, 1_000, 60_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(operation.promise).rejects.toThrow("timed out");
    expect(coordinator.has("chat")).toBe(false);
    loader.resolve("too-late");
    await vi.runAllTimersAsync();
    expect(coordinator.take("chat")).toBeNull();
  });

  it("does not publish a superseded loader result that settles later", async () => {
    const coordinator = new PendingImageCoordinator<string>();
    const oldLoader = deferred<string>();
    const oldOperation = coordinator.begin("chat", () => oldLoader.promise, 30_000, 60_000);
    const currentOperation = coordinator.begin("chat", async () => "current", 30_000, 60_000);

    expect(oldOperation.canPublish()).toBe(false);
    oldLoader.resolve("stale");
    await expect(oldOperation.promise).rejects.toThrow("Superseded");
    await currentOperation.promise;
    expect(coordinator.take("chat")).toBe("current");
  });
});
