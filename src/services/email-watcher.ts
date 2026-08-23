import type { EmailClassifier } from "../ai/email-classifier.js";
import type { AppConfig } from "../config.js";
import { getState, setState } from "../db.js";
import { safeErrorMessage, type AppLogger } from "../logger.js";
import type { EmailRuleService } from "./email-rules.js";
import type { GmailService } from "./gmail.js";

const GMAIL_HISTORY_STATE = "gmail_history_id";
const GMAIL_LAST_SUCCESS_EPOCH_STATE = "gmail_last_success_epoch";
const LEGACY_CATCH_UP_SECONDS = 7 * 24 * 60 * 60;
const NOTIFICATION_TIMEOUT_MS = 30_000;

export type EmailNotifier = (message: string, signal?: AbortSignal) => Promise<void>;

async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Operasi dibatalkan."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isExpiredHistory(error: unknown): boolean {
  const candidate = error as { response?: { status?: number } } | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.response?.status === 404
  );
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function emailNotification(
  from: string,
  subject: string,
  date: string,
  summary: string,
  reason: string,
  confidence: number,
  threadId: string,
  ruleDescription: string,
): string {
  return [
    "📬 Email penting terdeteksi",
    "",
    `Dari: ${truncate(from, 200)}`,
    `Subjek: ${truncate(subject, 300)}`,
    `Tanggal: ${truncate(date, 100)}`,
    `Ringkasan: ${truncate(summary, 1000)}`,
    `Alasan cocok: ${truncate(reason, 500)}`,
    `Keyakinan: ${Math.round(confidence * 100)}%`,
    `Aturan: ${truncate(ruleDescription, 500)}`,
    "",
    `Buka Gmail: https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`,
  ].join("\n");
}

