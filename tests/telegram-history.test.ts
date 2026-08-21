import { describe, expect, it } from "vitest";
import { TelegramHistoryService } from "../src/services/telegram-history.js";
import { temporaryDatabase } from "./helpers.js";

describe("TelegramHistoryService", () => {
  it("stores unique message references and returns only recent IDs", () => {
    const setup = temporaryDatabase();
    try {
      const history = new TelegramHistoryService(setup.database);
      history.record("owner", 10, 1_000);
      history.record("owner", 11, 2_000);
      history.record("owner", 11, 2_100);
      history.record("other", 12, 3_000);

      expect(history.recentMessageIds("owner", 1_500)).toEqual([11]);
      expect(history.recentMessageIds("owner", 500)).toEqual([11, 10]);
    } finally {
      setup.cleanup();
    }
  });

  it("forgets deleted references and prunes expired rows", () => {
    const setup = temporaryDatabase();
    try {
      const history = new TelegramHistoryService(setup.database);
      history.record("owner", 20, 1_000);
      history.record("owner", 21, 2_000);

      expect(history.forget("owner", [21])).toBe(1);
      expect(history.pruneBefore(1_500)).toBe(1);
      expect(history.recentMessageIds("owner", 0)).toEqual([]);
    } finally {
      setup.cleanup();
    }
  });
});
