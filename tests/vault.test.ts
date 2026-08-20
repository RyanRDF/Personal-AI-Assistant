import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DuplicateVaultItemError,
  InvalidVaultOperationError,
  VaultService,
} from "../src/services/vault.js";
import { temporaryDatabase } from "./helpers.js";

describe("vault storage", () => {
  let setup: ReturnType<typeof temporaryDatabase>;
  let vault: VaultService;

  beforeEach(() => {
    setup = temporaryDatabase();
    vault = new VaultService(setup.database, `${setup.directory}/vault`);
  });

  afterEach(() => setup.cleanup());

  it("creates nested folders and rejects duplicate sibling names", () => {
    const folder = vault.ensureFolderPath("Kerja/Invoice");
    expect(folder && vault.pathFor(folder.id)).toBe("/Kerja/Invoice");
    const note = vault.saveNote("Jatuh tempo", "Bayar tanggal 25", folder?.id);
    expect(vault.pathFor(note.id)).toBe("/Kerja/Invoice/Jatuh tempo");
    expect(() => vault.saveNote("jatuh TEMPO", "Duplikat", folder?.id)).toThrow(
      DuplicateVaultItemError,
    );
  });

  it("persists and returns file bytes", () => {
    const file = vault.saveFile({
      name: "invoice.pdf",
      mimeType: "application/pdf",
      bytes: Uint8Array.from([1, 2, 3, 4]),
    });
    expect(file.sha256).toHaveLength(64);
    expect(fs.readFileSync(vault.filePath(file.id))).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(vault.stats()).toEqual({ folders: 0, files: 1, notes: 0, totalBytes: 4 });
  });

  it("searches note content and prevents folder cycles", () => {
    const parent = vault.ensureFolderPath("Proyek")!;
    const child = vault.ensureFolderPath("Proyek/Rahasia")!;
    vault.saveNote("Reminder", "Rapat dengan Budi hari Jumat", child.id);
    expect(vault.search("Budi")[0]?.name).toBe("Reminder");
    expect(vault.relevant("kapan rapat Budi", 5)[0]?.content).toContain("Jumat");
    expect(() => vault.move(parent.id, child.id)).toThrow(InvalidVaultOperationError);
  });

  it("deletes nested metadata and stored file bytes", () => {
    const folder = vault.ensureFolderPath("Arsip")!;
    const file = vault.saveFile({
      parentId: folder.id,
      name: "lama.txt",
      bytes: Buffer.from("lama"),
    });
    const storedPath = vault.filePath(file.id);
    expect(vault.delete(folder.id)).toBe(2);
    expect(vault.get(file.id)).toBeNull();
    expect(fs.existsSync(storedPath)).toBe(false);
  });
});
