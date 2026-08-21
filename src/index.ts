import OpenAI from "openai";
import { run } from "@grammyjs/runner";
import { EmailClassifier } from "./ai/email-classifier.js";
import { PersonalAssistant } from "./ai/assistant.js";
import { isGmailConfigured, loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createLogger } from "./logger.js";
import { startDashboard, stopDashboard } from "./dashboard/server.js";
import { ConversationService } from "./services/conversation.js";
import { EmailRuleService } from "./services/email-rules.js";
import { EmailWatcher } from "./services/email-watcher.js";
import { GmailService } from "./services/gmail.js";
import { MemoryService } from "./services/memory.js";
import { RequestTraceService } from "./services/request-trace.js";
import { TelegramHistoryService } from "./services/telegram-history.js";
import { VaultService } from "./services/vault.js";
import { createSearchProvider } from "./services/web-search.js";
import { createTelegramBot, splitTelegramMessage } from "./telegram/bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const database = openDatabase(config.DATABASE_PATH, logger);
  const conversations = new ConversationService(database);
  const prunedMessages = conversations.pruneOlderThan(config.MESSAGE_RETENTION_DAYS);
  if (prunedMessages > 0) {
    logger.info({ prunedMessages }, "Expired conversation messages deleted");
  }
  const telegramHistory = new TelegramHistoryService(database);
  const telegramDeleteCutoff = Math.floor(Date.now() / 1000) - 48 * 60 * 60;
  const prunedTelegramMessages = telegramHistory.pruneBefore(telegramDeleteCutoff);
  if (prunedTelegramMessages > 0) {
    logger.info({ prunedTelegramMessages }, "Expired Telegram message references deleted");
  }
  const memories = new MemoryService(database);
  const vault = new VaultService(database, config.VAULT_STORAGE_PATH);
  const traces = new RequestTraceService(database, config.TRACE_ENABLED_DEFAULT);
  traces.pruneOlderThan(config.MESSAGE_RETENTION_DAYS);
  const emailRules = new EmailRuleService(database);
  const search = createSearchProvider(config);
  const gmailConfigured = isGmailConfigured(config);
  const gmail = gmailConfigured ? new GmailService(config) : null;

  const assistant = new PersonalAssistant(config, database, logger, {
    conversations,
    memories,
    vault,
    emailRules,
    gmail,
    search,
  });
  const bot = createTelegramBot(config, logger, {
    assistant,
    conversations,
    memories,
    vault,
    emailRules,
    search,
    traces,
    telegramHistory,
    gmailConfigured,
  });
  await bot.init();
  await bot.api.setMyCommands([
    { command: "start", description: "Mulai dan lihat bantuan" },
    { command: "memory", description: "Lihat memori personal" },
    { command: "vault", description: "Lihat isi vault/rak file" },
    { command: "mkdir", description: "Buat folder vault" },
    { command: "save", description: "Simpan chat atau file yang dibalas" },
    { command: "find", description: "Cari isi vault" },
    { command: "get", description: "Kirim kembali file vault" },
    { command: "rename", description: "Ubah nama item vault" },
    { command: "move", description: "Pindahkan item vault" },
    { command: "delete_item", description: "Hapus item vault" },
    { command: "clear_memory", description: "Hapus semua memori (perlu konfirmasi)" },
    { command: "watches", description: "Lihat aturan email" },
    { command: "status", description: "Cek status layanan" },
    { command: "trace", description: "Atur detail proses: /trace on atau off" },
    { command: "last_trace", description: "Lihat trace permintaan terakhir" },
    { command: "cancel", description: "Batalkan permintaan aktif" },
    { command: "clear_chat", description: "Reset konteks dan hapus chat terbaru" },
    { command: "help", description: "Lihat bantuan" },
  ]);
  const dashboard = await startDashboard(config, { database, vault, logger });

  let watcher: EmailWatcher | null = null;
  if (gmail) {
    const classifierClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
    const classifier = new EmailClassifier(classifierClient, config, database);
    watcher = new EmailWatcher(
      config,
      database,
      gmail,
      emailRules,
      classifier,
      async (message) => {
        for (const chunk of splitTelegramMessage(message)) {
          await bot.api.sendMessage(config.TELEGRAM_ALLOWED_USER_ID, chunk);
        }
      },
      logger,
    );
    watcher.start();
  } else {
    logger.warn("Gmail is not configured; email monitoring is disabled");
  }

  const runner = run(bot, { sink: { concurrency: 4 } });
  logger.info({ username: bot.botInfo.username }, "Telegram bot started");
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    await watcher?.stopAndWait();
    await runner.stop();
    await stopDashboard(dashboard);
    database.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await runner.task();
}

main().catch((error) => {
  // Logger may not be initialized when environment validation fails.
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
