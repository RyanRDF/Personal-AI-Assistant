import type { EmailClassifier } from "../ai/email-classifier.js";
import type { AppConfig } from "../config.js";
import { getState, setState } from "../db.js";
import { safeErrorMessage, type AppLogger } from "../logger.js";
import type { EmailRuleService } from "./email-rules.js";
import type { GmailService } from "./gmail.js";

const GMAIL_HISTORY_STATE = "gmail_history_id";

export type EmailNotifier = (message: string) => Promise<void>;

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

  constructor(
    private readonly config: AppConfig,
    private readonly database: Parameters<typeof getState>[0],
    private readonly gmail: GmailService,
    private readonly rules: EmailRuleService,
    private readonly classifier: EmailClassifier,
    private readonly notifier: EmailNotifier,
    private readonly logger: AppLogger,
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
    await this.currentRun;
  }

  async runOnce(): Promise<void> {
    if (this.currentRun) {
      this.logger.warn("Skipping overlapping Gmail poll");
      return;
    }
    const run = this.poll();
    this.currentRun = run;
    try {
      await run;
    } finally {
      this.currentRun = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const startHistoryId = getState(this.database, GMAIL_HISTORY_STATE);
      if (!startHistoryId) {
        const current = await this.gmail.getCurrentHistoryId();
        setState(this.database, GMAIL_HISTORY_STATE, current);
        await this.deliverPendingNotifications();
        this.logger.info("Gmail history baseline initialized");
        return;
      }

      let batch;
      try {
        batch = await this.gmail.listNewMessageIds(startHistoryId);
      } catch (error) {
        if (!isExpiredHistory(error)) throw error;
        const current = await this.gmail.getCurrentHistoryId();
        setState(this.database, GMAIL_HISTORY_STATE, current);
        await this.deliverPendingNotifications();
        this.logger.warn("Gmail history cursor expired; baseline reset without replay");
        return;
      }

      let hasTransientFailure = false;
      const activeRules = this.rules.list(true);

      for (const messageId of batch.messageIds) {
        let message;
        const messageFailureKey = `message:${messageId}`;
        try {
          message = await this.gmail.getMessage(messageId);
          this.rules.clearProcessingFailure(messageFailureKey);
        } catch (error) {
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
            const result = await this.classifier.classify(rule, message);
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

      hasTransientFailure ||= await this.deliverPendingNotifications();
      if (!hasTransientFailure) {
        setState(this.database, GMAIL_HISTORY_STATE, batch.latestHistoryId);
      }
    } catch (error) {
      this.logger.error({ errorMessage: safeErrorMessage(error) }, "Gmail poll failed");
    }
  }

  private async deliverPendingNotifications(): Promise<boolean> {
    let hasTransientFailure = false;
    const pending = this.rules.pendingNotifications(this.config.EMAIL_MAX_RETRIES);
    for (const notification of pending) {
      try {
        await this.notifier(notification.messageText);
        this.rules.markNotificationSent(notification.ruleId, notification.gmailMessageId);
      } catch (error) {
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
