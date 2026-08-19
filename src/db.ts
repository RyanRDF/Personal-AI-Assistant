import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AppLogger } from "./logger.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created
  ON messages(chat_id, id DESC);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'commitment', 'other')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  gmail_query TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_evaluations (
  rule_id INTEGER NOT NULL REFERENCES email_rules(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  matched INTEGER NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rule_id, gmail_message_id)
);

CREATE TABLE IF NOT EXISTS email_processing_failures (
  failure_key TEXT PRIMARY KEY,
  gmail_message_id TEXT NOT NULL,
  rule_id INTEGER,
  stage TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  terminal INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_notifications (
  rule_id INTEGER NOT NULL REFERENCES email_rules(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  message_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rule_id, gmail_message_id)
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_traces (
  request_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_kind TEXT NOT NULL CHECK (input_kind IN ('text', 'image')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'timeout', 'failed')),
  stages_json TEXT NOT NULL DEFAULT '[]',
  tools_json TEXT NOT NULL DEFAULT '[]',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  elapsed_ms INTEGER,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_traces_chat_started
  ON request_traces(chat_id, started_at DESC);
`;

export function openDatabase(databasePath: string, logger?: AppLogger): Database.Database {
  const resolved = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const database = new Database(resolved);
  database.pragma("busy_timeout = 5000");
  database.exec(SCHEMA);
  logger?.info({ databasePath: resolved }, "Database initialized");
  return database;
}

export function getState(database: Database.Database, key: string): string | null {
  const row = database
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(database: Database.Database, key: string, value: string): void {
  database
    .prepare(
      `INSERT INTO app_state(key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

export function recordUsage(
  database: Database.Database,
  purpose: string,
  model: string,
  inputTokens = 0,
  outputTokens = 0,
): void {
  database
    .prepare(
      "INSERT INTO usage_events(purpose, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?)",
    )
    .run(purpose, model, inputTokens, outputTokens);
}
