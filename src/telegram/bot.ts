import { Buffer } from "node:buffer";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
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
  DuplicateVaultItemError,
  InvalidVaultOperationError,
  type VaultService,
} from "../services/vault.js";
import {
  formatRequestTrace,
  type RequestTrace,
  type RequestTraceService,
} from "../services/request-trace.js";
import type { TelegramHistoryService } from "../services/telegram-history.js";
import type { WebSearchProvider } from "../services/web-search.js";
import {
  analyzeAttachment,
  readResponseBytesBounded,
  validateAttachment,
  type IncomingAttachment,
} from "../services/attachments.js";
import {
  PendingImageCoordinator,
  type PendingImageSource,
} from "./pending-images.js";

const HELP_TEXT = `Asisten personal siap digunakan.

Contoh:
• Kirim foto, video, audio, atau dokumen untuk disimpan dan dianalisis sesuai formatnya.
• Kirim gambar tanpa caption, lalu kirim pertanyaan pada pesan berikutnya.
• Ingat bahwa saya lebih suka jawaban singkat.
• Kalau ada email tentang invoice proyek Alpha, kabari saya.
• Cari email dari Budi tentang rapat minggu lalu.
• Cari berita terbaru tentang teknologi AI.
• Forward file atau chat penting untuk langsung menyimpannya ke vault.
• Minta "carikan lalu kirim file invoice dari vault" dengan bahasa biasa.

Perintah:
/memory — lihat memori tersimpan
/vault [folder] — lihat isi vault
/mkdir <folder/subfolder> — buat folder
/save — simpan pesan yang dibalas; pada file gunakan caption /save [folder]
/find <kata> — cari catatan dan file
/get <id> — kirim kembali file
/rename <id> <nama baru> — ubah nama item
/move <id> <folder|/> — pindahkan item
/delete_item <id> CONFIRM — hapus item/folder
/forget <id> — hapus satu memori
/clear_memory CONFIRM — hapus semua memori
/watches — lihat aturan email
/delete_watch <id> — hapus aturan email
/pause_watch <id> — jeda aturan email
/resume_watch <id> — aktifkan aturan email
/clear_chat CONFIRM — reset konteks dan hapus pesan Telegram terbaru
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
  vault: VaultService;
  emailRules: EmailRuleService;
  search: WebSearchProvider;
  traces: RequestTraceService;
  telegramHistory: TelegramHistoryService;
  gmailConfigured: boolean;
}

interface ActiveRequest {
  requestId: string;
  controller: AbortController;
  timedOut: boolean;
  finished: Promise<void>;
  resolveFinished: () => void;
}

interface ProgressController {
  update(text: string, force?: boolean): void;
  finish(text: string, allowAfterAbort?: boolean): Promise<void>;
}

interface PreparedAssistantInput {
  images?: AssistantImageInput[];
  attachmentContext?: Record<string, unknown>;
  footer?: string;
}

interface ForwardedTextPart {
  ctx: Context;
  text: string;
  messageId: number;
}

interface ForwardedTextBatch {
  parts: ForwardedTextPart[];
  characterCount: number;
  timer: NodeJS.Timeout;
}

type AssistantInputSource =
  | AssistantImageInput
  | PreparedAssistantInput
  | ((signal: AbortSignal) => Promise<AssistantImageInput | PreparedAssistantInput>);

interface TelegramCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  canPublish?: () => boolean;
}

type GrammyAbortSignal = NonNullable<Parameters<Context["reply"]>[2]>;

function asGrammySignal(signal: AbortSignal): GrammyAbortSignal {
  // grammY currently exposes the abort-controller package's structural type,
  // while Node supplies the runtime-compatible native AbortSignal.
  return signal as unknown as GrammyAbortSignal;
}

const TELEGRAM_API_TIMEOUT_MS = 10_000;
const TELEGRAM_TERMINAL_API_TIMEOUT_MS = 5_000;
const FORWARDED_TEXT_BATCH_DELAY_MS = 800;
const FORWARDED_TEXT_BATCH_MAX_CHARS = 48_000;

class TelegramCallAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramCallAbortedError";
  }
}

class ImageInputError extends Error {}

interface TelegramMessageReference {
  chatId: string;
  messageId: number;
  sentAt: number;
}

const TELEGRAM_DELETE_WINDOW_SECONDS = 48 * 60 * 60;
const TELEGRAM_DELETE_BATCH_SIZE = 100;

function telegramMessageReferences(result: unknown): TelegramMessageReference[] {
  const values = Array.isArray(result) ? result : [result];
  const references: TelegramMessageReference[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    const chat = message.chat;
    if (!chat || typeof chat !== "object") continue;
    const chatId = (chat as Record<string, unknown>).id;
    if (
      typeof chatId === "number" &&
      typeof message.message_id === "number" &&
      typeof message.date === "number"
    ) {
      references.push({
        chatId: String(chatId),
        messageId: message.message_id,
        sentAt: message.date,
      });
    }
  }
  return references;
}

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

export async function replyInTelegramChunks(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitTelegramMessage(text)) await ctx.reply(chunk);
}

function callAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new TelegramCallAbortedError("Telegram call aborted");
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(callAbortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(callAbortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function awaitTelegramCall<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: TelegramCallOptions = {},
): Promise<T> {
  const canPublish = options.canPublish ?? (() => true);
  if (!canPublish()) throw new TelegramCallAbortedError("Telegram publication is stale");
  if (options.signal?.aborted) throw callAbortReason(options.signal);

  const timeoutMs = options.timeoutMs ?? TELEGRAM_API_TIMEOUT_MS;
  const callController = new AbortController();
  const forwardAbort = () => callController.abort(callAbortReason(options.signal!));
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () => callController.abort(new TelegramCallAbortedError("Telegram call timed out")),
    timeoutMs,
  );
  timer.unref();

  let promise: Promise<T>;
  try {
    promise = operation(callController.signal);
  } catch (error) {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
    throw error;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", forwardAbort);
      callController.signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(callAbortReason(callController.signal)));
    callController.signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => finish(() => (canPublish() ? resolve(value) : reject(new TelegramCallAbortedError("Telegram publication is stale")))),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export async function editMessageOrReply(
  ctx: Context,
  messageId: number,
  text: string,
  logger: AppLogger,
  options: TelegramCallOptions = {},
): Promise<void> {
  try {
    await awaitTelegramCall(
      (signal) =>
        ctx.api.editMessageText(ctx.chat!.id, messageId, text, {}, asGrammySignal(signal)),
      options,
    );
  } catch (error) {
    if (error instanceof TelegramCallAbortedError || options.signal?.aborted) throw error;
    const message = safeErrorMessage(error);
    if (message.includes("message is not modified")) return;
    logger.debug({ errorMessage: message }, "Telegram message edit failed; replying instead");
    await awaitTelegramCall(
      (signal) => ctx.reply(text, {}, asGrammySignal(signal)),
      options,
    );
  }
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function commandArguments(text: string | undefined): string {
  return (text ?? "").replace(/^\/\w+(?:@\w+)?\s*/u, "").trim();
}

function generatedNoteName(text: string, messageId: number): string {
  const firstLine = text.replace(/\s+/gu, " ").trim().slice(0, 72);
  return firstLine || `Catatan Telegram ${messageId}`;
}

function generatedPhotoName(messageId: number): string {
  return `Foto Telegram ${messageId}.jpg`;
}

async function downloadTelegramFile(
  ctx: Context,
  config: AppConfig,
  fileId: string,
  knownFileSize: number | undefined,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  if (knownFileSize && knownFileSize > config.VAULT_MAX_FILE_BYTES) {
    throw new InvalidVaultOperationError(
      `Ukuran file melebihi batas vault ${formatByteLimit(config.VAULT_MAX_FILE_BYTES)}.`,
    );
  }
  const file = await ctx.api.getFile(fileId, signal ? asGrammySignal(signal) : undefined);
  if (!file.file_path) throw new InvalidVaultOperationError("Lokasi file Telegram tidak tersedia.");
  if (file.file_size && file.file_size > config.VAULT_MAX_FILE_BYTES) {
    throw new InvalidVaultOperationError(
      `Ukuran file melebihi batas vault ${formatByteLimit(config.VAULT_MAX_FILE_BYTES)}.`,
    );
  }
  // Do not log this URL because it contains the bot token.
  const response = await fetcher(
    `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
    signal ? { signal } : undefined,
  );
  if (!response.ok) throw new InvalidVaultOperationError(`Gagal mengunduh file (${response.status}).`);
  return readResponseBytesBounded(response, config.VAULT_MAX_FILE_BYTES);
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
  const file = await ctx.api.getFile(fileId, asGrammySignal(signal));
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
  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytesBounded(response, config.TELEGRAM_IMAGE_MAX_BYTES);
  } catch (error) {
    throw new ImageInputError(error instanceof Error ? error.message : "Gambar terlalu besar.");
  }
  if (bytes.byteLength === 0) throw new ImageInputError("File gambar kosong.");
  return {
    dataUrl: imageBytesToDataUrl(bytes, mimeType),
    mimeType,
    byteLength: bytes.byteLength,
  };
}

