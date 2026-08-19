import { describe, expect, it } from "vitest";
import { isOwnerPrivateChat, splitTelegramMessage } from "../src/telegram/bot.js";

describe("Telegram safety and formatting", () => {
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
});