export class EmailWatcher {
  private timer: NodeJS.Timeout | null = null;
  private currentRun: Promise<void> | null = null;
  private currentAbortController: AbortController | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly database: Parameters<typeof getState>[0],
    private readonly gmail: GmailService,
    private readonly rules: EmailRuleService,
    private readonly classifier: EmailClassifier,
    private readonly notifier: EmailNotifier,
    private readonly logger: AppLogger,
    private readonly notificationTimeoutMs = NOTIFICATION_TIMEOUT_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.config.GMAIL_POLL_SECONDS * 1000);
    this.timer.unref();
    this.logger.info(
      { pollSeconds: this.config.GMAIL_POLL_SECONDS },
      "Gmail watcher started",
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    this.currentAbortController?.abort(new Error("Gmail watcher dihentikan."));
    await this.currentRun;
  }

  async runOnce(): Promise<void> {
    if (this.currentRun) {
      this.logger.warn("Skipping overlapping Gmail poll");
      return;
    }
    const controller = new AbortController();
    this.currentAbortController = controller;
    const run = this.poll(controller.signal);
    this.currentRun = run;
    try {
      await run;
    } finally {
      this.currentRun = null;
      if (this.currentAbortController === controller) {
        this.currentAbortController = null;
      }
    }
  }

  private checkpoint(historyId: string, epoch: number): void {
    this.database.transaction(() => {
      setState(this.database, GMAIL_HISTORY_STATE, historyId);
      setState(this.database, GMAIL_LAST_SUCCESS_EPOCH_STATE, String(epoch));
    })();
  }

  private catchUpEpoch(nowEpoch: number): number {
    const stored = getState(this.database, GMAIL_LAST_SUCCESS_EPOCH_STATE);
    if (stored) {
      const epoch = Number(stored);
      if (Number.isSafeInteger(epoch) && epoch > 0 && epoch <= nowEpoch) return epoch;
    }
    return Math.max(0, nowEpoch - LEGACY_CATCH_UP_SECONDS);
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const boundaryEpoch = Math.floor(Date.now() / 1000);
    try {
      const startHistoryId = getState(this.database, GMAIL_HISTORY_STATE);
      if (!startHistoryId) {
        const current = await this.gmail.getCurrentHistoryId({ signal });
        setState(this.database, GMAIL_HISTORY_STATE, current);
        const hasDeliveryFailure = await this.deliverPendingNotifications(signal);
        if (!hasDeliveryFailure) this.checkpoint(current, boundaryEpoch);
        this.logger.info("Gmail history baseline initialized");
        return;
      }

      let batch;
      try {
        batch = await this.gmail.listNewMessageIds(startHistoryId, { signal });
      } catch (error) {
        if (!isExpiredHistory(error)) throw error;
        const catchUpFromEpoch = this.catchUpEpoch(boundaryEpoch);
        const current = await this.gmail.getCurrentHistoryId({ signal });
        const messageIds = await this.gmail.searchMessageIds(
          `after:${catchUpFromEpoch} -in:sent -in:drafts`,
          Number.POSITIVE_INFINITY,
          { signal },
        );
        batch = { messageIds, latestHistoryId: current };
        this.logger.warn(
          { catchUpFromEpoch, messageCount: messageIds.length },
          "Gmail history cursor expired; recovering messages with a bounded catch-up",
        );
      }

      const hasProcessingFailure = await this.processMessages(batch.messageIds, signal);
      const hasDeliveryFailure = await this.deliverPendingNotifications(signal);
      if (!hasProcessingFailure && !hasDeliveryFailure) {
        this.checkpoint(batch.latestHistoryId, boundaryEpoch);
      }
    } catch (error) {
      if (signal.aborted) {
        this.logger.info("Gmail poll cancelled");
        return;
      }
      this.logger.error({ errorMessage: safeErrorMessage(error) }, "Gmail poll failed");
    }
  }

  private async processMessages(
    messageIds: string[],
    signal: AbortSignal,
  ): Promise<boolean> {
    let hasTransientFailure = false;
    const activeRules = this.rules.list(true);

    for (const messageId of messageIds) {
      let message;
      const messageFailureKey = `message:${messageId}`;
      try {
        message = await this.gmail.getMessage(messageId, { signal });
        this.rules.clearProcessingFailure(messageFailureKey);
      } catch (error) {
        if (signal.aborted) throw error;
        const failure = this.rules.recordProcessingFailure(
          messageFailureKey,
          messageId,
          null,
          "gmail_get_message",
          safeErrorMessage(error),
          this.config.EMAIL_MAX_RETRIES,
        );
        hasTransientFailure ||= !failure.terminal;
        this.logger.error(
          {
            gmailMessageId: messageId,
            attempts: failure.attempts,
            terminal: failure.terminal,
            errorMessage: safeErrorMessage(error),
          },
          failure.terminal
            ? "Gmail message moved to dead-letter state"
            : "Gmail message fetch failed; will retry",
        );
        continue;
      }

      for (const rule of activeRules) {
        if (this.rules.wasEvaluated(rule.id, messageId)) continue;
        const classificationFailureKey = `classification:${rule.id}:${messageId}`;
        try {
          const result = await this.classifier.classify(rule, message, signal);
          this.rules.clearProcessingFailure(classificationFailureKey);
          const matched = result.match && result.confidence >= this.config.GMAIL_MATCH_THRESHOLD;
          if (matched) {
            this.rules.queueNotification(
              rule.id,
              messageId,
              emailNotification(
                message.from,
                message.subject,
                message.date,
                result.summary,
                result.reason,
                result.confidence,
                message.threadId,
                rule.description,
              ),
            );
          }
          this.rules.recordEvaluation(
            rule.id,
            messageId,
            matched,
            result.confidence,
            result.reason,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          const failure = this.rules.recordProcessingFailure(
            classificationFailureKey,
            messageId,
            rule.id,
            "semantic_classification",
            safeErrorMessage(error),
            this.config.EMAIL_MAX_RETRIES,
          );
          hasTransientFailure ||= !failure.terminal;
          if (failure.terminal) {
            this.rules.recordEvaluation(
              rule.id,
              messageId,
              false,
              0,
              `Klasifikasi gagal permanen setelah ${failure.attempts} percobaan.`,
            );
          }
          this.logger.error(
            {
              ruleId: rule.id,
              gmailMessageId: messageId,
              attempts: failure.attempts,
              terminal: failure.terminal,
              errorMessage: safeErrorMessage(error),
            },
            failure.terminal
              ? "Email classification moved to dead-letter state"
              : "Email classification failed; will retry",
          );
        }
      }
    }
    return hasTransientFailure;
  }

  private async deliverPendingNotifications(signal: AbortSignal): Promise<boolean> {
    let hasTransientFailure = false;
    const pending = this.rules.pendingNotifications(this.config.EMAIL_MAX_RETRIES);
    for (const notification of pending) {
      signal.throwIfAborted();
      const deliverySignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.notificationTimeoutMs),
      ]);
      try {
        await waitWithSignal(
          Promise.resolve(this.notifier(notification.messageText, deliverySignal)),
          deliverySignal,
        );
        this.rules.markNotificationSent(notification.ruleId, notification.gmailMessageId);
      } catch (error) {
        if (signal.aborted) throw error;
        const failure = this.rules.recordNotificationFailure(
          notification.ruleId,
          notification.gmailMessageId,
          safeErrorMessage(error),
          this.config.EMAIL_MAX_RETRIES,
        );
        hasTransientFailure ||= !failure.terminal;
        this.logger.error(
          {
            ruleId: notification.ruleId,
            gmailMessageId: notification.gmailMessageId,
            attempts: failure.attempts,
            terminal: failure.terminal,
            errorMessage: safeErrorMessage(error),
          },
          failure.terminal
            ? "Telegram notification moved to dead-letter state"
            : "Telegram notification failed; will retry",
        );
      }
    }
    return hasTransientFailure;
  }
}
