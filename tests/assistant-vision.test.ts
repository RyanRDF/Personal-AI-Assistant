import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { PersonalAssistant, type AssistantEvent } from "../src/ai/assistant.js";
import { createLogger } from "../src/logger.js";
import { ConversationService } from "../src/services/conversation.js";
import { EmailRuleService } from "../src/services/email-rules.js";
import { MemoryService } from "../src/services/memory.js";
import { temporaryDatabase, testConfig } from "./helpers.js";

function fakeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe("assistant vision input", () => {
  it("sends image data to OpenAI but stores only a non-sensitive marker", async () => {
    const { database, cleanup } = temporaryDatabase();
    try {
      const create = vi.fn().mockResolvedValue(
        fakeStream([
          { choices: [{ delta: { content: "Gambar berisi tabel." } }] },
          {
            choices: [],
            usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
          },
        ]),
      );
      const client = { chat: { completions: { create } } } as unknown as OpenAI;
      const config = testConfig({ OPENAI_CHAT_MODEL: "gpt-5-mini" });
      const conversations = new ConversationService(database);
      const events: AssistantEvent[] = [];
      const assistant = new PersonalAssistant(
        config,
        database,
        createLogger(config),
        {
          conversations,
          memories: new MemoryService(database),
          emailRules: new EmailRuleService(database),
          gmail: null,
          search: {
            name: "test",
            available: false,
            async search() {
              return [];
            },
          },
        },
        client,
      );

      const answer = await assistant.reply(
        "owner",
        {
          text: "Apa isi gambar ini?",
          images: [
            {
              dataUrl: "data:image/png;base64,AQID",
              mimeType: "image/png",
              byteLength: 3,
            },
          ],
        },
        { onEvent: (event) => events.push(event) },
      );

      expect(answer).toBe("Gambar berisi tabel.");
      const request = create.mock.calls[0]?.[0] as {
        stream: boolean;
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(request.stream).toBe(true);
      expect(request.messages.findLast((message) => message.role === "user")?.content).toEqual([
        { type: "text", text: "Apa isi gambar ini?" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AQID", detail: "auto" },
        },
      ]);
      const stored = conversations.recent("owner", 5)[0]?.content ?? "";
      expect(stored).toContain("gambar dilampirkan");
      expect(stored).not.toContain("AQID");
      expect(events).toContainEqual({ type: "usage", inputTokens: 42, outputTokens: 8 });
    } finally {
      cleanup();
    }
  });
});
