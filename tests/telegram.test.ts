import { describe, expect, it } from "vitest";
import {
  imageBytesToDataUrl,
  isOwnerPrivateChat,
  resolveImageMimeType,
  selectLargestPhoto,
  splitTelegramMessage,
} from "../src/telegram/bot.js";

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
});
