import { Buffer } from "node:buffer";
import { Bot, GrammyError, HttpError, type Context } from "grammy";
import type {
  AssistantEvent,
  AssistantImageInput,
  PersonalAssistant,
} from "../ai/assistant.js";
import type { AppConfig } from "../config.js";
import { safeErrorMessage, type AppLogger } from "../logger.js";
import type { ConversationService } from "../services/conversation.js";
import type { EmailRuleService } from "../services/email-rules.js";
import type { MemoryService } from "../services/memory.js";
import {
  formatRequestTrace,
  type RequestTrace,
  type RequestTraceService,
} from "../services/request-trace.js";
import type { WebSearchProvider } from "../services/web-search.js";

const HELP_TEXT = `Asisten personal siap digunakan.

Contoh:
• Kirim gambar dengan caption pertanyaan untuk langsung dianalisis.
• Kirim gambar tanpa caption, lalu kirim pertanyaan pada pesan berikutnya.
• Ingat bahwa saya lebih suka jawaban singkat.
• Kalau ada email tentang invoice proyek Alpha, kabari saya.
• Cari email dari Budi tentang rapat minggu lalu.
• Cari berita terbaru tentang teknologi AI.

Perintah:
/memory — lihat memori tersimpan
/forget <id> — hapus satu memori
/clear_memory CONFIRM — hapus semua memori
/watches — lihat aturan email
/delete_watch <id> — hapus aturan email
/pause_watch <id> — jeda aturan email
/resume_watch <id> — aktifkan aturan email
/clear_chat — hapus riwayat percakapan pendek
/trace on|off — tampilkan atau sembunyikan detail proses
/last_trace — lihat trace permintaan terakhir
/cancel — batalkan permintaan aktif
/status — cek konfigurasi layanan
/help — tampilkan bantuan`;

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

