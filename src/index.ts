import OpenAI from "openai";
import { run } from "@grammyjs/runner";
import { EmailClassifier } from "./ai/email-classifier.js";
import { PersonalAssistant } from "./ai/assistant.js";
import { DurableAgentRuntime } from "./agent/runtime.js";
import { AgentRunStore } from "./agent/run-store.js";
import { isGmailConfigured, loadConfig } from "./config.js";
import { openDatabase, pruneUsageOlderThan } from "./db.js";
import { createLogger } from "./logger.js";
import { parseMcpConnections } from "./mcp/config.js";
import { McpHttpCapabilityAdapter } from "./mcp/http-adapter.js";
import { McpCatalogStore } from "./mcp/store.js";
import { startDashboard, stopDashboard } from "./dashboard/server.js";
import { ConversationService } from "./services/conversation.js";
import { EmailRuleService } from "./services/email-rules.js";
import { EmailWatcher } from "./services/email-watcher.js";
import { GmailService } from "./services/gmail.js";
import { MemoryService } from "./services/memory.js";
import { createVaultObjectStorage } from "./services/object-storage.js";
import { RequestTraceService } from "./services/request-trace.js";
import { TelegramHistoryService } from "./services/telegram-history.js";
import { openVault } from "./services/vault.js";
import { createSearchProvider } from "./services/web-search.js";
import { createTelegramBot, splitTelegramMessage } from "./telegram/bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const database = openDatabase(config.DATABASE_PATH, logger);
  const runStore = new AgentRunStore(database);
  const recoveredRuns = runStore.recoverInterrupted();
  if (recoveredRuns.length > 0) {
    logger.warn({ recoveredRuns: recoveredRuns.length }, "Interrupted Agent Runs marked failed");
  }
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
  const vault = await openVault(
    database,
    config.VAULT_STORAGE_PATH,
    createVaultObjectStorage(config),
    config.VAULT_STORAGE_BACKEND,
  );
  const traces = new RequestTraceService(database, config.TRACE_ENABLED_DEFAULT);
  traces.pruneOlderThan(config.MESSAGE_RETENTION_DAYS);
  pruneUsageOlderThan(database, config.MESSAGE_RETENTION_DAYS);
  const emailRules = new EmailRuleService(database);
  const search = createSearchProvider(config);
  const gmailConfigured = isGmailConfigured(config);
  const gmail = gmailConfigured ? new GmailService(config) : null;
  const mcpConnections = parseMcpConnections(config.MCP_CONNECTIONS_JSON);
  const mcpCatalog = new McpCatalogStore(database);
  mcpCatalog.syncConnections(mcpConnections);
  const mcpAdapters = mcpConnections.map(
    (connection) =>
      new McpHttpCapabilityAdapter(connection, logger, process.env, undefined, mcpCatalog),
  );

  const assistant = new PersonalAssistant(config, database, logger, {
    conversations,
    memories,
    vault,
    emailRules,
    gmail,
    search,
    capabilityAdapters: mcpAdapters,
  });
  const agentRuntime = new DurableAgentRuntime(
    assistant,
    runStore,
    config.OPENAI_CHAT_MODEL,
  );
  const bot = createTelegramBot(config, logger, {
    assistant: agentRuntime,
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
      async (message, signal) => {
        for (const chunk of splitTelegramMessage(message)) {
          await bot.api.sendMessage(
            config.TELEGRAM_ALLOWED_USER_ID,
            chunk,
            undefined,
            signal as unknown as Parameters<typeof bot.api.sendMessage>[3],
          );
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
    await Promise.allSettled(mcpAdapters.map(async (adapter) => await adapter.close()));
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
