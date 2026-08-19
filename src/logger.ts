import pino from "pino";
import type { AppConfig } from "./config.js";

const REDACT_PATHS = [
  "*.token",
  "*.access_token",
  "*.refresh_token",
  "*.authorization",
  "config.OPENAI_API_KEY",
  "config.TELEGRAM_BOT_TOKEN",
  "config.GMAIL_CLIENT_SECRET",
  "config.GMAIL_REFRESH_TOKEN",
];

export function createLogger(config: Pick<AppConfig, "LOG_LEVEL">) {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
  });
}

export type AppLogger = ReturnType<typeof createLogger>;

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1000);
  return "Unknown error";
}
