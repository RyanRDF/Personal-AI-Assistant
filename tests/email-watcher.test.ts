import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailClassifier } from "../src/ai/email-classifier.js";
import { getState, setState } from "../src/db.js";
import { createLogger } from "../src/logger.js";
import { EmailRuleService } from "../src/services/email-rules.js";
import { EmailWatcher } from "../src/services/email-watcher.js";
import type { GmailService } from "../src/services/gmail.js";
import { temporaryDatabase, testConfig } from "./helpers.js";

describe("Gmail semantic watcher", () => {
  let setup: ReturnType<typeof temporaryDatabase>;

  beforeEach(() => {
    setup = temporaryDatabase();
  });

  afterEach(() => setup.cleanup());

  it("notifies once for a semantic match and persists deduplication", async () => {
    const config = testConfig();
    const rules = new EmailRuleService(setup.database);
    rules.create("email tagihan layanan cloud");
    setState(setup.database, "gmail_history_id", "100");

    const gmail = {
      listNewMessageIds: vi.fn(async () => ({
        messageIds: ["message-1"],
        latestHistoryId: "101",
      })),
      getMessage: vi.fn(async () => ({
        id: "message-1",
        threadId: "thread-1",
        from: "Cloud Vendor <billing@example.com>",
        to: "owner@example.com",
        subject: "Your monthly statement",
        date: "19 Aug 2026",
        snippet: "Amount due",
        body: "Pembayaran jatuh tempo tanggal 25 Agustus.",
      })),
      searchMessageIds: vi.fn(async () => []),
      getCurrentHistoryId: vi.fn(async () => "101"),
    } as unknown as GmailService;
    const classifier = {
      classify: vi.fn(async () => ({
        match: true,
        confidence: 0.91,
        reason: "Merupakan tagihan layanan cloud.",
        summary: "Tagihan cloud jatuh tempo 25 Agustus.",
      })),
    } as unknown as EmailClassifier;
    const notifications: string[] = [];
    const watcher = new EmailWatcher(
      config,
      setup.database,
      gmail,
      rules,
      classifier,
      async (message) => {
        notifications.push(message);
      },
      createLogger(config),
    );

    await watcher.runOnce();
    await watcher.runOnce();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("monthly statement");
    expect(notifications[0]).toContain("thread-1");
    expect(classifier.classify).toHaveBeenCalledTimes(1);
  });

  it("creates a history baseline without replaying old mail", async () => {
    const config = testConfig();
    const rules = new EmailRuleService(setup.database);
    rules.create("email penting");
    const gmail = {
      getCurrentHistoryId: vi.fn(async () => "500"),
      listNewMessageIds: vi.fn(),
    } as unknown as GmailService;
    const classifier = { classify: vi.fn() } as unknown as EmailClassifier;
    const notifier = vi.fn(async () => undefined);
    const watcher = new EmailWatcher(
      config,
      setup.database,
      gmail,
      rules,
      classifier,
      notifier,
      createLogger(config),
    );

    await watcher.runOnce();

    expect(gmail.getCurrentHistoryId).toHaveBeenCalledOnce();
    expect(gmail.listNewMessageIds).not.toHaveBeenCalled();
    expect(notifier).not.toHaveBeenCalled();
  });

  it("retries notification when Telegram delivery fails", async () => {
    const config = testConfig();
    const rules = new EmailRuleService(setup.database);
    const rule = rules.create("email invoice");
    setState(setup.database, "gmail_history_id", "10");
    const gmail = {
      listNewMessageIds: vi.fn(async () => ({ messageIds: ["m-1"], latestHistoryId: "11" })),
      getMessage: vi.fn(async () => ({
        id: "m-1",
        threadId: "t-1",
        from: "billing@example.com",
        to: "owner@example.com",
        subject: "Invoice",
        date: "today",
        snippet: "invoice",
        body: "invoice",
      })),
      searchMessageIds: vi.fn(async () => []),
    } as unknown as GmailService;
    const classifier = {
      classify: vi.fn(async () => ({
        match: true,
        confidence: 0.99,
        reason: "invoice",
        summary: "invoice",
      })),
    } as unknown as EmailClassifier;
    const notifier = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Telegram unavailable"))
      .mockResolvedValueOnce(undefined);
    const watcher = new EmailWatcher(
      config,
      setup.database,
      gmail,
      rules,
      classifier,
      notifier,
      createLogger(config),
    );

    await watcher.runOnce();
    expect(rules.wasEvaluated(rule.id, "m-1")).toBe(true);
    expect(getState(setup.database, "gmail_history_id")).toBe("10");
    expect(rules.pendingNotifications(config.EMAIL_MAX_RETRIES)).toHaveLength(1);
    await watcher.runOnce();
    expect(notifier).toHaveBeenCalledTimes(2);
    expect(rules.wasEvaluated(rule.id, "m-1")).toBe(true);
    expect(getState(setup.database, "gmail_history_id")).toBe("11");
    expect(rules.pendingNotifications(config.EMAIL_MAX_RETRIES)).toHaveLength(0);

    const delivery = setup.database
      .prepare(
        "SELECT status, message_text FROM email_notifications WHERE rule_id = ? AND gmail_message_id = ?",
      )
      .get(rule.id, "m-1") as { status: string; message_text: string };
    expect(delivery).toEqual({ status: "sent", message_text: "[delivered]" });
  });

  it("treats a Gmail query as a semantic hint instead of a hard filter", async () => {
    const config = testConfig();
    const rules = new EmailRuleService(setup.database);
    rules.create("email yang membahas pembayaran proyek Alpha", "from:vendor@example.com");
    setState(setup.database, "gmail_history_id", "20");
    const gmail = {
      listNewMessageIds: vi.fn(async () => ({ messageIds: ["m-hint"], latestHistoryId: "21" })),
      getMessage: vi.fn(async () => ({
        id: "m-hint",
        threadId: "t-hint",
        from: "new-address@example.net",
        to: "owner@example.com",
        subject: "Pembayaran Alpha",
        date: "today",
        snippet: "pembayaran",
        body: "Pembayaran proyek Alpha sudah diterima.",
      })),
      searchMessageIds: vi.fn(async () => []),
    } as unknown as GmailService;
    const classifier = {
      classify: vi.fn(async () => ({
        match: true,
        confidence: 0.95,
        reason: "Isi email cocok secara semantik.",
        summary: "Pembayaran Alpha diterima.",
      })),
    } as unknown as EmailClassifier;
    const notifier = vi.fn(async () => undefined);
    const watcher = new EmailWatcher(
      config,
      setup.database,
      gmail,
      rules,
      classifier,
      notifier,
      createLogger(config),
    );

    await watcher.runOnce();

    expect(gmail.searchMessageIds).not.toHaveBeenCalled();
    expect(classifier.classify).toHaveBeenCalledOnce();
    expect(notifier).toHaveBeenCalledOnce();
  });

  it("dead-letters a permanently unreadable message and advances the cursor", async () => {
    const config = testConfig({ EMAIL_MAX_RETRIES: "3" });
    const rules = new EmailRuleService(setup.database);
    rules.create("email penting");
    setState(setup.database, "gmail_history_id", "30");
    const gmail = {
      listNewMessageIds: vi.fn(async () => ({ messageIds: ["broken"], latestHistoryId: "31" })),
      getMessage: vi.fn(async () => {
        throw new Error("Gmail payload is malformed");
      }),
    } as unknown as GmailService;
    const classifier = { classify: vi.fn() } as unknown as EmailClassifier;
    const notifier = vi.fn(async () => undefined);
    const watcher = new EmailWatcher(
      config,
      setup.database,
      gmail,
      rules,
      classifier,
      notifier,
      createLogger(config),
    );

    await watcher.runOnce();
    await watcher.runOnce();
    expect(getState(setup.database, "gmail_history_id")).toBe("30");
    await watcher.runOnce();

    expect(gmail.getMessage).toHaveBeenCalledTimes(3);
    expect(getState(setup.database, "gmail_history_id")).toBe("31");
    expect(rules.terminalFailureCount()).toBe(1);
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});
