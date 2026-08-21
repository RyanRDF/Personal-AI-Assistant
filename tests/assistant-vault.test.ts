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

  it("reveals an explicitly requested credential note to the configured owner", async () => {
    const setup = temporaryDatabase();
    try {
      const config = testConfig();
      const vault = new VaultService(setup.database, `${setup.directory}/vault`);
      const note = vault.saveNote(
        "Railway Dashboard - admin",
        "username: owner@example.test\npassword: dummy-password",
      );
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
                        id: "call-search-note",
                        function: {
                          name: "search_vault",
                          arguments: '{"query":"Railway Dashboard admin","limit":5}',
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
                        id: "call-read-note",
                        function: {
                          name: "read_vault_note",
                          arguments: JSON.stringify({ id: note.id }),
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
                    content:
                      "Username: owner@example.test\nPassword: dummy-password",
                  },
                },
              ],
            },
          ]),
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
        String(config.TELEGRAM_ALLOWED_USER_ID),
        "Tolong tampilkan akun dan password dashboard Railway yang saya simpan.",
        { onEvent: (event) => events.push(event) },
      );

      expect(answer).toContain("owner@example.test");
      expect(answer).toContain("dummy-password");
      expect(events).not.toContainEqual({ type: "file", itemId: note.id });
      expect(create).toHaveBeenCalledTimes(3);
      const revealRequest = create.mock.calls[2]?.[0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(revealRequest.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          content: expect.stringContaining('"read":true'),
        }),
      );
    } finally {
      setup.cleanup();
    }
  });

  it("stores a bare dashboard URL directly in the related vault note", async () => {
    const setup = temporaryDatabase();
    try {
      const config = testConfig();
      const vault = new VaultService(setup.database, `${setup.directory}/vault`);
      const note = vault.saveNote("Railway Dashboard - admin", "username: admin");
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
                        id: "call-write-note",
                        function: {
                          name: "write_vault_note",
                          arguments: JSON.stringify({
                            operation: "append",
                            id: note.id,
                            name: null,
                            content:
                              "https://personal-ai-assistant-production-88a2.up.railway.app",
                            folder: null,
                          }),
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
                    content:
                      "Sudah disimpan: https://personal-ai-assistant-production-88a2.up.railway.app",
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
          vault,
          emailRules: new EmailRuleService(setup.database),
          gmail: null,
          search: { name: "test", available: false, async search() { return []; } },
        },
        client,
      );

      const answer = await assistant.reply(
        String(config.TELEGRAM_ALLOWED_USER_ID),
        "personal-ai-assistant-production-88a2.up.railway.app\nTolong simpen ini sebagai link untuk ke dashboard railway",
      );

      const stored = vault.get(note.id);
      expect(stored?.content).toBe(
        "username: admin\nhttps://personal-ai-assistant-production-88a2.up.railway.app",
      );
      expect(answer).toBe(
        "Sudah disimpan: https://personal-ai-assistant-production-88a2.up.railway.app",
      );
      expect(create).toHaveBeenCalledTimes(2);
      const followupRequest = create.mock.calls[1]?.[0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(followupRequest.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          content: expect.stringContaining('"operation":"append"'),
        }),
      );
    } finally {
      setup.cleanup();
    }
  });

  it("creates a general note from a direct everyday request", async () => {
    const setup = temporaryDatabase();
    try {
      const config = testConfig();
      const vault = new VaultService(setup.database, `${setup.directory}/vault`);
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
                        id: "call-create-note",
                        function: {
                          name: "write_vault_note",
                          arguments: JSON.stringify({
                            operation: "create",
                            id: null,
                            name: "Daftar belanja",
                            content: "Susu\nRoti",
                            folder: null,
                          }),
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
          fakeStream([{ choices: [{ delta: { content: "Daftar belanja sudah disimpan." } }] }]),
        );
      const client = { chat: { completions: { create } } } as unknown as OpenAI;
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
        String(config.TELEGRAM_ALLOWED_USER_ID),
        "Tolong simpan daftar belanja: susu dan roti.",
      );

      expect(answer).toBe("Daftar belanja sudah disimpan.");
      expect(vault.search("susu", 5)[0]).toEqual(
        expect.objectContaining({ name: "Daftar belanja", content: "Susu\nRoti" }),
      );
    } finally {
      setup.cleanup();
    }
  });
});
