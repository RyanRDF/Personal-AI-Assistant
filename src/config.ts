import "dotenv/config";
import { z } from "zod";

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1),
  TELEGRAM_ALLOWED_USER_ID: z.coerce.number().int().positive(),
  OPENAI_API_KEY: z.string().trim().min(1),
  OPENAI_CHAT_MODEL: z.string().trim().min(1).default("gpt-4o-mini"),
  OPENAI_CLASSIFIER_MODEL: z.string().trim().min(1).default("gpt-4o-mini"),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(16_384).default(2000),
  ASSISTANT_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(600).default(90),
  TELEGRAM_IMAGE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(20 * 1024 * 1024)
    .default(10 * 1024 * 1024),
  TELEGRAM_PENDING_IMAGE_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  TELEGRAM_PROGRESS_UPDATE_MS: z.coerce.number().int().min(750).max(10_000).default(1200),
  TRACE_ENABLED_DEFAULT: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DATABASE_PATH: z.string().trim().min(1).default("./data/assistant.sqlite"),
  VAULT_STORAGE_PATH: z.string().trim().min(1).default("./data/vault"),
  VAULT_MAX_FILE_BYTES: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(20 * 1024 * 1024),
  MAX_VAULT_CONTEXT_ITEMS: z.coerce.number().int().min(1).max(50).default(12),
  DASHBOARD_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  DASHBOARD_HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3030),
  DASHBOARD_TOKEN: optionalTrimmedString,
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  TIMEZONE: z.string().trim().min(1).default("Asia/Jakarta"),
  MAX_HISTORY_MESSAGES: z.coerce.number().int().min(2).max(50).default(16),
  MAX_MEMORY_ITEMS: z.coerce.number().int().min(1).max(100).default(20),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  GMAIL_CLIENT_ID: optionalTrimmedString,
  GMAIL_CLIENT_SECRET: optionalTrimmedString,
  GMAIL_REDIRECT_URI: z.string().url().default("http://localhost:3000/oauth2callback"),
  GMAIL_REFRESH_TOKEN: optionalTrimmedString,
  GMAIL_POLL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(120),
  GMAIL_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  GMAIL_MAX_BODY_CHARS: z.coerce.number().int().min(500).max(30_000).default(6000),
  EMAIL_MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(3),
  SEARCH_PROVIDER: z.enum(["brave", "searxng"]).default("searxng"),
  BRAVE_SEARCH_API_KEY: optionalTrimmedString,
  SEARXNG_BASE_URL: z.string().url().default("http://localhost:8080"),
  SEARCH_RESULT_LIMIT: z.coerce.number().int().min(1).max(10).default(5),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Konfigurasi environment tidak valid:\n${details}`);
  }
  return result.data;
}

export function isGmailConfigured(config: AppConfig): boolean {
  return Boolean(
    config.GMAIL_CLIENT_ID && config.GMAIL_CLIENT_SECRET && config.GMAIL_REFRESH_TOKEN,
  );
}
