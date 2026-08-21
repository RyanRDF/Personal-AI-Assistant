import type Database from "better-sqlite3";

interface TelegramMessageRow {
  message_id: number;
}

export class TelegramHistoryService {
  constructor(private readonly database: Database.Database) {}

  record(chatId: string, messageId: number, sentAt: number): void {
    this.database
      .prepare(
        `INSERT INTO telegram_messages(chat_id, message_id, sent_at)
         VALUES (?, ?, ?)
         ON CONFLICT(chat_id, message_id) DO UPDATE SET sent_at = excluded.sent_at`,
      )
      .run(chatId, messageId, sentAt);
  }

  recentMessageIds(chatId: string, sentAtOrAfter: number): number[] {
    const rows = this.database
      .prepare(
        `SELECT message_id
         FROM telegram_messages
         WHERE chat_id = ? AND sent_at >= ?
         ORDER BY message_id DESC`,
      )
      .all(chatId, sentAtOrAfter) as TelegramMessageRow[];
    return rows.map((row) => row.message_id);
  }

  forget(chatId: string, messageIds: number[]): number {
    if (messageIds.length === 0) return 0;
    const remove = this.database.prepare(
      "DELETE FROM telegram_messages WHERE chat_id = ? AND message_id = ?",
    );
    const transaction = this.database.transaction((ids: number[]) => {
      let deleted = 0;
      for (const messageId of ids) deleted += remove.run(chatId, messageId).changes;
      return deleted;
    });
    return transaction(messageIds);
  }

  pruneBefore(sentBefore: number): number {
    return this.database
      .prepare("DELETE FROM telegram_messages WHERE sent_at < ?")
      .run(sentBefore).changes;
  }
}
