import type Database from "better-sqlite3";
import type { ChatRole, StoredMessage } from "../types.js";

interface MessageRow {
  id: number;
  chat_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
}

function mapRow(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

export class ConversationService {
  constructor(private readonly database: Database.Database) {}

  add(chatId: string, role: ChatRole, content: string): StoredMessage {
    const result = this.database
      .prepare("INSERT INTO messages(chat_id, role, content) VALUES (?, ?, ?)")
      .run(chatId, role, content);
    const row = this.database
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(result.lastInsertRowid) as MessageRow;
    return mapRow(row);
  }

  recent(chatId: string, limit: number): StoredMessage[] {
    const rows = this.database
      .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
      .all(chatId, limit) as MessageRow[];
    return rows.reverse().map(mapRow);
  }

  clear(chatId: string): number {
    return this.database.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId).changes;
  }

  pruneOlderThan(days: number): number {
    return this.database
      .prepare("DELETE FROM messages WHERE created_at < datetime('now', ?)")
      .run(`-${days} days`).changes;
  }
}