interface PhotoCandidate {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface BotDependencies {
  assistant: PersonalAssistant;
  conversations: ConversationService;
  memories: MemoryService;
  emailRules: EmailRuleService;
  search: WebSearchProvider;
  traces: RequestTraceService;
  gmailConfigured: boolean;
}

interface ActiveRequest {
  requestId: string;
  controller: AbortController;
  timedOut: boolean;
}

interface PendingImage {
  image: AssistantImageInput;
  expiresAt: number;
}

interface PendingImageDownload {
  promise: Promise<AssistantImageInput>;
  controller: AbortController;
  claimed: boolean;
}

interface ProgressController {
  update(text: string, force?: boolean): void;
  finish(text: string): Promise<void>;
}

class ImageInputError extends Error {}

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

function formatByteLimit(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

function imageMimeFromPath(filePath: string): string | null {
  const extension = filePath.split(".").pop()?.toLowerCase();
  const byExtension: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  return extension ? (byExtension[extension] ?? null) : null;
}

export function resolveImageMimeType(
  responseContentType: string | null,
  hintedMimeType: string | undefined,
  filePath: string,
): string | null {
  const responseMime = responseContentType?.split(";", 1)[0]?.trim().toLowerCase();
  const hintedMime = hintedMimeType?.trim().toLowerCase();
  for (const candidate of [responseMime, hintedMime, imageMimeFromPath(filePath)]) {
    if (candidate && SUPPORTED_IMAGE_MIME_TYPES.has(candidate)) return candidate;
  }
  return null;
}

export function selectLargestPhoto<T extends PhotoCandidate>(photos: readonly T[]): T | null {
  return (
    [...photos].sort(
      (left, right) =>
        right.width * right.height - left.width * left.height ||
        (right.file_size ?? 0) - (left.file_size ?? 0),
    )[0] ?? null
  );
}

export function imageBytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function downloadTelegramImage(
  ctx: Context,
  config: AppConfig,
  fileId: string,
  hintedMimeType: string | undefined,
  knownFileSize: number | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<AssistantImageInput> {
  if (knownFileSize && knownFileSize > config.TELEGRAM_IMAGE_MAX_BYTES) {
    throw new ImageInputError(
      `Ukuran gambar melebihi batas ${formatByteLimit(config.TELEGRAM_IMAGE_MAX_BYTES)}.`,
    );
  }
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new ImageInputError("Telegram tidak memberikan lokasi file gambar.");
  if (file.file_size && file.file_size > config.TELEGRAM_IMAGE_MAX_BYTES) {
    throw new ImageInputError(
      `Ukuran gambar melebihi batas ${formatByteLimit(config.TELEGRAM_IMAGE_MAX_BYTES)}.`,
    );
  }

  // Never log this URL because it contains the Telegram bot token.
  const downloadUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetcher(downloadUrl, { signal });
  if (!response.ok) throw new ImageInputError(`Gagal mengunduh gambar (${response.status}).`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > config.TELEGRAM_IMAGE_MAX_BYTES) {
    throw new ImageInputError(
      `Ukuran gambar melebihi batas ${formatByteLimit(config.TELEGRAM_IMAGE_MAX_BYTES)}.`,
    );
  }
  const mimeType = resolveImageMimeType(
    response.headers.get("content-type"),
    hintedMimeType,
    file.file_path,
  );
  if (!mimeType) {
    throw new ImageInputError("Format gambar belum didukung. Gunakan JPEG, PNG, WebP, atau GIF.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > config.TELEGRAM_IMAGE_MAX_BYTES) {
    throw new ImageInputError(
      `Ukuran gambar melebihi batas ${formatByteLimit(config.TELEGRAM_IMAGE_MAX_BYTES)}.`,
    );
  }
  if (bytes.byteLength === 0) throw new ImageInputError("File gambar kosong.");
  return {
    dataUrl: imageBytesToDataUrl(bytes, mimeType),
    mimeType,
    byteLength: bytes.byteLength,
  };
}

function createProgressController(
  ctx: Context,
  messageId: number,
  minimumUpdateMs: number,
  logger: AppLogger,
): ProgressController {
  let closed = false;
  let lastQueuedAt = 0;
  let pendingText: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let editQueue = Promise.resolve();

  const enqueue = (text: string) => {
    lastQueuedAt = Date.now();
    editQueue = editQueue.then(async () => {
      try {
        await ctx.api.editMessageText(ctx.chat!.id, messageId, text);
      } catch (error) {
        const message = safeErrorMessage(error);
        if (!message.includes("message is not modified")) {
          logger.debug({ errorMessage: message }, "Telegram progress edit failed");
        }
      }
    });
  };

  const flush = () => {
    timer = null;
    if (closed || pendingText === null) return;
    const text = pendingText;
    pendingText = null;
    enqueue(text);
  };

  return {
    update(text, force = false) {
      if (closed) return;
      pendingText = text;
      const remainingDelay = Math.max(0, minimumUpdateMs - (Date.now() - lastQueuedAt));
      if (force || remainingDelay === 0) {
        if (timer) clearTimeout(timer);
        timer = null;
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, remainingDelay);
      }
    },
    async finish(text) {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      pendingText = null;
      await editQueue;
      try {
        await ctx.api.editMessageText(ctx.chat!.id, messageId, text);
      } catch (error) {
        const message = safeErrorMessage(error);
        if (!message.includes("message is not modified")) {
          logger.debug({ errorMessage: message }, "Telegram final progress edit failed");
        }
      }
    },
  };
}

function traceProgressText(trace: RequestTrace, label: string): string {
  return `Trace #${trace.requestId.slice(0, 8).toUpperCase()}\n⏳ ${label}`;
}

function partialProgressText(text: string): string {
  const preview = text.trim().slice(0, 700);
  return `✍️ Menyusun jawaban…${preview ? `\n\n${preview}${text.length > 700 ? "…" : ""}` : ""}`;
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error && ["AbortError", "APIUserAbortError"].includes(error.name))
  );
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
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
  const activeRequests = new Map<string, ActiveRequest>();
  const pendingImages = new Map<string, PendingImage>();
  const pendingImageDownloads = new Map<string, PendingImageDownload>();

  function takePendingImage(
    chatId: string,
  ): AssistantImageInput | ((signal: AbortSignal) => Promise<AssistantImageInput>) | null {
    const downloading = pendingImageDownloads.get(chatId);
    if (downloading && !downloading.claimed) {
      downloading.claimed = true;
      return (signal) => awaitWithSignal(downloading.promise, signal);
    }
    const pending = pendingImages.get(chatId);
    if (!pending) return null;
    pendingImages.delete(chatId);
    return pending.expiresAt > Date.now() ? pending.image : null;
  }

  async function replyIfBusy(ctx: Context): Promise<boolean> {
    const chatId = String(ctx.chat!.id);
    const active = activeRequests.get(chatId);
    if (!active) return false;
    await ctx.reply(
      `Masih memproses permintaan #${active.requestId.slice(0, 8).toUpperCase()}. ` +
        "Kirim /cancel untuk membatalkannya.",
    );
    return true;
  }

  async function processAssistantRequest(
    ctx: Context,
    text: string,
    imageSource?: AssistantImageInput | ((signal: AbortSignal) => Promise<AssistantImageInput>),
  ): Promise<void> {
    const chatId = String(ctx.chat!.id);
    const existing = activeRequests.get(chatId);
    if (existing) {
      await ctx.reply(
        `Masih memproses permintaan #${existing.requestId.slice(0, 8).toUpperCase()}. ` +
          "Kirim /cancel untuk membatalkannya.",
      );
      return;
    }
    const inputKind = imageSource ? "image" : "text";
    const trace = dependencies.traces.start(chatId, config.OPENAI_CHAT_MODEL, inputKind);
    const active: ActiveRequest = {
      requestId: trace.requestId,
      controller: new AbortController(),
      timedOut: false,
    };
    activeRequests.set(chatId, active);
    const timeout = setTimeout(() => {
      active.timedOut = true;
      active.controller.abort(new Error("Assistant request timed out"));
    }, config.ASSISTANT_TIMEOUT_SECONDS * 1000);
    const liveTrace = dependencies.traces.isLiveEnabled(chatId);
    let progress: ProgressController | null = null;
    let typingTimer: NodeJS.Timeout | null = null;

    try {
      const initialMessage = await ctx.reply(
        inputKind === "image" ? "📷 Gambar diterima. Menyiapkan analisis…" : "⏳ Memproses permintaan…",
      );
      progress = createProgressController(
        ctx,
        initialMessage.message_id,
        config.TELEGRAM_PROGRESS_UPDATE_MS,
        logger,
      );
      const sendTyping = () => {
        void ctx.replyWithChatAction("typing").catch((error: unknown) =>
          logger.debug({ errorMessage: safeErrorMessage(error) }, "Telegram typing action failed"),
        );
      };
      sendTyping();
      typingTimer = setInterval(sendTyping, 4000);
      dependencies.traces.addStage(trace.requestId, "received", "Permintaan diterima");

      let image: AssistantImageInput | undefined;
      if (typeof imageSource === "function") {
        dependencies.traces.addStage(trace.requestId, "image_download", "Mengunduh gambar Telegram");
        progress.update(
          liveTrace ? traceProgressText(trace, "Mengunduh gambar Telegram") : "📥 Mengunduh gambar…",
          true,
        );
        image = await imageSource(active.controller.signal);
        dependencies.traces.addStage(trace.requestId, "image_ready", "Gambar siap dianalisis");
      } else if (imageSource) {
        image = imageSource;
        dependencies.traces.addStage(trace.requestId, "image_ready", "Gambar sementara siap dianalisis");
      }

      const onEvent = (event: AssistantEvent) => {
        if (event.type === "usage") {
          dependencies.traces.addUsage(trace.requestId, event.inputTokens, event.outputTokens);
          return;
        }
        if (event.type === "tool") {
          dependencies.traces.addTool(trace.requestId, event.name);
          dependencies.traces.addStage(trace.requestId, `tool:${event.name}`, event.label);
          progress?.update(
            liveTrace ? traceProgressText(trace, event.label) : `🔧 ${event.label}…`,
            true,
          );
          return;
        }
        if (event.type === "stage") {
          dependencies.traces.addStage(trace.requestId, event.name, event.label);
          progress?.update(
            liveTrace ? traceProgressText(trace, event.label) : `🧠 ${event.label}…`,
            true,
          );
          return;
        }
        progress?.update(partialProgressText(event.text));
      };

      const answer = await dependencies.assistant.reply(
        chatId,
        image ? { text, images: [image] } : text,
        { signal: active.controller.signal, onEvent },
      );
      dependencies.traces.addStage(trace.requestId, "answer_ready", "Jawaban siap");
      const completedTrace = dependencies.traces.finish(trace.requestId, "completed")!;
      const chunks = splitTelegramMessage(answer);
      if (liveTrace) {
        await progress.finish(`✅ Selesai\n\n${formatRequestTrace(completedTrace)}`);
        for (const chunk of chunks) await ctx.reply(chunk);
      } else {
        await progress.finish(chunks[0] ?? "Selesai.");
        for (const chunk of chunks.slice(1)) await ctx.reply(chunk);
      }
    } catch (error) {
      const aborted = isAbortError(error, active.controller.signal);
      const status = active.timedOut ? "timeout" : aborted ? "cancelled" : "failed";
      const safeMessage = safeErrorMessage(error);
      dependencies.traces.finish(trace.requestId, status, safeMessage);
      if (status === "cancelled") {
        await progress?.finish("⛔ Permintaan dibatalkan.");
      } else if (status === "timeout") {
        await progress?.finish(
          `⌛ Proses melewati batas ${config.ASSISTANT_TIMEOUT_SECONDS} detik. Silakan coba lagi.`,
        );
      } else if (error instanceof ImageInputError) {
        await progress?.finish(`⚠️ ${error.message}`);
      } else {
        logger.error({ errorMessage: safeMessage }, "Assistant response failed");
        await progress?.finish("Maaf, terjadi kesalahan saat memproses permintaan. Coba lagi sebentar.");
      }
    } finally {
      clearTimeout(timeout);
      if (typingTimer) clearInterval(typingTimer);
      if (activeRequests.get(chatId) === active) activeRequests.delete(chatId);
    }
  }

  async function receiveImage(
    ctx: Context,
    fileId: string,
    hintedMimeType: string | undefined,
    knownFileSize: number | undefined,
    caption: string | undefined,
  ): Promise<void> {
    if (await replyIfBusy(ctx)) return;
    const chatId = String(ctx.chat!.id);
    const trimmedCaption = caption?.trim();
    const loader = (signal: AbortSignal) =>
      downloadTelegramImage(
        ctx,
        config,
        fileId,
        hintedMimeType,
        knownFileSize,
        signal,
      );
    if (trimmedCaption) {
      await processAssistantRequest(ctx, trimmedCaption, loader);
      return;
    }

    const downloadController = new AbortController();
    const downloadTimeout = setTimeout(() => {
      downloadController.abort(new Error("Telegram image download timed out"));
    }, 30_000);
    const pendingDownload: PendingImageDownload = {
      promise: loader(downloadController.signal),
      controller: downloadController,
      claimed: false,
    };
    pendingImageDownloads.set(chatId, pendingDownload);
    // The explicit rejection handler prevents an unhandled promise if Telegram cannot
    // create the status message while the file request is already in flight.
    void pendingDownload.promise.catch(() => undefined);
    const statusMessage = await ctx.reply("📥 Mengunduh gambar…").catch((error: unknown) => {
      clearTimeout(downloadTimeout);
      downloadController.abort(new Error("Telegram status message failed"));
      if (pendingImageDownloads.get(chatId) === pendingDownload) {
        pendingImageDownloads.delete(chatId);
      }
      throw error;
    });
    try {
      const image = await pendingDownload.promise;
      if (!pendingDownload.claimed) {
        pendingImages.set(chatId, {
          image,
          expiresAt: Date.now() + config.TELEGRAM_PENDING_IMAGE_SECONDS * 1000,
        });
      }
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMessage.message_id,
        pendingDownload.claimed
          ? "📷 Gambar diterima dan sedang dipakai untuk menjawab pertanyaan Anda."
          : `📷 Gambar diterima. Kirim pertanyaan dalam ${Math.floor(
              config.TELEGRAM_PENDING_IMAGE_SECONDS / 60,
            )} menit. Gambar hanya disimpan sementara di memori.`,
      );
    } catch (error) {
      const message =
        downloadController.signal.aborted
          ? "⛔ Pengunduhan gambar dibatalkan."
          : error instanceof ImageInputError
          ? `⚠️ ${error.message}`
          : "Maaf, gambar gagal diunduh. Silakan kirim ulang.";
      await ctx.api.editMessageText(ctx.chat!.id, statusMessage.message_id, message);
      if (!downloadController.signal.aborted && !(error instanceof ImageInputError)) {
        logger.error({ errorMessage: safeErrorMessage(error) }, "Telegram image download failed");
      }
    } finally {
      clearTimeout(downloadTimeout);
      if (pendingImageDownloads.get(chatId) === pendingDownload) {
        pendingImageDownloads.delete(chatId);
      }
    }
  }

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
    pendingImages.delete(String(ctx.chat.id));
    pendingImageDownloads.get(String(ctx.chat.id))?.controller.abort(
      new Error("Cleared by Telegram owner"),
    );
    pendingImageDownloads.delete(String(ctx.chat.id));
    await ctx.reply(`Riwayat percakapan pendek dihapus (${deleted} pesan). Memori tetap tersimpan.`);
  });

  bot.command("trace", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const mode = (ctx.message?.text ?? "").trim().split(/\s+/)[1]?.toLowerCase();
    if (mode === "on" || mode === "off") {
      dependencies.traces.setLiveEnabled(chatId, mode === "on");
      await ctx.reply(
        mode === "on"
          ? "Trace live aktif. Bot akan menampilkan tahap, tool, durasi, dan token—bukan pemikiran internal mentah."
          : "Trace live dinonaktifkan. Trace teknis tetap tersedia melalui /last_trace.",
      );
      return;
    }
    await ctx.reply(
      `Trace live saat ini ${dependencies.traces.isLiveEnabled(chatId) ? "aktif" : "nonaktif"}.\n` +
        "Gunakan /trace on atau /trace off.",
    );
  });

  bot.command("last_trace", async (ctx) => {
    const trace = dependencies.traces.last(String(ctx.chat.id));
    await ctx.reply(trace ? formatRequestTrace(trace) : "Belum ada trace permintaan.");
  });

  bot.command("cancel", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const active = activeRequests.get(chatId);
    const hadPendingImage = pendingImages.delete(chatId);
    const pendingDownload = pendingImageDownloads.get(chatId);
    pendingDownload?.controller.abort(new Error("Cancelled by Telegram owner"));
    const hadPendingDownload = pendingImageDownloads.delete(chatId);
    if (active) active.controller.abort(new Error("Cancelled by Telegram owner"));
    if (active || hadPendingImage || hadPendingDownload) {
      await ctx.reply(
        active
          ? `Pembatalan dikirim untuk permintaan #${active.requestId.slice(0, 8).toUpperCase()}.`
          : "Gambar sementara sudah dibuang.",
      );
      return;
    }
    await ctx.reply("Tidak ada permintaan aktif atau gambar sementara.");
  });

  bot.command("status", async (ctx) => {
    await ctx.reply(
      [
        "Status layanan:",
        `• Model chat: ${config.OPENAI_CHAT_MODEL}`,
        `• Model klasifikasi email: ${config.OPENAI_CLASSIFIER_MODEL}`,
        `• Token output maksimum: ${config.OPENAI_MAX_OUTPUT_TOKENS}`,
        `• Timeout assistant: ${config.ASSISTANT_TIMEOUT_SECONDS} detik`,
        `• Analisis gambar: aktif (maks. ${formatByteLimit(config.TELEGRAM_IMAGE_MAX_BYTES)})`,
        `• Trace live: ${dependencies.traces.isLiveEnabled(String(ctx.chat.id)) ? "aktif" : "nonaktif"}`,
        `• Gmail: ${dependencies.gmailConfigured ? "terhubung" : "belum dikonfigurasi"}`,
        `• Web search: ${dependencies.search.available ? dependencies.search.name : "belum dikonfigurasi"}`,
        `• Dead-letter email/notifikasi: ${dependencies.emailRules.terminalFailureCount()}`,
        `• Zona waktu: ${config.TIMEZONE}`,
      ].join("\n"),
    );
  });

  bot.on("message:photo", async (ctx) => {
    const photo = selectLargestPhoto(ctx.message.photo);
    if (!photo) {
      await ctx.reply("Foto tidak memiliki versi yang dapat diunduh.");
      return;
    }
    await receiveImage(
      ctx,
      photo.file_id,
      "image/jpeg",
      photo.file_size,
      ctx.message.caption,
    );
  });

  bot.on("message:document", async (ctx) => {
    const document = ctx.message.document;
    if (!document.mime_type?.startsWith("image/")) {
      await ctx.reply("Dokumen ini bukan gambar. Format gambar yang didukung: JPEG, PNG, WebP, GIF.");
      return;
    }
    await receiveImage(
      ctx,
      document.file_id,
      document.mime_type,
      document.file_size,
      ctx.message.caption,
    );
  });

  bot.on("message:text", async (ctx) => {
    if (await replyIfBusy(ctx)) return;
    const pendingImage = takePendingImage(String(ctx.chat.id));
    await processAssistantRequest(ctx, ctx.message.text, pendingImage ?? undefined);
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
