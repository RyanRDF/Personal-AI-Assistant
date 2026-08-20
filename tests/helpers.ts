import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USER_ID: "123456",
    OPENAI_API_KEY: "test-openai-key",
    LOG_LEVEL: "silent",
    ...overrides,
  });
}

export function temporaryDatabase(): {
  database: Database.Database;
  directory: string;
  cleanup: () => void;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "personal-assistant-test-"));
  const database = openDatabase(path.join(directory, "test.sqlite"));
  return {
    database,
    directory,
    cleanup: () => {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
