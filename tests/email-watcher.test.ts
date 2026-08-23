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

  afterEach(() => {
    vi.restoreAllMocks();
    setup.cleanup();
  });

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

  it("times out a stalled notification without advancing the Gmail checkpoint", async () => {
    const config = testConfig();
    const rules = new EmailRuleService(setup.database);
    const rule = rules.create("email invoice");
    rules.queueNotification(rule.id, "queued-message", "queued notification");
    setState(setup.database, "gmail_history_id", "10");
    const gmail = {
      listNewMessageIds: vi.fn(async () => ({ messageIds: [], latestHistoryId: "11" })),
    } as unknown as GmailService;
    const classifier = { classify: vi.fn() } as unknown as EmailClassifier;
    const notifier = vi.fn(
      async () => await new Promise<void>(() => {
        // Deliberately never settles; EmailWatcher must enforce its own deadline.
      }),
    );
    const watcher = new EmailWatcher(
      config,
      setup.database,
      gmail,
      rules,
      classifier,
      notifier,
      createLogger(config),
      10,
    );

    await watcher.runOnce();

    expect(notifier).toHaveBeenCalledOnce();
    expect(getState(setup.database, "gmail_history_id")).toBe("10");
    expect(rules.pendingNotifications(config.EMAIL_MAX_RETRIES)).toHaveLength(1);
  });

  it("cancels a stalled notification during graceful shutdown", async () => {
    const config = testConfig();
    const rules = new EmailRuleService(setup.database);
    const rule = rules.create("email invoice");
    rules.queueNotification(rule.id, "queued-message", "queued notification");
    setState(setup.database, "gmail_history_id", "10");
    const gmail = {
      listNewMessageIds: vi.fn(async () => ({ messageIds: [], latestHistoryId: "11" })),
    } as unknown as GmailService;
    const classifier = { classify: vi.fn() } as unknown as EmailClassifier;
    const notifier = vi.fn(
      async () => await new Promise<void>(() => {
        // Deliberately ignores AbortSignal to exercise the local cancellation race.
      }),
    );
    const watcher = new EmailWatcher(
      config,
      setup.database,
      gmail,
      rules,
      classifier,
      notifier,
      createLogger(config),
    );

    const run = watcher.runOnce();
    await vi.waitFor(() => expect(notifier).toHaveBeenCalledOnce());
    const stopped = await Promise.race([
      watcher.stopAndWait().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    await run;

    expect(stopped).toBe(true);
    expect(getState(setup.database, "gmail_history_id")).toBe("10");
    expect(rules.pendingNotifications(config.EMAIL_MAX_RETRIES)).toHaveLength(1);
  });

  it("delivers pending notifications even when message processing will retry", async () => {
    const config = testConfig();
    const rules = new EmailRuleService(setup.database);
    const rule = rules.create("email invoice");
    rules.queueNotification(rule.id, "old-message", "queued notification");
    setState(setup.database, "gmail_history_id", "10");
    const gmail = {
      listNewMessageIds: vi.fn(async () => ({ messageIds: ["broken"], latestHistoryId: "11" })),
      getMessage: vi.fn(async () => {
        throw new Error("Gmail temporarily unavailable");
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

    expect(notifier).toHaveBeenCalledWith("queued notification", expect.any(AbortSignal));
    expect(rules.pendingNotifications(config.EMAIL_MAX_RETRIES)).toHaveLength(0);
    expect(getState(setup.database, "gmail_history_id")).toBe("10");
  });

  it("catches up from the persisted successful epoch when history expires", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    const config = testConfig();
    const rules = new EmailRuleService(setup.database);
    rules.create("email penting");
    setState(setup.database, "gmail_history_id", "100");
    setState(setup.database, "gmail_last_success_epoch", "1999999900");
    const gmail = {
      listNewMessageIds: vi.fn(async () => {
        throw { response: { status: 404 } };
      }),
      getCurrentHistoryId: vi.fn(async () => "200"),
      searchMessageIds: vi.fn(async () => ["catch-up-message"]),
      getMessage: vi.fn(async () => ({
        id: "catch-up-message",
        threadId: "catch-up-thread",
        from: "sender@example.com",
        to: "owner@example.com",
        subject: "Important",
        date: "today",
        snippet: "important",
        body: "important",
      })),
    } as unknown as GmailService;
    const classifier = {
      classify: vi.fn(async () => ({
        match: false,
        confidence: 0.1,
        reason: "not relevant",
        summary: "not relevant",
      })),
    } as unknown as EmailClassifier;
    const watcher = new EmailWatcher(
      config,
      setup.database,
      gmail,
      rules,
      classifier,
      vi.fn(async () => undefined),
      createLogger(config),
    );

    await watcher.runOnce();

    expect(gmail.searchMessageIds).toHaveBeenCalledWith(
      "after:1999999900 -in:sent -in:drafts",
      Number.POSITIVE_INFINITY,
      { signal: expect.any(AbortSignal) },
    );
    expect(classifier.classify).toHaveBeenCalledOnce();
    expect(getState(setup.database, "gmail_history_id")).toBe("200");
    expect(getState(setup.database, "gmail_last_success_epoch")).toBe("2000000000");
  });

  it("keeps the old catch-up checkpoint until transient work succeeds", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    const config = testConfig();
    const rules = new EmailRuleService(setup.database);
    rules.create("email penting");
    setState(setup.database, "gmail_history_id", "100");
    setState(setup.database, "gmail_last_success_epoch", "1999999900");
    const gmail = {
      listNewMessageIds: vi.fn(async () => {
        throw { response: { status: 404 } };
      }),
      getCurrentHistoryId: vi.fn(async () => "200"),
      searchMessageIds: vi.fn(async () => ["catch-up-message"]),
      getMessage: vi.fn(async () => ({
        id: "catch-up-message",
        threadId: "catch-up-thread",
        from: "sender@example.com",
        to: "owner@example.com",
        subject: "Important",
        date: "today",
        snippet: "important",
        body: "important",
      })),
    } as unknown as GmailService;
    const classifier = {
      classify: vi
        .fn()
        .mockRejectedValueOnce(new Error("OpenAI temporarily unavailable"))
        .mockResolvedValueOnce({
          match: false,
          confidence: 0.1,
          reason: "not relevant",
          summary: "not relevant",
        }),
    } as unknown as EmailClassifier;
    const watcher = new EmailWatcher(
      config,
      setup.database,
      gmail,
      rules,
      classifier,
      vi.fn(async () => undefined),
      createLogger(config),
    );

    await watcher.runOnce();
    expect(getState(setup.database, "gmail_history_id")).toBe("100");
    expect(getState(setup.database, "gmail_last_success_epoch")).toBe("1999999900");

    await watcher.runOnce();
    expect(gmail.searchMessageIds).toHaveBeenCalledTimes(2);
    expect(getState(setup.database, "gmail_history_id")).toBe("200");
    expect(getState(setup.database, "gmail_last_success_epoch")).toBe("2000000000");
  });

  it("uses a conservative seven-day catch-up for legacy state", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    const config = testConfig();
    const rules = new EmailRuleService(setup.database);
    setState(setup.database, "gmail_history_id", "100");
    const gmail = {
      listNewMessageIds: vi.fn(async () => {
        throw { response: { status: 404 } };
      }),
      getCurrentHistoryId: vi.fn(async () => "200"),
      searchMessageIds: vi.fn(async () => []),
    } as unknown as GmailService;
    const watcher = new EmailWatcher(
      config,
      setup.database,
      gmail,
      rules,
      { classify: vi.fn() } as unknown as EmailClassifier,
      vi.fn(async () => undefined),
      createLogger(config),
    );

    await watcher.runOnce();

    expect(gmail.searchMessageIds).toHaveBeenCalledWith(
      "after:1999395200 -in:sent -in:drafts",
      Number.POSITIVE_INFINITY,
      { signal: expect.any(AbortSignal) },
    );
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
