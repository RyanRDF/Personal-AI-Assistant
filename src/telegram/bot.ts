import { Bot, GrammyError, HttpError, type Context } from "grammy";
import type { AppConfig } from "../config.js";
import { safeErrorMessage, type AppLogger } from "../logger.js";
import type { PersonalAssistant } from "../ai/assistant.js";
import type { ConversationService } from "../services/conversation.js";
import type { EmailRuleService } from "../services/email-rules.js";
import type { MemoryService } from "../services/memory.js";
import type { WebSearchProvider } from "../services/web-search.js";

const HELP_TEXT = `Asisten personal siap digunakan.

Contoh:
• Ingat bahwa saya lebih suka jawaban singkat.
• Kalau ada email tentang invoice proyek Alpha, kabari saya.
• Cari email dari Budi tentang rapat minggu lalu.
• Cari berita terbaru tentang teknologi AI.
• Tolong terjemahkan kalimat ini ke bahasa Inggris.

Perintah:
/memory — lihat memori tersimpan
/forget <id> — hapus satu memori
/clear_memory CONFIRM — hapus semua memori
/watches — lihat aturan email
/delete_watch <id> — hapus aturan email
/pause_watch <id> — jeda aturan email
/resume_watch <id> — aktifkan aturan email
/clear_chat — hapus riwayat percakapan pendek
/status — cek konfigurasi layanan
/help — tampilkan bantuan`;

function splitTelegramMessage(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const splitAt = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const end = splitAt > maxLength * 0.6 ? splitAt : maxLength;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function commandId(text: string | undefined): number | null {
  if (!text) return null;
  const raw = text.trim().split(/\s+/)[1];
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

interface BotDependencies {
  assistant: PersonalAssistant;
  conversations: ConversationService;
  memories: MemoryService;
  emailRules: EmailRuleService;
  search: WebSearchProvider;
  gmailConfigured: boolean;
}

export function isOwnerPrivateChat(
  allowedUserId: number,
  fromId: number | undefined,
  chatType: string | undefined,
): boolean {
  return fromId === allowedUserId && chatType === "private";
}

export function createTelegramBot(
  config: AppConfig,
  logger: AppLogger,
  dependencies: BotDependencies,
): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.TELEGRAM_ALLOWED_USER_ID) {
      logger.warn({ telegramUserId: ctx.from?.id }, "Rejected unauthorized Telegram update");
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Tidak diizinkan." });
      return;
    }
    if (!isOwnerPrivateChat(config.TELEGRAM_ALLOWED_USER_ID, ctx.from?.id, ctx.chat?.type)) {
      await ctx.reply("Bot ini dikonfigurasi hanya untuk chat personal pemilik.");
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => ctx.reply(HELP_TEXT));
  bot.command("help", async (ctx) => ctx.reply(HELP_TEXT));

  bot.command("memory", async (ctx) => {
    const memories = dependencies.memories.list(50);
    if (memories.length === 0) {
      await ctx.reply("Belum ada memori personal yang tersimpan.");
      return;
    }
    const text = memories
      .map((memory) => `${memory.id}. [${memory.kind}] ${memory.content}`)
      .join("\n");
    await ctx.reply(`Memori tersimpan:\n${text}`);
  });

  bot.command("forget", async (ctx) => {
    const id = commandId(ctx.message?.text);
    if (!id) {
      await ctx.reply("Format: /forget <id>");
      return;
    }
    await ctx.reply(
      dependencies.memories.delete(id)
        ? `Memori ${id} sudah dihapus.`
        : `Memori ${id} tidak ditemukan.`,
    );
  });

  bot.command("clear_memory", async (ctx) => {
    if (!/^\/clear_memory(?:@\w+)?\s+CONFIRM$/u.test(ctx.message?.text ?? "")) {
      await ctx.reply("Untuk menghapus semua memori, kirim: /clear_memory CONFIRM");
      return;
    }
    const deleted = dependencies.memories.clear();
    await ctx.reply(`Semua memori personal sudah dihapus (${deleted} item).`);
  });

  bot.command("watches", async (ctx) => {
    const rules = dependencies.emailRules.list();
    if (rules.length === 0) {
      await ctx.reply("Belum ada aturan pemantauan email.");
      return;
    }
    const text = rules
      .map(
        (rule) =>
          `${rule.id}. ${rule.enabled ? "aktif" : "jeda"} — ${rule.description}${
            rule.gmailQuery ? `\n   Filter Gmail: ${rule.gmailQuery}` : ""
          }`,
      )
      .join("\n");
    await ctx.reply(`Aturan email:\n${text}`);
  });

  bot.command("delete_watch", async (ctx) => {
    const id = commandId(ctx.message?.text);
    if (!id) {
      await ctx.reply("Format: /delete_watch <id>");
      return;
    }
    await ctx.reply(
      dependencies.emailRules.delete(id)
        ? `Aturan email ${id} sudah dihapus.`
        : `Aturan email ${id} tidak ditemukan.`,
    );
  });

  async function toggleRule(ctx: Context, enabled: boolean): Promise<void> {
    const id = commandId(ctx.message?.text);
    if (!id) {
      await ctx.reply(`Format: /${enabled ? "resume_watch" : "pause_watch"} <id>`);
      return;
    }
    await ctx.reply(
      dependencies.emailRules.setEnabled(id, enabled)
        ? `Aturan ${id} sekarang ${enabled ? "aktif" : "dijeda"}.`
        : `Aturan ${id} tidak ditemukan.`,
    );
  }

  bot.command("pause_watch", async (ctx) => toggleRule(ctx, false));
  bot.command("resume_watch", async (ctx) => toggleRule(ctx, true));

  bot.command("clear_chat", async (ctx) => {
    const deleted = dependencies.conversations.clear(String(ctx.chat.id));
    await ctx.reply(`Riwayat percakapan pendek dihapus (${deleted} pesan). Memori tetap tersimpan.`);
  });

  bot.command("status", async (ctx) => {
    await ctx.reply(
      [
        "Status layanan:",
        `• Model chat: ${config.OPENAI_CHAT_MODEL}`,
        `• Model klasifikasi email: ${config.OPENAI_CLASSIFIER_MODEL}`,
        `• Gmail: ${dependencies.gmailConfigured ? "terhubung" : "belum dikonfigurasi"}`,
        `• Web search: ${dependencies.search.available ? dependencies.search.name : "belum dikonfigurasi"}`,
        `• Dead-letter email/notifikasi: ${dependencies.emailRules.terminalFailureCount()}`,
        `• Zona waktu: ${config.TIMEZONE}`,
      ].join("\n"),
    );
  });

  bot.on("message:text", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    try {
      const answer = await dependencies.assistant.reply(String(ctx.chat.id), ctx.message.text);
      for (const chunk of splitTelegramMessage(answer)) await ctx.reply(chunk);
    } catch (error) {
      logger.error({ errorMessage: safeErrorMessage(error) }, "Assistant response failed");
      await ctx.reply("Maaf, terjadi kesalahan saat memproses permintaan. Coba lagi sebentar.");
    }
  });

  bot.catch((error) => {
    const cause = error.error;
    if (cause instanceof GrammyError) {
      logger.error({ description: cause.description }, "Telegram API error");
    } else if (cause instanceof HttpError) {
      logger.error({ errorMessage: safeErrorMessage(cause) }, "Telegram transport error");
    } else {
      logger.error({ errorMessage: safeErrorMessage(cause) }, "Telegram bot error");
    }
  });

  return bot;
}

export { splitTelegramMessage };
