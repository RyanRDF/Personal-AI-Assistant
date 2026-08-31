import type { Context } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramBot,
  createProgressController,
  editMessageOrReply,
  imageBytesToDataUrl,
  isOwnerPrivateChat,
  replyInTelegramChunks,
  resolveImageMimeType,
  selectLargestPhoto,
  splitTelegramMessage,
  telegramMessageReferences,
} from "../src/telegram/bot.js";
import { createLogger } from "../src/logger.js";
import { testConfig } from "./helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Telegram safety and formatting", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("only permits the configured owner in private chat", () => {
    expect(isOwnerPrivateChat(42, 42, "private")).toBe(true);
    expect(isOwnerPrivateChat(42, 7, "private")).toBe(false);
    expect(isOwnerPrivateChat(42, 42, "group")).toBe(false);
  });

  it("splits long replies below Telegram's limit", () => {
    const chunks = splitTelegramMessage("kata ".repeat(2000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(
      "kata ".repeat(2000).trim(),
    );
  });

  it("sends every long command result as Telegram-safe chunks", async () => {
    const reply = vi.fn().mockResolvedValue({});
    const ctx = { reply } as unknown as Context;

    await replyInTelegramChunks(ctx, "hasil ".repeat(2_000));

    expect(reply.mock.calls.length).toBeGreaterThan(1);
    expect(reply.mock.calls.every(([chunk]) => String(chunk).length <= 4_000)).toBe(true);
  });

  it("falls back to a new reply when the final progress edit fails", async () => {
    const reply = vi.fn().mockResolvedValue({});
    const editMessageText = vi.fn().mockRejectedValue(new Error("message cannot be edited"));
    const ctx = {
      chat: { id: 42 },
      api: { editMessageText },
      reply,
    } as unknown as Context;
    const progress = createProgressController(ctx, 7, 0, createLogger({ LOG_LEVEL: "silent" }));

    await progress.finish("Jawaban final");

    expect(editMessageText).toHaveBeenCalledWith(
      42,
      7,
      "Jawaban final",
      {},
      expect.any(AbortSignal),
    );
    expect(reply).toHaveBeenCalledWith("Jawaban final", {}, expect.any(AbortSignal));
  });

  it("uses the same reply fallback for completion and error acknowledgements", async () => {
    const reply = vi.fn().mockResolvedValue({});
    const editMessageText = vi.fn().mockRejectedValue(new Error("message cannot be edited"));
    const ctx = {
      chat: { id: 42 },
      api: { editMessageText },
      reply,
    } as unknown as Context;
    const logger = createLogger({ LOG_LEVEL: "silent" });

    await editMessageOrReply(ctx, 7, "✅ File disimpan", logger);
    await editMessageOrReply(ctx, 8, "⚠️ Gambar gagal diunduh", logger);

    expect(reply.mock.calls.map(([text]) => text)).toEqual([
      "✅ File disimpan",
      "⚠️ Gambar gagal diunduh",
    ]);
    expect(reply.mock.calls.every((call) => call[2] instanceof AbortSignal)).toBe(true);
  });

  it("does not issue a late duplicate reply after an edit deadline", async () => {
    vi.useFakeTimers();
    let resolveEdit!: (value: unknown) => void;
    const edit = new Promise<unknown>((resolve) => {
      resolveEdit = resolve;
    });
    const reply = vi.fn().mockResolvedValue({});
    let editSignal: AbortSignal | undefined;
    const ctx = {
      chat: { id: 42 },
      api: {
        editMessageText: vi.fn(
          (_chatId, _messageId, _text, _other, signal: AbortSignal) => {
            editSignal = signal;
            return edit;
          },
        ),
      },
      reply,
    } as unknown as Context;
    const publication = editMessageOrReply(
      ctx,
      7,
      "Jawaban final",
      createLogger({ LOG_LEVEL: "silent" }),
      { timeoutMs: 100 },
    );
    const rejection = expect(publication).rejects.toThrow("timed out");

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(editSignal?.aborted).toBe(true);
    resolveEdit({});
    await Promise.resolve();

    expect(reply).not.toHaveBeenCalled();
  });

  it("bounds a stalled active progress edit on request cancellation", async () => {
    const controller = new AbortController();
    const reply = vi.fn().mockResolvedValue({});
    let editSignal: AbortSignal | undefined;
    const ctx = {
      chat: { id: 42 },
      api: {
        editMessageText: vi.fn(
          (_chatId, _messageId, _text, _other, signal: AbortSignal) => {
            editSignal = signal;
            return new Promise(() => undefined);
          },
        ),
      },
      reply,
    } as unknown as Context;
    const progress = createProgressController(
      ctx,
      7,
      0,
      createLogger({ LOG_LEVEL: "silent" }),
      { signal: controller.signal },
    );
    const finishing = progress.finish("Jawaban final");
    await vi.waitFor(() => expect(editSignal).toBeInstanceOf(AbortSignal));

    controller.abort(new Error("cancelled"));

    await expect(finishing).rejects.toThrow("cancelled");
    expect(editSignal?.aborted).toBe(true);
    expect(reply).not.toHaveBeenCalled();
  });

  it("registers a photo token before Telegram awaits and lets /cancel settle a stuck getFile", async () => {
    const firstStatus = deferred<unknown>();
    const stuckGetFile = new Promise<never>(() => undefined);
    let sendMessageCount = 0;
    const apiCalls: string[] = [];
    const apiSignals: Array<{ method: string; signal: unknown }> = [];

    const trace = {
      requestId: "12345678-request",
      chatId: "123456",
      model: "test-model",
      inputKind: "text" as const,
      startedAt: Date.now(),
      stages: [],
      tools: [],
      inputTokens: 0,
      outputTokens: 0,
    };
    const bot = createTelegramBot(
      testConfig(),
      createLogger({ LOG_LEVEL: "silent" }),
      {
        assistant: { reply: vi.fn() },
        conversations: {},
        memories: {},
        vault: {},
        emailRules: {},
        search: { available: false, name: "none" },
        traces: {
          start: vi.fn(() => trace),
          isLiveEnabled: vi.fn(() => false),
          addStage: vi.fn(),
          addTool: vi.fn(),
          addUsage: vi.fn(),
          finish: vi.fn(() => trace),
        },
        telegramHistory: {
          record: vi.fn(),
        },
        gmailConfigured: false,
      } as never,
    );
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    } as never;
    bot.api.config.use(async (_previous, method, _payload, signal) => {
      apiCalls.push(method);
      apiSignals.push({ method, signal });
      if (method === "getFile") return stuckGetFile;
      if (method === "sendMessage") {
        sendMessageCount += 1;
        if (sendMessageCount === 1) return firstStatus.promise as never;
        return {
          ok: true,
          result: {
            message_id: 102,
            date: 1_700_000_001,
            chat: { id: 123456, type: "private" },
            text: "Pembatalan dikirim",
          },
        } as never;
      }
      return { ok: true, result: true } as never;
    });

    const photoHandling = bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 100,
        date: 1_700_000_000,
        chat: { id: 123456, type: "private", first_name: "Owner" },
        from: { id: 123456, is_bot: false, first_name: "Owner" },
        photo: [{ file_id: "photo", file_unique_id: "unique", width: 100, height: 100 }],
      },
    });
    await vi.waitFor(() => {
      expect(apiCalls).toContain("getFile");
      expect(sendMessageCount).toBe(1);
      expect(apiSignals.find(({ method }) => method === "getFile")?.signal).toBeInstanceOf(
        AbortSignal,
      );
      expect(apiSignals.find(({ method }) => method === "sendMessage")?.signal).toBeInstanceOf(
        AbortSignal,
      );
    });

    const cancellation = bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 101,
        date: 1_700_000_001,
        chat: { id: 123456, type: "private", first_name: "Owner" },
        from: { id: 123456, is_bot: false, first_name: "Owner" },
        text: "/cancel",
        entities: [{ offset: 0, length: 7, type: "bot_command" }],
      },
    });
    await cancellation;
    expect(
      (apiSignals.find(({ method }) => method === "getFile")?.signal as AbortSignal).aborted,
    ).toBe(true);
    firstStatus.resolve({
      ok: true,
      result: {
        message_id: 103,
        date: 1_700_000_000,
        chat: { id: 123456, type: "private" },
        text: "Mengunduh gambar",
      },
    });

    await expect(photoHandling).resolves.toBeUndefined();
    expect(sendMessageCount).toBe(2);
  });

  it("stores and responds to a captioned video instead of silently dropping it", async () => {
    const assistantReply = vi.fn().mockResolvedValue("Saya berhasil membaca video servis.");
    const saveFile = vi.fn().mockResolvedValue({
      id: 12,
      parentId: null,
      kind: "file",
      name: "Video Telegram 100.mp4",
      path: "/Video Telegram 100.mp4",
      mimeType: "video/mp4",
      detectedMimeType: "video/mp4",
      mediaKind: "video",
      sizeBytes: 24,
      sourceFileUniqueId: "video-unique",
      sourceCaption: "Simpan video ini ke Vault sebagai bukti servis motor seharga 1.2jt",
      content: null,
      sourceChatId: "123456",
      sourceMessageId: "100",
      createdAt: "2026-08-25 00:00:00",
      updatedAt: "2026-08-25 00:00:00",
    });
    const trace = {
      requestId: "video123-request",
      chatId: "123456",
      model: "test-model",
      inputKind: "image" as const,
      startedAt: Date.now(),
      stages: [],
      tools: [],
      inputTokens: 0,
      outputTokens: 0,
    };
    const bot = createTelegramBot(
      testConfig({ ATTACHMENT_ANALYSIS_ENABLED: "false" }),
      createLogger({ LOG_LEVEL: "silent" }),
      {
        assistant: { openaiClient: {}, reply: assistantReply },
        conversations: {},
        memories: {},
        vault: {
          findDuplicateName: vi.fn(() => null),
          saveFile,
          pathFor: vi.fn(() => "/Video Telegram 100.mp4"),
        },
        emailRules: {},
        search: { available: false, name: "none" },
        traces: {
          start: vi.fn(() => trace),
          isLiveEnabled: vi.fn(() => false),
          addStage: vi.fn(),
          addTool: vi.fn(),
          addUsage: vi.fn(),
          finish: vi.fn(() => trace),
        },
        telegramHistory: { record: vi.fn() },
        gmailConfigured: false,
      } as never,
    );
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
    } as never;
    const mp4 = Uint8Array.from([
      0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109,
      0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 50,
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(mp4, {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": String(mp4.byteLength) },
    })));
    let messageId = 200;
    bot.api.config.use(async (_previous, method) => {
      if (method === "getFile") {
        return { ok: true, result: { file_id: "video-file", file_unique_id: "video-unique", file_size: mp4.byteLength, file_path: "video.mp4" } } as never;
      }
      if (method === "sendChatAction") return { ok: true, result: true } as never;
      messageId += 1;
      return {
        ok: true,
        result: {
          message_id: messageId,
          date: 1_700_000_000,
          chat: { id: 123456, type: "private" },
          text: "ok",
        },
      } as never;
    });

    await bot.handleUpdate({
      update_id: 10,
      message: {
        message_id: 100,
        date: 1_700_000_000,
        chat: { id: 123456, type: "private", first_name: "Owner" },
        from: { id: 123456, is_bot: false, first_name: "Owner" },
        video: {
          file_id: "video-file",
          file_unique_id: "video-unique",
          width: 720,
          height: 1280,
          duration: 7,
          file_size: mp4.byteLength,
          mime_type: "video/mp4",
        },
        caption: "Simpan video ini ke Vault sebagai bukti servis motor seharga 1.2jt",
      },
    });

    expect(saveFile).toHaveBeenCalledOnce();
    expect(assistantReply).toHaveBeenCalledWith(
      "123456",
      expect.objectContaining({
        text: "Simpan video ini ke Vault sebagai bukti servis motor seharga 1.2jt",
        attachmentContext: expect.objectContaining({
          vault: { saved: true, id: 12, path: "/Video Telegram 100.mp4" },
        }),
      }),
      expect.any(Object),
    );
  });

  it("batches forwarded text and saves only the isolated AI result", async () => {
    vi.useFakeTimers();
    const firstReply = deferred<string>();
    const summary = "Judul: Ringkasan Pengeluaran Agustus\n\nTotal final Rp715.000.";
    const assistantReply = vi
      .fn()
      .mockImplementationOnce(() => firstReply.promise)
      .mockResolvedValue(summary);
    const saveNote = vi.fn().mockReturnValue({ id: 21 });
    const trace = {
      requestId: "forward1-request",
      chatId: "123456",
      model: "test-model",
      inputKind: "text" as const,
      startedAt: Date.now(),
      stages: [],
      tools: [],
      inputTokens: 0,
      outputTokens: 0,
    };
    const bot = createTelegramBot(
      testConfig(),
      createLogger({ LOG_LEVEL: "silent" }),
      {
        assistant: { reply: assistantReply },
        conversations: {},
        memories: {},
        vault: {
          findDuplicateName: vi.fn(() => null),
          saveNote,
          pathFor: vi.fn(() => "/Chat Bandung"),
        },
        emailRules: {},
        search: { available: false, name: "none" },
        traces: {
          start: vi.fn(() => trace),
          isLiveEnabled: vi.fn(() => false),
          addStage: vi.fn(),
          addTool: vi.fn(),
          addUsage: vi.fn(),
          finish: vi.fn(() => trace),
        },
        telegramHistory: { record: vi.fn() },
        gmailConfigured: false,
      } as never,
    );
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
    } as never;
    let sentMessageId = 300;
    bot.api.config.use(async (_previous, method) => {
      if (method === "sendChatAction") return { ok: true, result: true } as never;
      sentMessageId += 1;
      return {
        ok: true,
        result: {
          message_id: sentMessageId,
          date: 1_700_000_000,
          chat: { id: 123456, type: "private" },
          text: "ok",
        },
      } as never;
    });
    const forwarded = (messageId: number, text: string) => ({
      update_id: messageId,
      message: {
        message_id: messageId,
        date: 1_700_000_000,
        chat: { id: 123456, type: "private" as const, first_name: "Owner" },
        from: { id: 123456, is_bot: false, first_name: "Owner" },
        forward_origin: {
          type: "user" as const,
          sender_user: { id: 42, is_bot: false, first_name: "Sumber" },
          date: 1_699_999_000,
        },
        text,
      },
    });

    const activeHandling = bot.handleUpdate({
      update_id: 100,
      message: {
        message_id: 100,
        date: 1_700_000_000,
        chat: { id: 123456, type: "private", first_name: "Owner" },
        from: { id: 123456, is_bot: false, first_name: "Owner" },
        text: "Permintaan yang sedang berjalan",
      },
    });
    await vi.waitFor(() => expect(assistantReply).toHaveBeenCalledOnce());
    await bot.handleUpdate(forwarded(101, "Pengeluaran 21 Agustus Rp457.000"));
    await bot.handleUpdate(forwarded(102, "Koreksi total menjadi Rp631.000"));
    await vi.advanceTimersByTimeAsync(800);
    expect(assistantReply).toHaveBeenCalledOnce();
    expect(saveNote).not.toHaveBeenCalled();
    firstReply.resolve("Permintaan awal selesai.");
    await activeHandling;
    await vi.waitFor(() => expect(assistantReply).toHaveBeenCalledTimes(2));

    expect(saveNote).toHaveBeenCalledOnce();
    expect(saveNote.mock.calls[0]?.[0]).toBe("Ringkasan Pengeluaran Agustus");
    expect(saveNote.mock.calls[0]?.[1]).toBe(summary);
    expect(saveNote.mock.calls[0]?.[1]).not.toContain("Pengeluaran 21 Agustus Rp457.000");
    expect(assistantReply.mock.calls[1]?.[1]).toEqual(
      expect.stringContaining("Koreksi total menjadi Rp631.000"),
    );
    expect(assistantReply.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ isolated: true }),
    );
  });

  it("stores and analyzes a forwarded document instead of using save-only mode", async () => {
    const assistantReply = vi.fn().mockResolvedValue("Dokumen berisi catatan pengeluaran.");
    const saveFile = vi.fn().mockResolvedValue({
      id: 22,
      name: "pengeluaran.csv",
      path: "/pengeluaran.csv",
      detectedMimeType: "text/csv",
      mimeType: "text/csv",
      sizeBytes: 32,
    });
    const trace = {
      requestId: "forward2-request",
      chatId: "123456",
      model: "test-model",
      inputKind: "image" as const,
      startedAt: Date.now(),
      stages: [],
      tools: [],
      inputTokens: 0,
      outputTokens: 0,
    };
    const bot = createTelegramBot(
      testConfig({ ATTACHMENT_ANALYSIS_ENABLED: "false" }),
      createLogger({ LOG_LEVEL: "silent" }),
      {
        assistant: { reply: assistantReply, openaiClient: {} },
        conversations: {},
        memories: {},
        vault: {
          findDuplicateName: vi.fn(() => null),
          saveFile,
          pathFor: vi.fn(() => "/pengeluaran.csv"),
        },
        emailRules: {},
        search: { available: false, name: "none" },
        traces: {
          start: vi.fn(() => trace),
          isLiveEnabled: vi.fn(() => false),
          addStage: vi.fn(),
          addTool: vi.fn(),
          addUsage: vi.fn(),
          finish: vi.fn(() => trace),
        },
        telegramHistory: { record: vi.fn() },
        gmailConfigured: false,
      } as never,
    );
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
    } as never;
    const csv = new TextEncoder().encode("tanggal,jumlah\n2026-08-21,457000");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(csv, {
      status: 200,
      headers: { "content-type": "text/csv", "content-length": String(csv.byteLength) },
    })));
    let sentMessageId = 400;
    bot.api.config.use(async (_previous, method) => {
      if (method === "getFile") {
        return {
          ok: true,
          result: {
            file_id: "document-file",
            file_unique_id: "document-unique",
            file_size: csv.byteLength,
            file_path: "pengeluaran.csv",
          },
        } as never;
      }
      if (method === "sendChatAction") return { ok: true, result: true } as never;
      sentMessageId += 1;
      return {
        ok: true,
        result: {
          message_id: sentMessageId,
          date: 1_700_000_000,
          chat: { id: 123456, type: "private" },
          text: "ok",
        },
      } as never;
    });

    await bot.handleUpdate({
      update_id: 200,
      message: {
        message_id: 200,
        date: 1_700_000_000,
        chat: { id: 123456, type: "private", first_name: "Owner" },
        from: { id: 123456, is_bot: false, first_name: "Owner" },
        forward_origin: {
          type: "user",
          sender_user: { id: 42, is_bot: false, first_name: "Sumber" },
          date: 1_699_999_000,
        },
        document: {
          file_id: "document-file",
          file_unique_id: "document-unique",
          file_name: "pengeluaran.csv",
          mime_type: "text/csv",
          file_size: csv.byteLength,
        },
      },
    });
    await vi.waitFor(() => expect(assistantReply).toHaveBeenCalledOnce());

    expect(saveFile).toHaveBeenCalledOnce();
    expect(assistantReply).toHaveBeenCalledWith(
      "123456",
      expect.objectContaining({
        text: "Analisis document ini dan jelaskan temuan pentingnya.",
        attachmentContext: expect.objectContaining({
          vault: expect.objectContaining({ saved: true, id: 22 }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("explains that a truncated Telegram PDF must be downloaded again", async () => {
    const assistantReply = vi.fn();
    const saveFile = vi.fn();
    const editedTexts: string[] = [];
    const trace = {
      requestId: "broken-pdf-request",
      chatId: "123456",
      model: "test-model",
      inputKind: "image" as const,
      startedAt: Date.now(),
      stages: [],
      tools: [],
      inputTokens: 0,
      outputTokens: 0,
    };
    const bot = createTelegramBot(
      testConfig(),
      createLogger({ LOG_LEVEL: "silent" }),
      {
        assistant: { openaiClient: {}, reply: assistantReply },
        conversations: {},
        memories: {},
        vault: { findDuplicateName: vi.fn(() => null), saveFile },
        emailRules: {},
        search: { available: false, name: "none" },
        traces: {
          start: vi.fn(() => trace),
          isLiveEnabled: vi.fn(() => false),
          addStage: vi.fn(),
          addTool: vi.fn(),
          addUsage: vi.fn(),
          finish: vi.fn(() => trace),
        },
        telegramHistory: { record: vi.fn() },
        gmailConfigured: false,
      } as never,
    );
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
    } as never;
    const truncatedPdf = Buffer.from("%PDF-1.4\n1 0 obj\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(truncatedPdf, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(truncatedPdf.byteLength),
      },
    })));
    let messageId = 500;
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === "getFile") {
        return {
          ok: true,
          result: {
            file_id: "broken-pdf",
            file_unique_id: "broken-pdf-unique",
            file_size: truncatedPdf.byteLength,
            file_path: "sertifikat.pdf",
          },
        } as never;
      }
      if (method === "sendChatAction") return { ok: true, result: true } as never;
      if (method === "editMessageText") {
        editedTexts.push(String((payload as { text?: unknown }).text));
      }
      messageId += 1;
      return {
        ok: true,
        result: {
          message_id: messageId,
          date: 1_700_000_000,
          chat: { id: 123456, type: "private" },
          text: "ok",
        },
      } as never;
    });

    await bot.handleUpdate({
      update_id: 300,
      message: {
        message_id: 300,
        date: 1_700_000_000,
        chat: { id: 123456, type: "private", first_name: "Owner" },
        from: { id: 123456, is_bot: false, first_name: "Owner" },
        document: {
          file_id: "broken-pdf",
          file_unique_id: "broken-pdf-unique",
          file_name: "sertifikat.pdf",
          mime_type: "application/pdf",
          file_size: truncatedPdf.byteLength,
        },
        caption: "Simpan",
      },
    });

    expect(saveFile).not.toHaveBeenCalled();
    expect(assistantReply).not.toHaveBeenCalled();
    expect(editedTexts).toContainEqual(expect.stringMatching(/PDF.*rusak.*Unduh ulang/iu));
    expect(editedTexts.join("\n")).not.toContain("Maaf, terjadi kesalahan");
  });

  it("propagates deadline signals through assistant replies, typing, edits, chunks, and files", async () => {
    const calls: Array<{ method: string; signal: unknown }> = [];
    const trace = {
      requestId: "87654321-request",
      chatId: "123456",
      model: "test-model",
      inputKind: "text" as const,
      startedAt: Date.now(),
      stages: [],
      tools: [],
      inputTokens: 0,
      outputTokens: 0,
    };
    const assistantReply = vi.fn(async (...args: unknown[]) => {
      const options = args[2] as { onEvent?: (event: unknown) => void };
      options.onEvent?.({ type: "file", itemId: 7 });
      return "Jawaban panjang ".repeat(400);
    });
    const bot = createTelegramBot(
      testConfig(),
      createLogger({ LOG_LEVEL: "silent" }),
      {
        assistant: { reply: assistantReply },
        conversations: {},
        memories: {},
        vault: {
          get: vi.fn(() => ({
            id: 7,
            kind: "file",
            name: "hasil.txt",
            sizeBytes: 12,
          })),
          readFile: vi.fn(async () => ({
            id: 7,
            kind: "file",
            name: "hasil.txt",
            sizeBytes: 12,
            path: "/hasil.txt",
            bytes: Buffer.from("hasil file"),
          })),
        },
        emailRules: {},
        search: { available: false, name: "none" },
        traces: {
          start: vi.fn(() => trace),
          isLiveEnabled: vi.fn(() => false),
          addStage: vi.fn(),
          addTool: vi.fn(),
          addUsage: vi.fn(),
          finish: vi.fn(() => trace),
        },
        telegramHistory: { record: vi.fn() },
        gmailConfigured: false,
      } as never,
    );
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
    } as never;
    bot.api.config.use(async (_previous, method, _payload, signal) => {
      calls.push({ method, signal });
      return {
        ok: true,
        result:
          method === "sendChatAction"
            ? true
            : {
                message_id: calls.length + 200,
                date: 1_700_000_010,
                chat: { id: 123456, type: "private" },
                text: "ok",
              },
      } as never;
    });

    await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 110,
        date: 1_700_000_010,
        chat: { id: 123456, type: "private", first_name: "Owner" },
        from: { id: 123456, is_bot: false, first_name: "Owner" },
        text: "Tolong jawab dan kirim file",
      },
    });

    for (const method of ["sendMessage", "sendChatAction", "editMessageText", "sendDocument"]) {
      const matching = calls.filter((call) => call.method === method);
      expect(matching.length, `${method} was called`).toBeGreaterThan(0);
      expect(matching.every((call) => call.signal instanceof AbortSignal)).toBe(true);
    }
    expect(calls.filter(({ method }) => method === "sendMessage").length).toBeGreaterThan(1);
  });

  it("selects the highest-resolution Telegram photo", () => {
    const selected = selectLargestPhoto([
      { file_id: "small", width: 320, height: 200, file_size: 15_000 },
      { file_id: "large", width: 1280, height: 720, file_size: 120_000 },
      { file_id: "medium", width: 640, height: 480, file_size: 70_000 },
    ]);
    expect(selected?.file_id).toBe("large");
  });

  it("builds a supported image data URL without persisting a Telegram URL", () => {
    expect(resolveImageMimeType("image/png; charset=binary", undefined, "photo.bin")).toBe(
      "image/png",
    );
    expect(resolveImageMimeType("application/octet-stream", "image/webp", "photo.bin")).toBe(
      "image/webp",
    );
    expect(resolveImageMimeType("image/svg+xml", undefined, "photo.svg")).toBeNull();
    expect(imageBytesToDataUrl(Uint8Array.from([1, 2, 3]), "image/png")).toBe(
      "data:image/png;base64,AQID",
    );
  });

  it("extracts trackable messages from Telegram API results", () => {
    expect(
      telegramMessageReferences([
        { message_id: 7, date: 1_700_000_000, chat: { id: 42 } },
        true,
        { file_id: "not-a-message" },
      ]),
    ).toEqual([{ chatId: "42", messageId: 7, sentAt: 1_700_000_000 }]);
  });
});
