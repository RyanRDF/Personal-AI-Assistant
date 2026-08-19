import OpenAI from "openai";
import { EmailClassifier } from "./ai/email-classifier.js";
import { PersonalAssistant } from "./ai/assistant.js";
import { isGmailConfigured, loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createLogger } from "./logger.js";
import { ConversationService } from "./services/conversation.js";
import { EmailRuleService } from "./services/email-rules.js";
import { EmailWatcher } from "./services/email-watcher.js";
import { GmailService } from "./services/gmail.js";
import { MemoryService } from "./services/memory.js";
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
  const memories = new MemoryService(database);
  const emailRules = new EmailRuleService(database);
  const search = createSearchProvider(config);
  const gmailConfigured = isGmailConfigured(config);
  const gmail = gmailConfigured ? new GmailService(config) : null;

  const assistant = new PersonalAssistant(config, database, logger, {
    conversations,
    memories,
    emailRules,
    gmail,
    search,
  });
  const bot = createTelegramBot(config, logger, {
    assistant,
    conversations,
    memories,
    emailRules,
    search,
    gmailConfigured,
  });

  await bot.api.setMyCommands([
    { command: "start", description: "Mulai dan lihat bantuan" },
    { command: "memory", description: "Lihat memori personal" },
    { command: "clear_memory", description: "Hapus semua memori (perlu konfirmasi)" },
    { command: "watches", description: "Lihat aturan email" },
    { command: "status", description: "Cek status layanan" },
    { command: "clear_chat", description: "Hapus riwayat percakapan pendek" },
    { command: "help", description: "Lihat bantuan" },
  ]);

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

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await watcher?.stopAndWait();
    await bot.stop();
    database.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.start({
    onStart: (botInfo) => logger.info({ username: botInfo.username }, "Telegram bot started"),
  });
}

main().catch((error) => {
  // Logger may not be initialized when environment validation fails.
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
