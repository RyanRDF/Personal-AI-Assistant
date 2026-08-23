import type Database from "better-sqlite3";
import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { EmailClassifier } from "../src/ai/email-classifier.js";
import type { EmailRule, GmailMessage } from "../src/types.js";
import { testConfig } from "./helpers.js";

const rule: EmailRule = {
  id: 1,
  description: "email tagihan",
  gmailQuery: null,
  enabled: true,
  createdAt: "2026-08-22 00:00:00",
};

const message: GmailMessage = {
  id: "m-1",
  threadId: "t-1",
  from: "billing@example.com",
  to: "owner@example.com",
  subject: "Invoice",
  date: "22 Aug 2026",
  snippet: "Invoice due",
  body: "Please pay this invoice.",
};

describe("EmailClassifier deadlines", () => {
  it("aborts a classification at the configured deadline", async () => {
    const create = vi.fn(
      (_body: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;
    const classifier = new EmailClassifier(
      client,
      testConfig({ EMAIL_CLASSIFIER_TIMEOUT_SECONDS: "1" }),
      {} as Database.Database,
    );

    const classification = classifier.classify(rule, message);
    const rejection = expect(classification).rejects.toMatchObject({ name: "TimeoutError" });

    await rejection;
    expect(create.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it("combines a caller cancellation signal with the deadline", async () => {
    let requestSignal: AbortSignal | undefined;
    const create = vi.fn(
      (_body: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          requestSignal = options.signal;
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const classifier = new EmailClassifier(
      { chat: { completions: { create } } } as unknown as OpenAI,
      testConfig(),
      {} as Database.Database,
    );
    const controller = new AbortController();

    const classification = classifier.classify(rule, message, controller.signal);
    const rejection = expect(classification).rejects.toThrow("shutdown");
    controller.abort(new Error("shutdown"));

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });
});
