import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { PersonalAssistant } from "../src/ai/assistant.js";
import { createLogger } from "../src/logger.js";
import { ConversationService } from "../src/services/conversation.js";
import { EmailRuleService } from "../src/services/email-rules.js";
import { MemoryService } from "../src/services/memory.js";
import { VaultService } from "../src/services/vault.js";
import { temporaryDatabase, testConfig } from "./helpers.js";

function fakeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe("assistant cancellation", () => {
  it("passes the reply signal to OpenAI chat completions", async () => {
    const setup = temporaryDatabase();
    try {
      const config = testConfig();
      const controller = new AbortController();
      const create = vi.fn().mockResolvedValue(
        fakeStream([{ choices: [{ delta: { content: "Selesai." } }] }]),
      );
      const client = { chat: { completions: { create } } } as unknown as OpenAI;
      const assistant = new PersonalAssistant(
        config,
        setup.database,
        createLogger(config),
        {
          conversations: new ConversationService(setup.database),
          memories: new MemoryService(setup.database),
          vault: new VaultService(setup.database, `${setup.directory}/vault`),
          emailRules: new EmailRuleService(setup.database),
          gmail: null,
          search: { name: "test", available: false, async search() { return []; } },
        },
        client,
      );

      await expect(
        assistant.reply("owner", "Halo", { signal: controller.signal }),
      ).resolves.toBe("Selesai.");
      expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
    } finally {
      setup.cleanup();
    }
  });

  it("aborts a pending web-search tool and forwards the signal to the provider", async () => {
    const setup = temporaryDatabase();
    try {
      const config = testConfig();
      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      const search = vi.fn(
        async (_query: string, _limit?: number, signal?: AbortSignal) =>
          await new Promise<never>((_resolve, reject) => {
            receivedSignal = signal;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
      const create = vi.fn().mockResolvedValue(
        fakeStream([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-web",
                      function: { name: "search_web", arguments: '{"query":"berita terbaru"}' },
                    },
                  ],
                },
              },
            ],
          },
        ]),
      );
      const client = { chat: { completions: { create } } } as unknown as OpenAI;
      const assistant = new PersonalAssistant(
        config,
        setup.database,
        createLogger(config),
        {
          conversations: new ConversationService(setup.database),
          memories: new MemoryService(setup.database),
          vault: new VaultService(setup.database, `${setup.directory}/vault`),
          emailRules: new EmailRuleService(setup.database),
          gmail: null,
          search: { name: "test", available: true, search },
        },
        client,
      );

      const pending = assistant.reply("owner", "Cari berita terbaru", {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
      controller.abort(new DOMException("dibatalkan", "AbortError"));

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(receivedSignal).toBe(controller.signal);
    } finally {
      setup.cleanup();
    }
  });

  it("stops waiting for a pending Gmail tool when the reply is aborted", async () => {
    const setup = temporaryDatabase();
    try {
      const config = testConfig();
      const controller = new AbortController();
      const gmailSearch = vi.fn(() => new Promise<never>(() => undefined));
      const create = vi.fn().mockResolvedValue(
        fakeStream([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-gmail",
                      function: {
                        name: "search_gmail",
                        arguments: '{"query":"invoice","limit":5}',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ]),
      );
      const client = { chat: { completions: { create } } } as unknown as OpenAI;
      const assistant = new PersonalAssistant(
        config,
        setup.database,
        createLogger(config),
        {
          conversations: new ConversationService(setup.database),
          memories: new MemoryService(setup.database),
          vault: new VaultService(setup.database, `${setup.directory}/vault`),
          emailRules: new EmailRuleService(setup.database),
          gmail: { search: gmailSearch } as never,
          search: { name: "test", available: false, async search() { return []; } },
        },
        client,
      );

      const pending = assistant.reply("owner", "Cari email invoice", {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(gmailSearch).toHaveBeenCalledOnce());
      expect(gmailSearch).toHaveBeenCalledWith("invoice", 5, { signal: controller.signal });
      controller.abort(new DOMException("dibatalkan", "AbortError"));

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      setup.cleanup();
    }
  });
});
