export type PendingImageSource<T> = T | ((signal: AbortSignal) => Promise<T>);

interface PendingImageEntry<T> {
  identity: symbol;
  controller: AbortController;
  promise: Promise<T>;
  claimed: boolean;
  invalidated: boolean;
  value: T | undefined;
  expiryTimer: NodeJS.Timeout | null;
  downloadTimer: NodeJS.Timeout;
}

export interface PendingImageOperation<T> {
  promise: Promise<T>;
  isCurrent(): boolean;
  canPublish(): boolean;
  cancel(reason?: Error): boolean;
  wasClaimed(): boolean;
  wasAborted(): boolean;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted");
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function waitForValue<T>(entry: PendingImageEntry<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    entry.invalidated = true;
    entry.controller.abort(signal.reason);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      entry.invalidated = true;
      entry.controller.abort(signal.reason);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    void entry.promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Keeps at most one pending image per chat and ties all asynchronous cleanup to
 * an entry identity, so an older download can never remove a newer image.
 */
export class PendingImageCoordinator<T> {
  private readonly entries = new Map<string, PendingImageEntry<T>>();

  begin(
    chatId: string,
    loader: (signal: AbortSignal) => Promise<T>,
    downloadTimeoutMs: number,
    readyTtlMs: number,
  ): PendingImageOperation<T> {
    this.cancel(chatId, new Error("Superseded by a newer image"));

    const identity = Symbol(chatId);
    const controller = new AbortController();
    const downloadTimer = setTimeout(() => {
      controller.abort(new Error("Telegram image download timed out"));
    }, downloadTimeoutMs);
    downloadTimer.unref();

    const entry: PendingImageEntry<T> = {
      identity,
      controller,
      claimed: false,
      invalidated: false,
      value: undefined,
      expiryTimer: null,
      downloadTimer,
      promise: Promise.resolve(undefined as T),
    };
    entry.promise = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        // Some Telegram API methods do not cooperate with AbortSignal. Racing the
        // complete loader makes the coordinator deadline authoritative even when
        // getFile or a custom loader never settles after cancellation.
        return raceWithSignal(loader(controller.signal), controller.signal);
      })
      .then(
        (value) => {
          clearTimeout(downloadTimer);
          if (this.isEntryCurrent(chatId, entry)) {
            if (entry.claimed) {
              this.entries.delete(chatId);
            } else {
              entry.value = value;
              entry.expiryTimer = setTimeout(() => {
                if (this.isEntryCurrent(chatId, entry)) this.entries.delete(chatId);
              }, readyTtlMs);
              entry.expiryTimer.unref();
            }
          }
          return value;
        },
        (error: unknown) => {
          clearTimeout(downloadTimer);
          if (this.isEntryCurrent(chatId, entry)) this.entries.delete(chatId);
          throw error;
        },
      );
    // A Telegram status-message failure can happen after the download starts.
    // Keep the rejected download handled until the caller awaits it.
    void entry.promise.catch(() => undefined);
    this.entries.set(chatId, entry);

    return {
      promise: entry.promise,
      isCurrent: () => this.isEntryCurrent(chatId, entry),
      canPublish: () => !entry.invalidated,
      cancel: (reason = new Error("Pending image cancelled")) =>
        this.cancelEntry(chatId, entry, reason),
      wasClaimed: () => entry.claimed,
      wasAborted: () => entry.controller.signal.aborted,
    };
  }

  take(chatId: string): PendingImageSource<T> | null {
    const entry = this.entries.get(chatId);
    if (!entry || entry.claimed) return null;
    entry.claimed = true;
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = null;
    if (entry.value !== undefined) {
      this.entries.delete(chatId);
      return entry.value;
    }
    return async (signal) => {
      try {
        return await waitForValue(entry, signal);
      } finally {
        if (this.isEntryCurrent(chatId, entry)) this.entries.delete(chatId);
      }
    };
  }

  cancel(chatId: string, reason = new Error("Pending image cancelled")): boolean {
    const entry = this.entries.get(chatId);
    if (!entry) return false;
    return this.cancelEntry(chatId, entry, reason);
  }

  private cancelEntry(chatId: string, entry: PendingImageEntry<T>, reason: Error): boolean {
    if (!this.isEntryCurrent(chatId, entry)) return false;
    this.entries.delete(chatId);
    clearTimeout(entry.downloadTimer);
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.invalidated = true;
    entry.value = undefined;
    entry.controller.abort(reason);
    return true;
  }

  has(chatId: string): boolean {
    return this.entries.has(chatId);
  }

  private isEntryCurrent(chatId: string, entry: PendingImageEntry<T>): boolean {
    return this.entries.get(chatId)?.identity === entry.identity;
  }
}
