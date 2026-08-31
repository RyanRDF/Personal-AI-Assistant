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

  it("keeps a truncated Telegram PDF as stored-only data", async () => {
    const truncatedPdf = Buffer.from("%PDF-1.4\n1 0 obj\n");

    const result = await validateAttachment(
      attachment({
        fileName: "sertifikat.pdf",
        claimedMimeType: "application/pdf",
      }),
      truncatedPdf,
    );

    expect(result.analysisKind).toBe("store-only");
    expect(result.analysisWarning).toMatch(/PDF.*(?:rusak|tidak lengkap).*tersimpan/iu);
  });

  it("accepts a PDF envelope with startxref and EOF markers", async () => {
    const completePdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n9\n%%EOF\n",
    );

    const result = await validateAttachment(
      attachment({ fileName: "sertifikat.pdf", claimedMimeType: "application/pdf" }),
      completePdf,
    );

    expect(result.analysisKind).toBe("document");
    expect(result.detectedMimeType).toBe("application/pdf");
  });

  it.each([
    ["laporan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word/document.xml"],
    ["anggaran.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xl/workbook.xml"],
    ["presentasi.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "ppt/presentation.xml"],
    ["catatan.odt", "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.text"],
    ["data.ods", "application/vnd.oasis.opendocument.spreadsheet", "application/vnd.oasis.opendocument.spreadsheet"],
    ["paparan.odp", "application/vnd.oasis.opendocument.presentation", "application/vnd.oasis.opendocument.presentation"],
  ])("accepts a genuine Office package named %s", async (fileName, mimeType, packageMarker) => {
    const officePackage = Buffer.concat([
      Buffer.from("504b0304", "hex"),
      Buffer.from(`[Content_Types].xml META-INF/manifest.xml mimetype${packageMarker}`),
    ]);

    const result = await validateAttachment(
      attachment({ fileName, claimedMimeType: mimeType }),
      officePackage,
    );

    expect(result.analysisKind).toBe("document");
    expect(result.detectedMimeType).toBe(mimeType);
  });

  it("rejects a generic ZIP renamed as an Office document", async () => {
    const renamedArchive = Buffer.concat([
      Buffer.from("504b0304", "hex"),
      Buffer.from("photos/image.jpg"),
    ]);

    await expect(
      validateAttachment(
        attachment({
          fileName: "arsip.docx",
          claimedMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
        renamedArchive,
      ),
    ).rejects.toThrow(/arsip.*zip bomb/iu);
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
