import { describe, expect, it } from "vitest";
import {
  readResponseBytesBounded,
  validateAttachment,
  type IncomingAttachment,
} from "../src/services/attachments.js";

function attachment(overrides: Partial<IncomingAttachment> = {}): IncomingAttachment {
  return {
    kind: "document",
    fileId: "telegram-file",
    fileUniqueId: "telegram-unique",
    fileName: "catatan.txt",
    claimedMimeType: "text/plain",
    ...overrides,
  };
}

describe("secure attachment ingestion", () => {
  it("accepts text documents as analyzable untrusted data", async () => {
    const result = await validateAttachment(attachment(), Buffer.from("tanggal,jumlah\n2026-08-25,12000"));
    expect(result.analysisKind).toBe("document");
    expect(result.detectedMimeType).toBe("text/plain");
  });

  it("rejects executable names and MIME-spoofed images", async () => {
    await expect(
      validateAttachment(attachment({ fileName: "invoice.exe" }), Buffer.from("MZ executable")),
    ).rejects.toThrow(/executable/iu);
    await expect(
      validateAttachment(
        attachment({ kind: "photo", fileName: "foto.jpg", claimedMimeType: "image/jpeg" }),
        Buffer.from("bukan gambar"),
      ),
    ).rejects.toThrow(/signature/iu);

    const disguisedExecutable = Buffer.alloc(256);
    disguisedExecutable.write("MZ", 0, "ascii");
    disguisedExecutable.writeUInt32LE(128, 0x3c);
    disguisedExecutable.write("PE\0\0", 128, "binary");
    await expect(
      validateAttachment(
        attachment({ fileName: "invoice.pdf", claimedMimeType: "application/pdf" }),
        disguisedExecutable,
      ),
    ).rejects.toThrow(/signature.*executable/iu);
  });

  it("accepts Telegram animated stickers only as opaque TGS data", async () => {
    const gzip = Buffer.from("1f8b0800000000000003abae050043bfa6a302000000", "hex");
    const result = await validateAttachment(
      attachment({
        kind: "sticker",
        fileName: "Sticker Telegram 7.tgs",
        claimedMimeType: "application/x-tgsticker",
      }),
      gzip,
    );
    expect(result.detectedMimeType).toBe("application/gzip");
    expect(result.analysisKind).toBe("store-only");
  });

  it("enforces the byte limit even without Content-Length", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2, 3]));
          controller.enqueue(Uint8Array.from([4, 5, 6]));
          controller.close();
        },
      }),
    );
    await expect(readResponseBytesBounded(response, 5)).rejects.toThrow(/batas/iu);
  });
});
