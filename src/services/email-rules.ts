import type Database from "better-sqlite3";
import type { EmailRule } from "../types.js";

interface EmailRuleRow {
  id: number;
  description: string;
  gmail_query: string | null;
  enabled: number;
  created_at: string;
}

export interface PendingEmailNotification {
  ruleId: number;
  gmailMessageId: string;
  messageText: string;
  attempts: number;
}

interface NotificationRow {
  rule_id: number;
  gmail_message_id: string;
  message_text: string;
  attempts: number;
}

export interface ProcessingFailureResult {
  attempts: number;
  terminal: boolean;
}

function mapRow(row: EmailRuleRow): EmailRule {
  return {
    id: row.id,
    description: row.description,
    gmailQuery: row.gmail_query,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export class EmailRuleService {
  constructor(private readonly database: Database.Database) {}

  create(description: string, gmailQuery?: string | null): EmailRule {
    const result = this.database
      .prepare("INSERT INTO email_rules(description, gmail_query) VALUES (?, ?)")
      .run(description.trim(), gmailQuery?.trim() || null);
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): EmailRule | null {
    const row = this.database.prepare("SELECT * FROM email_rules WHERE id = ?").get(id) as
      | EmailRuleRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  list(enabledOnly = false): EmailRule[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM email_rules ${enabledOnly ? "WHERE enabled = 1" : ""}
         ORDER BY id DESC`,
      )
      .all() as EmailRuleRow[];
    return rows.map(mapRow);
  }

  delete(id: number): boolean {
    return this.database.prepare("DELETE FROM email_rules WHERE id = ?").run(id).changes > 0;
  }

  setEnabled(id: number, enabled: boolean): boolean {
    return (
      this.database
        .prepare("UPDATE email_rules SET enabled = ? WHERE id = ?")
        .run(enabled ? 1 : 0, id).changes > 0
    );
  }

  wasEvaluated(ruleId: number, messageId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM email_evaluations WHERE rule_id = ? AND gmail_message_id = ? LIMIT 1",
        )
        .get(ruleId, messageId),
    );
  }

  recordEvaluation(
    ruleId: number,
    messageId: string,
    matched: boolean,
    confidence: number,
    reason: string,
  ): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO email_evaluations
         (rule_id, gmail_message_id, matched, confidence, reason)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ruleId, messageId, matched ? 1 : 0, confidence, reason);
  }

  queueNotification(ruleId: number, messageId: string, messageText: string): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO email_notifications
         (rule_id, gmail_message_id, message_text)
         VALUES (?, ?, ?)`,
      )
      .run(ruleId, messageId, messageText);
  }

  pendingNotifications(maxAttempts: number, limit = 100): PendingEmailNotification[] {
    const rows = this.database
      .prepare(
        `SELECT rule_id, gmail_message_id, message_text, attempts
         FROM email_notifications
         WHERE status = 'pending' AND attempts < ?
         ORDER BY created_at, rule_id, gmail_message_id
         LIMIT ?`,
      )
      .all(maxAttempts, limit) as NotificationRow[];
    return rows.map((row) => ({
      ruleId: row.rule_id,
      gmailMessageId: row.gmail_message_id,
      messageText: row.message_text,
      attempts: row.attempts,
    }));
  }

  markNotificationSent(ruleId: number, messageId: string): void {
    this.database
      .prepare(
        `UPDATE email_notifications
         SET status = 'sent', message_text = '[delivered]', last_error = NULL,
             updated_at = datetime('now')
         WHERE rule_id = ? AND gmail_message_id = ?`,
      )
      .run(ruleId, messageId);
  }

  recordNotificationFailure(
    ruleId: number,
    messageId: string,
    errorMessage: string,
    maxAttempts: number,
  ): ProcessingFailureResult {
    const row = this.database
      .prepare(
        "SELECT attempts FROM email_notifications WHERE rule_id = ? AND gmail_message_id = ?",
      )
      .get(ruleId, messageId) as { attempts: number } | undefined;
    const attempts = (row?.attempts ?? 0) + 1;
    const terminal = attempts >= maxAttempts;
    this.database
      .prepare(
        `UPDATE email_notifications
         SET attempts = ?, status = ?, last_error = ?, updated_at = datetime('now')
         WHERE rule_id = ? AND gmail_message_id = ?`,
      )
      .run(
        attempts,
        terminal ? "dead_letter" : "pending",
        errorMessage.slice(0, 1000),
        ruleId,
        messageId,
      );
    return { attempts, terminal };
  }

  recordProcessingFailure(
    failureKey: string,
    messageId: string,
    ruleId: number | null,
    stage: string,
    errorMessage: string,
    maxAttempts: number,
  ): ProcessingFailureResult {
    const row = this.database
      .prepare("SELECT attempts FROM email_processing_failures WHERE failure_key = ?")
      .get(failureKey) as { attempts: number } | undefined;
    const attempts = (row?.attempts ?? 0) + 1;
    const terminal = attempts >= maxAttempts;
    this.database
      .prepare(
        `INSERT INTO email_processing_failures
         (failure_key, gmail_message_id, rule_id, stage, attempts, terminal, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(failure_key) DO UPDATE SET
           attempts = excluded.attempts,
           terminal = excluded.terminal,
           last_error = excluded.last_error,
           updated_at = datetime('now')`,
      )
      .run(
        failureKey,
        messageId,
        ruleId,
        stage,
        attempts,
        terminal ? 1 : 0,
        errorMessage.slice(0, 1000),
      );
    return { attempts, terminal };
  }

  clearProcessingFailure(failureKey: string): void {
    this.database
      .prepare("DELETE FROM email_processing_failures WHERE failure_key = ?")
      .run(failureKey);
  }

  terminalFailureCount(): number {
    const processing = this.database
      .prepare("SELECT count(*) AS count FROM email_processing_failures WHERE terminal = 1")
      .get() as { count: number };
    const notifications = this.database
      .prepare("SELECT count(*) AS count FROM email_notifications WHERE status = 'dead_letter'")
      .get() as { count: number };
    return processing.count + notifications.count;
  }
}
