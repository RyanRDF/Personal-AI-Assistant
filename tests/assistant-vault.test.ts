import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { PersonalAssistant, type AssistantEvent } from "../src/ai/assistant.js";
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

describe("assistant vault tools", () => {
  it("searches and queues a stored file for the Telegram adapter", async () => {
    const setup = temporaryDatabase();
    try {
      const config = testConfig();
      const vault = new VaultService(setup.database, `${setup.directory}/vault`);
      const file = vault.saveFile({ name: "invoice-agustus.pdf", bytes: Buffer.from("pdf") });
      const create = vi
        .fn()
        .mockResolvedValueOnce(
          fakeStream([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-search",
                        function: {
                          name: "search_vault",
                          arguments: '{"query":"invoice agustus","limit":5}',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ]),
        )
        .mockResolvedValueOnce(
          fakeStream([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-return",
                        function: {
                          name: "return_vault_file",
                          arguments: JSON.stringify({ id: file.id }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ]),
        )
        .mockResolvedValueOnce(
          fakeStream([{ choices: [{ delta: { content: "File invoice sudah saya kirim." } }] }]),
        );
      const client = { chat: { completions: { create } } } as unknown as OpenAI;
      const events: AssistantEvent[] = [];
      const assistant = new PersonalAssistant(
        config,
        setup.database,
        createLogger(config),
        {
          conversations: new ConversationService(setup.database),
          memories: new MemoryService(setup.database),
          vault,
          emailRules: new EmailRuleService(setup.database),
          gmail: null,
          search: { name: "test", available: false, async search() { return []; } },
        },
        client,
      );

      const answer = await assistant.reply(
        "owner",
        "Tolong carikan dan kirim file invoice Agustus dari vault.",
        { onEvent: (event) => events.push(event) },
      );

      expect(answer).toBe("File invoice sudah saya kirim.");
      expect(events).toContainEqual({ type: "file", itemId: file.id });
      expect(create).toHaveBeenCalledTimes(3);
    } finally {
      setup.cleanup();
    }
  });
});