export function createProgressController(
  ctx: Context,
  messageId: number,
  minimumUpdateMs: number,
  logger: AppLogger,
  options: TelegramCallOptions = {},
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
        await awaitTelegramCall(
          (signal) =>
            ctx.api.editMessageText(ctx.chat!.id, messageId, text, {}, asGrammySignal(signal)),
          options,
        );
      } catch (error) {
        if (error instanceof TelegramCallAbortedError || options.signal?.aborted) return;
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
    async finish(text, allowAfterAbort = false) {
      if (closed && !allowAfterAbort) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      pendingText = null;
      await editQueue;
      const finishOptions: TelegramCallOptions = allowAfterAbort
        ? {
            timeoutMs: TELEGRAM_TERMINAL_API_TIMEOUT_MS,
            ...(options.canPublish ? { canPublish: options.canPublish } : {}),
          }
        : options;
      await editMessageOrReply(ctx, messageId, text, logger, finishOptions);
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
  const pendingImages = new PendingImageCoordinator<PreparedAssistantInput>();
  const queuedAssistantWork = new Map<string, Promise<void>>();
  const forwardedTextBatches = new Map<string, ForwardedTextBatch>();

  bot.api.config.use(async (previous, method, payload, signal) => {
    const response = await previous(method, payload, signal);
    if (response.ok) {
      try {
        for (const reference of telegramMessageReferences(response.result)) {
          dependencies.telegramHistory.record(
            reference.chatId,
            reference.messageId,
            reference.sentAt,
          );
        }
      } catch (error) {
        logger.error(
          { errorMessage: safeErrorMessage(error) },
          "Telegram outgoing message tracking failed",
        );
      }
    }
    return response;
  });

  function takePendingImage(
    chatId: string,
  ): PendingImageSource<PreparedAssistantInput> | null {
    return pendingImages.take(chatId);
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

  function scheduleAssistantWork(chatId: string, work: () => Promise<void>): void {
    const previous = queuedAssistantWork.get(chatId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const active = activeRequests.get(chatId);
        if (active) await active.finished;
        await work();
      });
    let tracked: Promise<void>;
    tracked = run.finally(() => {
      if (queuedAssistantWork.get(chatId) === tracked) queuedAssistantWork.delete(chatId);
    });
    queuedAssistantWork.set(chatId, tracked);
    void tracked.catch((error: unknown) => {
      logger.error(
        { chatId, errorMessage: safeErrorMessage(error) },
        "Queued Telegram assistant work failed",
      );
    });
  }

  function forwardedBatchContent(parts: ForwardedTextPart[]): string {
    return parts
      .map((part, index) => `[Pesan diteruskan ${index + 1}]\n${part.text}`)
      .join("\n\n");
  }

  function flushForwardedTextBatch(chatId: string): void {
    const batch = forwardedTextBatches.get(chatId);
    if (!batch) return;
    clearTimeout(batch.timer);
    forwardedTextBatches.delete(chatId);
    const first = batch.parts[0]!;
    const latest = batch.parts.at(-1)!;
    scheduleAssistantWork(chatId, async () => {
      const content = forwardedBatchContent(batch.parts);
      const defaultName = generatedNoteName(first.text, first.messageId);
      let footer: string;
      try {
        const noteName = dependencies.vault.findDuplicateName(defaultName, null)
          ? `${defaultName} (Telegram ${first.messageId})`
          : defaultName;
        const item = dependencies.vault.saveNote(noteName, content, null, {
          chatId,
          messageId: String(first.messageId),
        });
        footer = `✅ ${batch.parts.length} chat diteruskan disimpan sebagai ${dependencies.vault.pathFor(item.id)} (#${item.id}).`;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Chat gagal disimpan.";
        footer = `⚠️ Chat diteruskan tetap dianalisis, tetapi gagal disimpan: ${message}`;
      }
      await processAssistantRequest(
        latest.ctx,
        `Ringkas dan analisis ${batch.parts.length} chat yang diteruskan berikut. Pertahankan angka, tanggal, keputusan, dan koreksi penting.\n${content}`,
        { footer },
      );
    });
  }

  function enqueueForwardedText(ctx: Context): void {
    const chatId = String(ctx.chat!.id);
    const text = ctx.message?.text?.trim();
    if (!text || !ctx.message) return;
    const addedCharacters = text.length + 32;
    let batch = forwardedTextBatches.get(chatId);
    if (
      batch &&
      batch.parts.length > 0 &&
      batch.characterCount + addedCharacters > FORWARDED_TEXT_BATCH_MAX_CHARS
    ) {
      flushForwardedTextBatch(chatId);
      batch = undefined;
    }
    if (!batch) {
      const timer = setTimeout(() => flushForwardedTextBatch(chatId), FORWARDED_TEXT_BATCH_DELAY_MS);
      timer.unref();
      batch = { parts: [], characterCount: 0, timer };
      forwardedTextBatches.set(chatId, batch);
    } else {
      clearTimeout(batch.timer);
      batch.timer = setTimeout(
        () => flushForwardedTextBatch(chatId),
        FORWARDED_TEXT_BATCH_DELAY_MS,
      );
      batch.timer.unref();
    }
    batch.parts.push({ ctx, text, messageId: ctx.message.message_id });
    batch.characterCount += addedCharacters;
  }

  async function sendVaultFile(
    ctx: Context,
    itemId: number,
    callOptions: TelegramCallOptions = {},
  ): Promise<void> {
    const item = dependencies.vault.get(itemId);
    if (!item || item.kind !== "file") {
      await awaitTelegramCall(
        (signal) =>
          ctx.reply(`File vault ${itemId} tidak ditemukan.`, {}, asGrammySignal(signal)),
        callOptions,
      );
      return;
    }
    const inputFile =
      item.storageBackend === "s3"
        ? new InputFile(await dependencies.vault.fileBytes(item.id, callOptions.signal), item.name)
        : new InputFile(dependencies.vault.filePath(item.id), item.name);
    await awaitTelegramCall(
      (signal) =>
        ctx.replyWithDocument(inputFile, {
          caption: `📎 ${dependencies.vault.pathFor(item.id)} · ${formatBytes(item.sizeBytes)}`,
        }, asGrammySignal(signal)),
      callOptions,
    );
  }

  async function saveTelegramFile(
    ctx: Context,
    input: {
      fileId: string;
      fileUniqueId: string;
      kind: IncomingAttachment["kind"];
      fileName: string;
      mimeType?: string;
      fileSize?: number;
      folderPath?: string;
      durationSeconds?: number;
    },
  ): Promise<void> {
    const status = await awaitTelegramCall((signal) =>
      ctx.reply("📥 Menyimpan file ke vault…", {}, asGrammySignal(signal)),
    );
    let acknowledgement: string;
    try {
      const parent = input.folderPath
        ? dependencies.vault.ensureFolderPath(input.folderPath)
        : null;
      const bytes = await downloadTelegramFile(
        ctx,
        config,
        input.fileId,
        input.fileSize,
      );
      const validated = await validateAttachment({
        kind: input.kind,
        fileId: input.fileId,
        fileUniqueId: input.fileUniqueId,
        fileName: input.fileName,
        ...(input.mimeType ? { claimedMimeType: input.mimeType } : {}),
        ...(input.fileSize ? { fileSize: input.fileSize } : {}),
        ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
      }, bytes);
      const item = await dependencies.vault.saveFileObject({
        name: validated.attachment.fileName,
        mimeType: validated.detectedMimeType,
        detectedMimeType: validated.detectedMimeType,
        mediaKind: validated.attachment.kind,
        fileUniqueId: validated.attachment.fileUniqueId,
        bytes: validated.bytes,
        parentId: parent?.id ?? null,
        chatId: String(ctx.chat!.id),
        messageId: String(ctx.message?.message_id ?? ""),
      });
      acknowledgement = `✅ File disimpan: ${dependencies.vault.pathFor(item.id)} (#${item.id}, ${formatBytes(item.sizeBytes)})`;
    } catch (error) {
      const message =
        error instanceof DuplicateVaultItemError
          ? `Nama duplikat: ${error.existing.name} sudah ada sebagai #${error.existing.id}. Ubah nama item lama lewat /rename atau simpan ke folder lain.`
          : error instanceof Error
            ? error.message
            : "File gagal disimpan.";
      acknowledgement = `⚠️ ${message}`;
    }
    try {
      await editMessageOrReply(ctx, status.message_id, acknowledgement, logger);
    } catch (error) {
      logger.warn(
        { errorMessage: safeErrorMessage(error) },
        "Telegram file-save acknowledgement failed",
      );
    }
  }

  async function processAssistantRequest(
    ctx: Context,
    text: string,
    inputSource?: AssistantInputSource,
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
    const inputKind =
      inputSource &&
      (typeof inputSource === "function" ||
        "dataUrl" in inputSource ||
        Boolean(inputSource.images?.length || inputSource.attachmentContext))
        ? "image"
        : "text";
    const trace = dependencies.traces.start(chatId, config.OPENAI_CHAT_MODEL, inputKind);
    let resolveFinished: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const active: ActiveRequest = {
      requestId: trace.requestId,
      controller: new AbortController(),
      timedOut: false,
      finished,
      resolveFinished,
    };
    activeRequests.set(chatId, active);
    const timeoutSeconds =
      inputKind === "image"
        ? Math.max(config.ASSISTANT_TIMEOUT_SECONDS, config.ATTACHMENT_PROCESSING_TIMEOUT_SECONDS)
        : config.ASSISTANT_TIMEOUT_SECONDS;
    const timeout = setTimeout(() => {
      active.timedOut = true;
      active.controller.abort(new Error("Assistant request timed out"));
    }, timeoutSeconds * 1000);
    const liveTrace = dependencies.traces.isLiveEnabled(chatId);
    let progress: ProgressController | null = null;
    let typingTimer: NodeJS.Timeout | null = null;
    const requestedFileIds = new Set<number>();
    const activeCallOptions: TelegramCallOptions = {
      signal: active.controller.signal,
      canPublish: () => activeRequests.get(chatId) === active,
    };

    try {
      const initialMessage = await awaitTelegramCall(
        (signal) =>
          ctx.reply(
            inputKind === "image"
              ? "📎 Attachment diterima. Menyiapkan analisis…"
              : "⏳ Memproses permintaan…",
            {},
            asGrammySignal(signal),
          ),
        activeCallOptions,
      );
      progress = createProgressController(
        ctx,
        initialMessage.message_id,
        config.TELEGRAM_PROGRESS_UPDATE_MS,
        logger,
        activeCallOptions,
      );
      const sendTyping = () => {
        void awaitTelegramCall(
          (signal) => ctx.replyWithChatAction("typing", {}, asGrammySignal(signal)),
          activeCallOptions,
        ).catch(
          (error: unknown) => {
            if (!active.controller.signal.aborted) {
              logger.debug(
                { errorMessage: safeErrorMessage(error) },
                "Telegram typing action failed",
              );
            }
          },
        );
      };
      sendTyping();
      typingTimer = setInterval(sendTyping, 4000);
      dependencies.traces.addStage(trace.requestId, "received", "Permintaan diterima");

      let prepared: PreparedAssistantInput = {};
      if (typeof inputSource === "function") {
        dependencies.traces.addStage(trace.requestId, "attachment_download", "Mengunduh attachment Telegram");
        progress.update(
          liveTrace ? traceProgressText(trace, "Mengunduh attachment Telegram") : "📥 Mengunduh attachment…",
          true,
        );
        const loaded = await awaitWithSignal(
          inputSource(active.controller.signal),
          active.controller.signal,
        );
        prepared = "dataUrl" in loaded ? { images: [loaded] } : loaded;
        dependencies.traces.addStage(trace.requestId, "attachment_ready", "Attachment siap dianalisis");
      } else if (inputSource) {
        prepared = "dataUrl" in inputSource ? { images: [inputSource] } : inputSource;
        dependencies.traces.addStage(trace.requestId, "attachment_ready", "Attachment sementara siap dianalisis");
      }

      const onEvent = (event: AssistantEvent) => {
        if (event.type === "file") {
          requestedFileIds.add(event.itemId);
          return;
        }
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
        prepared.images?.length || prepared.attachmentContext
          ? {
              text,
              ...(prepared.images?.length ? { images: prepared.images } : {}),
              ...(prepared.attachmentContext ? { attachmentContext: prepared.attachmentContext } : {}),
            }
          : text,
        { signal: active.controller.signal, onEvent },
      );
      dependencies.traces.addStage(trace.requestId, "answer_ready", "Jawaban siap");
      const completedTrace = dependencies.traces.finish(trace.requestId, "completed")!;
      const finalAnswer = prepared.footer ? `${answer}\n\n${prepared.footer}` : answer;
      const chunks = splitTelegramMessage(finalAnswer);
      if (liveTrace) {
        await progress.finish(`✅ Selesai\n\n${formatRequestTrace(completedTrace)}`);
        for (const chunk of chunks) {
          await awaitTelegramCall(
            (signal) => ctx.reply(chunk, {}, asGrammySignal(signal)),
            activeCallOptions,
          );
        }
      } else {
        await progress.finish(chunks[0] ?? "Selesai.");
        for (const chunk of chunks.slice(1)) {
          await awaitTelegramCall(
            (signal) => ctx.reply(chunk, {}, asGrammySignal(signal)),
            activeCallOptions,
          );
        }
      }
      for (const itemId of requestedFileIds) {
        await sendVaultFile(ctx, itemId, activeCallOptions);
      }
    } catch (error) {
      const aborted = isAbortError(error, active.controller.signal);
      const status = active.timedOut ? "timeout" : aborted ? "cancelled" : "failed";
      const safeMessage = safeErrorMessage(error);
      dependencies.traces.finish(trace.requestId, status, safeMessage);
      if (status === "cancelled") {
        await progress?.finish("⛔ Permintaan dibatalkan.", true);
      } else if (status === "timeout") {
        await progress?.finish(
          `⌛ Proses melewati batas ${timeoutSeconds} detik. Silakan coba lagi.`,
          true,
        );
      } else if (error instanceof ImageInputError || error instanceof InvalidVaultOperationError) {
        await progress?.finish(`⚠️ ${error.message}`, true);
      } else {
        logger.error({ errorMessage: safeMessage }, "Assistant response failed");
        await progress?.finish(
          "Maaf, terjadi kesalahan saat memproses permintaan. Coba lagi sebentar.",
          true,
        );
      }
    } finally {
      clearTimeout(timeout);
      if (typingTimer) clearInterval(typingTimer);
      if (activeRequests.get(chatId) === active) activeRequests.delete(chatId);
      active.resolveFinished();
    }
  }

  async function prepareIncomingAttachment(
    ctx: Context,
    attachment: IncomingAttachment,
    signal: AbortSignal,
  ): Promise<PreparedAssistantInput> {
    const bytes = await downloadTelegramFile(
      ctx,
      config,
      attachment.fileId,
      attachment.fileSize,
      signal,
    );
    const validated = await validateAttachment(attachment, bytes);
    let fileName = validated.attachment.fileName;
    if (dependencies.vault.findDuplicateName(fileName, null)) {
      const extension = fileName.includes(".") ? `.${fileName.split(".").pop()}` : "";
      const base = extension ? fileName.slice(0, -extension.length) : fileName;
      fileName = `${base} (Telegram ${ctx.message!.message_id})${extension}`;
    }
    const item = await dependencies.vault.saveFileObject(
      {
        name: fileName,
        mimeType: validated.detectedMimeType,
        detectedMimeType: validated.detectedMimeType,
        mediaKind: attachment.kind,
        fileUniqueId: attachment.fileUniqueId,
        sourceCaption: attachment.caption ?? null,
        bytes: validated.bytes,
        chatId: String(ctx.chat!.id),
        messageId: String(ctx.message!.message_id),
      },
      signal,
    );
    const vaultPath = dependencies.vault.pathFor(item.id);
    try {
      await awaitTelegramCall(
        (telegramSignal) =>
          ctx.reply(
            `✅ File tersimpan: ${vaultPath} (#${item.id}, ${formatBytes(item.sizeBytes)}, ${item.storageBackend === "s3" ? "Bucket" : "Volume"}). Analisis dilanjutkan…`,
            {},
            asGrammySignal(telegramSignal),
          ),
        { timeoutMs: TELEGRAM_API_TIMEOUT_MS },
      );
    } catch (error) {
      logger.warn(
        { itemId: item.id, errorMessage: safeErrorMessage(error) },
        "Attachment storage acknowledgement failed",
      );
    }
    let analysis: Awaited<ReturnType<typeof analyzeAttachment>>;
    try {
      analysis = await analyzeAttachment(
        dependencies.assistant.openaiClient,
        config,
        validated,
        attachment.caption ?? "",
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      logger.warn(
        { itemId: item.id, errorMessage: safeErrorMessage(error) },
        "Attachment analysis failed after safe storage",
      );
      analysis = { warning: "File sudah tersimpan, tetapi analisis otomatis gagal untuk format ini." };
    }
    return {
      ...(analysis.images?.length ? { images: analysis.images } : {}),
      attachmentContext: {
        attachment: {
          kind: attachment.kind,
          name: item.name,
          mimeType: item.detectedMimeType ?? item.mimeType,
          sizeBytes: item.sizeBytes,
        },
        vault: { saved: true, id: item.id, path: vaultPath, backend: item.storageBackend },
        ...(analysis.summary ? { extractedAnalysis: analysis.summary } : {}),
        ...(analysis.warning ? { analysisWarning: analysis.warning } : {}),
      },
      footer: `✅ File tersimpan: ${vaultPath} (#${item.id}, ${formatBytes(item.sizeBytes)}, ${item.storageBackend === "s3" ? "Bucket" : "Volume"})`,
    };
  }

  async function receiveAttachment(
    ctx: Context,
    attachment: IncomingAttachment,
  ): Promise<void> {
    const chatId = String(ctx.chat!.id);
    // Do not await the negative busy check: another update (/cancel or text) may
    // otherwise interleave before the image has a coordinator identity.
    const active = activeRequests.get(chatId);
    if (active) {
      await ctx.reply(
        `Masih memproses permintaan #${active.requestId.slice(0, 8).toUpperCase()}. ` +
          "Kirim /cancel untuk membatalkannya.",
      );
      return;
    }
    const trimmedCaption = attachment.caption?.trim();
    const loader = (signal: AbortSignal) => prepareIncomingAttachment(ctx, attachment, signal);
    if (trimmedCaption) {
      await processAssistantRequest(ctx, trimmedCaption, loader);
      return;
    }

    if (attachment.kind !== "photo" || attachment.forwarded) {
      await processAssistantRequest(
        ctx,
        `Analisis ${attachment.kind.replace("_", " ")} ini dan jelaskan temuan pentingnya.`,
        loader,
      );
      return;
    }

    const pendingOperation = pendingImages.begin(
      chatId,
      loader,
      30_000,
      config.TELEGRAM_PENDING_IMAGE_SECONDS * 1000,
    );
    let statusMessage: Awaited<ReturnType<Context["reply"]>>;
    try {
      statusMessage = await awaitTelegramCall(
        (signal) => ctx.reply("📥 Mengunduh gambar…", {}, asGrammySignal(signal)),
        { canPublish: pendingOperation.canPublish },
      );
    } catch (error) {
      // Conditional token cleanup cannot cancel an image that a newer update
      // installed while this status request was in flight.
      pendingOperation.cancel(new Error("Telegram status message failed"));
      if (!pendingOperation.canPublish() || error instanceof TelegramCallAbortedError) return;
      throw error;
    }
    let acknowledgement: string;
    try {
      const ready = await pendingOperation.promise;
      acknowledgement = pendingOperation.wasClaimed()
        ? "📷 Gambar diterima dan sedang dipakai untuk menjawab pertanyaan Anda."
        : `${ready.footer ?? "📷 Gambar diterima."}\nKirim pertanyaan dalam ${Math.floor(
            config.TELEGRAM_PENDING_IMAGE_SECONDS / 60,
          )} menit.`;
      if (!pendingOperation.wasClaimed()) delete ready.footer;
    } catch (error) {
      acknowledgement =
        pendingOperation.wasAborted()
          ? "⛔ Pengunduhan gambar dibatalkan."
          : error instanceof ImageInputError || error instanceof InvalidVaultOperationError
          ? `⚠️ ${error.message}`
          : "Maaf, gambar gagal diunduh. Silakan kirim ulang.";
      if (!pendingOperation.wasAborted() && !(error instanceof ImageInputError)) {
        logger.error({ errorMessage: safeErrorMessage(error) }, "Telegram image download failed");
      }
    }
    if (!pendingOperation.canPublish()) return;
    try {
      await editMessageOrReply(
        ctx,
        statusMessage.message_id,
        acknowledgement,
        logger,
        { canPublish: pendingOperation.canPublish },
      );
    } catch (error) {
      logger.warn(
        { errorMessage: safeErrorMessage(error) },
        "Telegram image acknowledgement failed",
      );
    }
  }

  async function dispatchAttachment(
    ctx: Context,
    attachment: IncomingAttachment,
  ): Promise<void> {
    if (!attachment.forwarded) {
      await receiveAttachment(ctx, attachment);
      return;
    }
    const chatId = String(ctx.chat!.id);
    scheduleAssistantWork(chatId, () => receiveAttachment(ctx, attachment));
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

  bot.use(async (ctx, next) => {
    if (ctx.message) {
      try {
        dependencies.telegramHistory.record(
          String(ctx.message.chat.id),
          ctx.message.message_id,
          ctx.message.date,
        );
      } catch (error) {
        logger.error(
          { errorMessage: safeErrorMessage(error) },
          "Telegram incoming message tracking failed",
        );
      }
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
    await replyInTelegramChunks(ctx, `Memori tersimpan:\n${text}`);
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

  bot.command("vault", async (ctx) => {
    const requestedPath = commandArguments(ctx.message?.text);
    const folder = requestedPath ? dependencies.vault.resolveFolderPath(requestedPath) : null;
    if (requestedPath && !folder) {
      await ctx.reply(`Folder \"${requestedPath}\" tidak ditemukan.`);
      return;
    }
    const items = dependencies.vault.list(folder?.id ?? null);
    if (items.length === 0) {
      await ctx.reply(`Vault ${requestedPath ? `/${requestedPath}` : "/"} masih kosong.`);
      return;
    }
    const lines = items.map((item) => {
      const icon = item.kind === "folder" ? "📁" : item.kind === "note" ? "📝" : "📄";
      const size = item.kind === "folder" ? "" : ` · ${formatBytes(item.sizeBytes)}`;
      return `${icon} #${item.id} ${item.name}${size}`;
    });
    await replyInTelegramChunks(
      ctx,
      `Isi vault ${requestedPath ? `/${requestedPath}` : "/"}:\n${lines.join("\n")}`,
    );
  });

  bot.command("mkdir", async (ctx) => {
    const folderPath = commandArguments(ctx.message?.text);
    if (!folderPath) {
      await ctx.reply("Format: /mkdir <folder/subfolder>");
      return;
    }
    try {
      const folder = dependencies.vault.ensureFolderPath(folderPath);
      await ctx.reply(`📁 Folder siap: ${folder ? dependencies.vault.pathFor(folder.id) : "/"}`);
    } catch (error) {
      await ctx.reply(`⚠️ ${error instanceof Error ? error.message : "Folder gagal dibuat."}`);
    }
  });

  bot.command("save", async (ctx) => {
    const args = commandArguments(ctx.message?.text);
    const replied = ctx.message?.reply_to_message;
    if (replied?.document) {
      await saveTelegramFile(ctx, {
        fileId: replied.document.file_id,
        fileUniqueId: replied.document.file_unique_id,
        kind: "document",
        fileName: replied.document.file_name ?? `Dokumen Telegram ${replied.message_id}`,
        ...(replied.document.mime_type ? { mimeType: replied.document.mime_type } : {}),
        ...(replied.document.file_size ? { fileSize: replied.document.file_size } : {}),
        ...(args ? { folderPath: args } : {}),
      });
      return;
    }
    if (replied?.photo) {
      const photo = selectLargestPhoto(replied.photo);
      if (!photo) {
        await ctx.reply("Foto yang dibalas tidak dapat diunduh.");
        return;
      }
      await saveTelegramFile(ctx, {
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id,
        kind: "photo",
        fileName: generatedPhotoName(replied.message_id),
        mimeType: "image/jpeg",
        ...(photo.file_size ? { fileSize: photo.file_size } : {}),
        ...(args ? { folderPath: args } : {}),
      });
      return;
    }
    if (replied?.video) {
      await saveTelegramFile(ctx, {
        fileId: replied.video.file_id,
        fileUniqueId: replied.video.file_unique_id,
        kind: "video",
        fileName: replied.video.file_name ?? `Video Telegram ${replied.message_id}.mp4`,
        ...(replied.video.mime_type ? { mimeType: replied.video.mime_type } : {}),
        ...(replied.video.file_size ? { fileSize: replied.video.file_size } : {}),
        durationSeconds: replied.video.duration,
        ...(args ? { folderPath: args } : {}),
      });
      return;
    }
    if (replied?.animation) {
      await saveTelegramFile(ctx, {
        fileId: replied.animation.file_id,
        fileUniqueId: replied.animation.file_unique_id,
        kind: "animation",
        fileName: replied.animation.file_name ?? `Animasi Telegram ${replied.message_id}.mp4`,
        ...(replied.animation.mime_type ? { mimeType: replied.animation.mime_type } : {}),
        ...(replied.animation.file_size ? { fileSize: replied.animation.file_size } : {}),
        durationSeconds: replied.animation.duration,
        ...(args ? { folderPath: args } : {}),
      });
      return;
    }
    if (replied?.audio) {
      await saveTelegramFile(ctx, {
        fileId: replied.audio.file_id,
        fileUniqueId: replied.audio.file_unique_id,
        kind: "audio",
        fileName: replied.audio.file_name ?? `Audio Telegram ${replied.message_id}.mp3`,
        ...(replied.audio.mime_type ? { mimeType: replied.audio.mime_type } : {}),
        ...(replied.audio.file_size ? { fileSize: replied.audio.file_size } : {}),
        durationSeconds: replied.audio.duration,
        ...(args ? { folderPath: args } : {}),
      });
      return;
    }
    if (replied?.voice) {
      await saveTelegramFile(ctx, {
        fileId: replied.voice.file_id,
        fileUniqueId: replied.voice.file_unique_id,
        kind: "voice",
        fileName: `Voice Telegram ${replied.message_id}.ogg`,
        ...(replied.voice.mime_type ? { mimeType: replied.voice.mime_type } : {}),
        ...(replied.voice.file_size ? { fileSize: replied.voice.file_size } : {}),
        durationSeconds: replied.voice.duration,
        ...(args ? { folderPath: args } : {}),
      });
      return;
    }
    if (replied?.video_note) {
      await saveTelegramFile(ctx, {
        fileId: replied.video_note.file_id,
        fileUniqueId: replied.video_note.file_unique_id,
        kind: "video_note",
        fileName: `Video Note Telegram ${replied.message_id}.mp4`,
        mimeType: "video/mp4",
        ...(replied.video_note.file_size ? { fileSize: replied.video_note.file_size } : {}),
        durationSeconds: replied.video_note.duration,
        ...(args ? { folderPath: args } : {}),
      });
      return;
    }
    if (replied?.sticker) {
      const extension = replied.sticker.is_animated ? "tgs" : replied.sticker.is_video ? "webm" : "webp";
      await saveTelegramFile(ctx, {
        fileId: replied.sticker.file_id,
        fileUniqueId: replied.sticker.file_unique_id,
        kind: "sticker",
        fileName: `Sticker Telegram ${replied.message_id}.${extension}`,
        mimeType: replied.sticker.is_animated
          ? "application/x-tgsticker"
          : replied.sticker.is_video
            ? "video/webm"
            : "image/webp",
        ...(replied.sticker.file_size ? { fileSize: replied.sticker.file_size } : {}),
        ...(args ? { folderPath: args } : {}),
      });
      return;
    }
    if (replied?.text || replied?.caption) {
      const content = replied.text ?? replied.caption ?? "";
      const [namePart, folderPart] = args.split("|", 2).map((part) => part.trim());
      const name = namePart || generatedNoteName(content, replied.message_id);
      try {
        const parent = folderPart ? dependencies.vault.ensureFolderPath(folderPart) : null;
        const item = dependencies.vault.saveNote(name, content, parent?.id ?? null, {
          chatId: String(ctx.chat.id),
          messageId: String(replied.message_id),
        });
        await ctx.reply(`✅ Catatan disimpan: ${dependencies.vault.pathFor(item.id)} (#${item.id})`);
      } catch (error) {
        const message =
          error instanceof DuplicateVaultItemError
            ? `Nama duplikat: ${error.existing.name} sudah ada sebagai #${error.existing.id}.`
            : error instanceof Error
              ? error.message
              : "Catatan gagal disimpan.";
        await ctx.reply(`⚠️ ${message}`);
      }
      return;
    }
    const separator = args.indexOf("|");
    if (separator < 1 || !args.slice(separator + 1).trim()) {
      await ctx.reply(
        "Balas sebuah chat/file dengan /save. Untuk catatan baru gunakan: /save Judul | Isi catatan",
      );
      return;
    }
    try {
      const item = dependencies.vault.saveNote(
        args.slice(0, separator).trim(),
        args.slice(separator + 1).trim(),
        null,
        { chatId: String(ctx.chat.id), messageId: String(ctx.message?.message_id ?? "") },
      );
      await ctx.reply(`✅ Catatan disimpan: ${dependencies.vault.pathFor(item.id)} (#${item.id})`);
    } catch (error) {
      await ctx.reply(`⚠️ ${error instanceof Error ? error.message : "Catatan gagal disimpan."}`);
    }
  });

  bot.command("find", async (ctx) => {
    const query = commandArguments(ctx.message?.text);
    if (!query) {
      await ctx.reply("Format: /find <kata pencarian>");
      return;
    }
    const items = dependencies.vault.search(query, 20);
    if (items.length === 0) {
      await ctx.reply(`Tidak ada item vault yang cocok dengan \"${query}\".`);
      return;
    }
    await replyInTelegramChunks(
      ctx,
      items
        .map((item) => `${item.kind === "folder" ? "📁" : item.kind === "note" ? "📝" : "📄"} #${item.id} ${dependencies.vault.pathFor(item.id)}`)
        .join("\n"),
    );
  });

  bot.command("get", async (ctx) => {
    const id = commandId(ctx.message?.text);
    if (!id) {
      await ctx.reply("Format: /get <id-file>");
      return;
    }
    try {
      await sendVaultFile(ctx, id);
    } catch (error) {
      await ctx.reply(`⚠️ ${error instanceof Error ? error.message : "File gagal dikirim."}`);
    }
  });

  bot.command("rename", async (ctx) => {
    const match = commandArguments(ctx.message?.text).match(/^(\d+)\s+(.+)$/u);
    if (!match?.[1] || !match[2]) {
      await ctx.reply("Format: /rename <id> <nama baru>");
      return;
    }
    try {
      const item = dependencies.vault.rename(Number(match[1]), match[2]);
      await ctx.reply(`✅ Nama diubah: ${dependencies.vault.pathFor(item.id)}`);
    } catch (error) {
      await ctx.reply(`⚠️ ${error instanceof Error ? error.message : "Nama gagal diubah."}`);
    }
  });

  bot.command("move", async (ctx) => {
    const match = commandArguments(ctx.message?.text).match(/^(\d+)\s+(.+)$/u);
    if (!match?.[1] || !match[2]) {
      await ctx.reply("Format: /move <id> <folder tujuan|/>");
      return;
    }
    try {
      const requestedPath = match[2].trim();
      const parent = requestedPath === "/" ? null : dependencies.vault.resolveFolderPath(requestedPath);
      if (requestedPath !== "/" && !parent) {
        await ctx.reply(`Folder \"${requestedPath}\" tidak ditemukan.`);
        return;
      }
      const item = dependencies.vault.move(Number(match[1]), parent?.id ?? null);
      await ctx.reply(`✅ Item dipindahkan: ${dependencies.vault.pathFor(item.id)}`);
    } catch (error) {
      await ctx.reply(`⚠️ ${error instanceof Error ? error.message : "Item gagal dipindahkan."}`);
    }
  });

  bot.command("delete_item", async (ctx) => {
    const match = commandArguments(ctx.message?.text).match(/^(\d+)\s+CONFIRM$/u);
    if (!match?.[1]) {
      await ctx.reply("Format: /delete_item <id> CONFIRM");
      return;
    }
    try {
      const deleted = await dependencies.vault.deleteStored(Number(match[1]));
      await ctx.reply(`🗑️ Item dihapus (${deleted} item termasuk isi folder).`);
    } catch (error) {
      await ctx.reply(`⚠️ ${error instanceof Error ? error.message : "Item gagal dihapus."}`);
    }
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
    await replyInTelegramChunks(ctx, `Aturan email:\n${text}`);
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
    if (!/^\/clear_chat(?:@\w+)?\s+CONFIRM$/u.test(ctx.message?.text ?? "")) {
      await ctx.reply(
        "Untuk mereset konteks AI dan menghapus pesan Telegram terbaru, kirim: /clear_chat CONFIRM\n\n" +
          "Telegram membatasi penghapusan oleh bot hingga 48 jam terakhir. Memori dan isi vault tetap tersimpan.",
      );
      return;
    }

    const chatId = String(ctx.chat.id);
    const active = activeRequests.get(chatId);
    if (active) {
      active.controller.abort(new Error("Cleared by Telegram owner"));
      await active.finished;
    }

    const deleted = dependencies.conversations.clear(chatId);
    pendingImages.cancel(chatId, new Error("Cleared by Telegram owner"));

    // Stay clear of Telegram's exact 48-hour boundary to avoid clock-skew failures.
    const cutoff = Math.floor(Date.now() / 1000) - TELEGRAM_DELETE_WINDOW_SECONDS + 60;
    const messageIds = dependencies.telegramHistory.recentMessageIds(chatId, cutoff);
    let removedTelegramMessages = 0;
    let failedTelegramMessages = 0;
    for (let index = 0; index < messageIds.length; index += TELEGRAM_DELETE_BATCH_SIZE) {
      const batch = messageIds.slice(index, index + TELEGRAM_DELETE_BATCH_SIZE);
      try {
        await ctx.api.deleteMessages(ctx.chat.id, batch);
        removedTelegramMessages += dependencies.telegramHistory.forget(chatId, batch);
      } catch (error) {
        failedTelegramMessages += batch.length;
        logger.warn(
          { errorMessage: safeErrorMessage(error), messageCount: batch.length },
          "Telegram message deletion batch failed",
        );
      }
    }
    dependencies.telegramHistory.pruneBefore(cutoff);

    await ctx.reply(
      [
        `✅ Chat direset: ${deleted} pesan konteks AI dan ${removedTelegramMessages} pesan Telegram terbaru dihapus.`,
        "Memori personal dan isi vault tetap tersimpan.",
        "Pesan yang lebih lama dari 48 jam atau belum pernah tercatat oleh versi bot ini perlu dihapus manual melalui aplikasi Telegram.",
        failedTelegramMessages > 0
          ? `⚠️ ${failedTelegramMessages} pesan belum berhasil dihapus; jalankan kembali /clear_chat CONFIRM.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
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
    const hadPendingImage = pendingImages.cancel(
      chatId,
      new Error("Cancelled by Telegram owner"),
    );
    if (active) active.controller.abort(new Error("Cancelled by Telegram owner"));
    if (active || hadPendingImage) {
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
    const vaultStats = dependencies.vault.stats();
    await ctx.reply(
      [
        "Status layanan:",
        `• Model chat: ${config.OPENAI_CHAT_MODEL}`,
        `• Model klasifikasi email: ${config.OPENAI_CLASSIFIER_MODEL}`,
        `• Token output maksimum: ${config.OPENAI_MAX_OUTPUT_TOKENS}`,
        `• Timeout assistant: ${config.ASSISTANT_TIMEOUT_SECONDS} detik`,
        `• Analisis gambar: aktif (maks. ${formatByteLimit(config.TELEGRAM_IMAGE_MAX_BYTES)})`,
        `• Analisis attachment: ${config.ATTACHMENT_ANALYSIS_ENABLED ? "aktif" : "nonaktif"}`,
        `• Penyimpanan file baru: ${config.VAULT_STORAGE_BACKEND === "s3" ? "Railway Bucket (S3)" : "Volume lokal"}`,
        `• Trace live: ${dependencies.traces.isLiveEnabled(String(ctx.chat.id)) ? "aktif" : "nonaktif"}`,
        `• Gmail: ${dependencies.gmailConfigured ? "terhubung" : "belum dikonfigurasi"}`,
        `• Web search: ${dependencies.search.available ? dependencies.search.name : "belum dikonfigurasi"}`,
        `• Vault: ${vaultStats.files} file, ${vaultStats.notes} catatan, ${vaultStats.folders} folder (${formatBytes(vaultStats.totalBytes)})`,
        `• Dashboard: ${config.DASHBOARD_ENABLED ? `aktif di port ${config.PORT}` : "nonaktif"}`,
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
    if (/^\/save(?:@\w+)?(?:\s|$)/u.test(ctx.message.caption ?? "")) {
      await saveTelegramFile(ctx, {
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id,
        kind: "photo",
        fileName: generatedPhotoName(ctx.message.message_id),
        mimeType: "image/jpeg",
        ...(photo.file_size ? { fileSize: photo.file_size } : {}),
        ...(ctx.message.caption ? { folderPath: commandArguments(ctx.message.caption) } : {}),
      });
      return;
    }
    await dispatchAttachment(ctx, {
      kind: "photo",
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      fileName: generatedPhotoName(ctx.message.message_id),
      claimedMimeType: "image/jpeg",
      ...(photo.file_size ? { fileSize: photo.file_size } : {}),
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
      ...(ctx.message.forward_origin ? { forwarded: true } : {}),
    });
  });

  bot.on("message:document", async (ctx) => {
    const document = ctx.message.document;
    const saveCaption = /^\/save(?:@\w+)?(?:\s|$)/u.test(ctx.message.caption ?? "");
    if (saveCaption) {
      await saveTelegramFile(ctx, {
        fileId: document.file_id,
        fileUniqueId: document.file_unique_id,
        kind: "document",
        fileName: document.file_name ?? `Dokumen Telegram ${ctx.message.message_id}`,
        ...(document.mime_type ? { mimeType: document.mime_type } : {}),
        ...(document.file_size ? { fileSize: document.file_size } : {}),
        ...(saveCaption && ctx.message.caption
          ? { folderPath: commandArguments(ctx.message.caption) }
          : {}),
      });
      return;
    }
    await dispatchAttachment(ctx, {
      kind: "document",
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      fileName: document.file_name ?? `Dokumen Telegram ${ctx.message.message_id}`,
      ...(document.mime_type ? { claimedMimeType: document.mime_type } : {}),
      ...(document.file_size ? { fileSize: document.file_size } : {}),
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
      ...(ctx.message.forward_origin ? { forwarded: true } : {}),
    });
  });

  bot.on("message:video", async (ctx) => {
    const video = ctx.message.video;
    const saveCaption = /^\/save(?:@\w+)?(?:\s|$)/u.test(ctx.message.caption ?? "");
    const attachment: IncomingAttachment = {
      kind: "video",
      fileId: video.file_id,
      fileUniqueId: video.file_unique_id,
      fileName: video.file_name ?? `Video Telegram ${ctx.message.message_id}.mp4`,
      claimedMimeType: video.mime_type ?? "video/mp4",
      ...(video.file_size ? { fileSize: video.file_size } : {}),
      durationSeconds: video.duration,
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
      ...(ctx.message.forward_origin ? { forwarded: true } : {}),
    };
    if (saveCaption) {
      await saveTelegramFile(ctx, {
        fileId: attachment.fileId,
        fileUniqueId: attachment.fileUniqueId,
        kind: attachment.kind,
        fileName: attachment.fileName,
        ...(attachment.claimedMimeType ? { mimeType: attachment.claimedMimeType } : {}),
        ...(attachment.fileSize ? { fileSize: attachment.fileSize } : {}),
        ...(attachment.durationSeconds ? { durationSeconds: attachment.durationSeconds } : {}),
        ...(saveCaption ? { folderPath: commandArguments(ctx.message.caption) } : {}),
      });
      return;
    }
    await dispatchAttachment(ctx, attachment);
  });

  bot.on("message:animation", async (ctx) => {
    const animation = ctx.message.animation;
    const saveCaption = /^\/save(?:@\w+)?(?:\s|$)/u.test(ctx.message.caption ?? "");
    if (saveCaption) {
      await saveTelegramFile(ctx, {
        fileId: animation.file_id,
        fileUniqueId: animation.file_unique_id,
        kind: "animation",
        fileName: animation.file_name ?? `Animasi Telegram ${ctx.message.message_id}.mp4`,
        ...(animation.mime_type ? { mimeType: animation.mime_type } : {}),
        ...(animation.file_size ? { fileSize: animation.file_size } : {}),
        durationSeconds: animation.duration,
        ...(saveCaption ? { folderPath: commandArguments(ctx.message.caption) } : {}),
      });
      return;
    }
    await dispatchAttachment(ctx, {
      kind: "animation",
      fileId: animation.file_id,
      fileUniqueId: animation.file_unique_id,
      fileName: animation.file_name ?? `Animasi Telegram ${ctx.message.message_id}.mp4`,
      claimedMimeType: animation.mime_type ?? "video/mp4",
      ...(animation.file_size ? { fileSize: animation.file_size } : {}),
      durationSeconds: animation.duration,
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
      ...(ctx.message.forward_origin ? { forwarded: true } : {}),
    });
  });

  bot.on("message:audio", async (ctx) => {
    const audio = ctx.message.audio;
    const saveCaption = /^\/save(?:@\w+)?(?:\s|$)/u.test(ctx.message.caption ?? "");
    if (saveCaption) {
      await saveTelegramFile(ctx, {
        fileId: audio.file_id,
        fileUniqueId: audio.file_unique_id,
        kind: "audio",
        fileName: audio.file_name ?? `Audio Telegram ${ctx.message.message_id}.mp3`,
        ...(audio.mime_type ? { mimeType: audio.mime_type } : {}),
        ...(audio.file_size ? { fileSize: audio.file_size } : {}),
        durationSeconds: audio.duration,
        ...(saveCaption ? { folderPath: commandArguments(ctx.message.caption) } : {}),
      });
      return;
    }
    await dispatchAttachment(ctx, {
      kind: "audio",
      fileId: audio.file_id,
      fileUniqueId: audio.file_unique_id,
      fileName: audio.file_name ?? `Audio Telegram ${ctx.message.message_id}.mp3`,
      claimedMimeType: audio.mime_type ?? "audio/mpeg",
      ...(audio.file_size ? { fileSize: audio.file_size } : {}),
      durationSeconds: audio.duration,
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
      ...(ctx.message.forward_origin ? { forwarded: true } : {}),
    });
  });

  bot.on("message:voice", async (ctx) => {
    const voice = ctx.message.voice;
    const saveCaption = /^\/save(?:@\w+)?(?:\s|$)/u.test(ctx.message.caption ?? "");
    if (saveCaption) {
      await saveTelegramFile(ctx, {
        fileId: voice.file_id,
        fileUniqueId: voice.file_unique_id,
        kind: "voice",
        fileName: `Voice Telegram ${ctx.message.message_id}.ogg`,
        ...(voice.mime_type ? { mimeType: voice.mime_type } : {}),
        ...(voice.file_size ? { fileSize: voice.file_size } : {}),
        durationSeconds: voice.duration,
        ...(saveCaption ? { folderPath: commandArguments(ctx.message.caption) } : {}),
      });
      return;
    }
    await dispatchAttachment(ctx, {
      kind: "voice",
      fileId: voice.file_id,
      fileUniqueId: voice.file_unique_id,
      fileName: `Voice Telegram ${ctx.message.message_id}.ogg`,
      claimedMimeType: voice.mime_type ?? "audio/ogg",
      ...(voice.file_size ? { fileSize: voice.file_size } : {}),
      durationSeconds: voice.duration,
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
      ...(ctx.message.forward_origin ? { forwarded: true } : {}),
    });
  });

  bot.on("message:video_note", async (ctx) => {
    const video = ctx.message.video_note;
    await dispatchAttachment(ctx, {
      kind: "video_note",
      fileId: video.file_id,
      fileUniqueId: video.file_unique_id,
      fileName: `Video Note Telegram ${ctx.message.message_id}.mp4`,
      claimedMimeType: "video/mp4",
      ...(video.file_size ? { fileSize: video.file_size } : {}),
      durationSeconds: video.duration,
      ...(ctx.message.forward_origin ? { forwarded: true } : {}),
    });
  });

  bot.on("message:sticker", async (ctx) => {
    const sticker = ctx.message.sticker;
    const extension = sticker.is_animated ? "tgs" : sticker.is_video ? "webm" : "webp";
    await dispatchAttachment(ctx, {
      kind: "sticker",
      fileId: sticker.file_id,
      fileUniqueId: sticker.file_unique_id,
      fileName: `Sticker Telegram ${ctx.message.message_id}.${extension}`,
      claimedMimeType: sticker.is_animated
        ? "application/x-tgsticker"
        : sticker.is_video
          ? "video/webm"
          : "image/webp",
      ...(sticker.file_size ? { fileSize: sticker.file_size } : {}),
      ...(ctx.message.forward_origin ? { forwarded: true } : {}),
    });
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.forward_origin) {
      enqueueForwardedText(ctx);
      return;
    }
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

export { splitTelegramMessage, telegramMessageReferences };
