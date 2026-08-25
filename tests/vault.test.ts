import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DuplicateVaultItemError,
  InvalidVaultOperationError,
  VaultService,
} from "../src/services/vault.js";
import { temporaryDatabase } from "./helpers.js";
import type { VaultObjectStorage } from "../src/services/object-storage.js";

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

  it("prevalidates and rolls back every folder in an invalid nested path", () => {
    expect(() => vault.ensureFolderPath(`Baru/${"x".repeat(181)}`)).toThrow(
      InvalidVaultOperationError,
    );
    expect(vault.resolveFolderPath("Baru")).toBeNull();

    setup.database.exec(`
      CREATE TRIGGER fail_nested_folder_insert
      BEFORE INSERT ON vault_items WHEN NEW.kind = 'folder' AND NEW.name = 'Gagal'
      BEGIN SELECT RAISE(ABORT, 'simulated nested failure'); END;
    `);
    expect(() => vault.ensureFolderPath("Sementara/Gagal")).toThrow(
      "simulated nested failure",
    );
    setup.database.exec("DROP TRIGGER fail_nested_folder_insert");
    expect(vault.resolveFolderPath("Sementara")).toBeNull();
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

  it("stores new bytes in S3 while legacy local files remain readable", async () => {
    const objects = new Map<string, Uint8Array>();
    const storage: VaultObjectStorage = {
      backend: "s3",
      async put(key, bytes) { objects.set(key, Uint8Array.from(bytes)); },
      async get(key) { return objects.get(key) ?? new Uint8Array(); },
      async delete(key) { objects.delete(key); },
    };
    const bucketVault = new VaultService(setup.database, vault.storagePath, storage);
    const legacy = bucketVault.saveFile({ name: "legacy.txt", bytes: Buffer.from("lama") });
    const remote = await bucketVault.saveFileObject({
      name: "video.mp4",
      mimeType: "video/mp4",
      detectedMimeType: "video/mp4",
      mediaKind: "video",
      fileUniqueId: "telegram-unique",
      sourceCaption: "Bukti servis motor",
      bytes: Buffer.from("bucket"),
    });

    expect(legacy.storageBackend).toBe("local");
    expect(remote.storageBackend).toBe("s3");
    expect(remote.sourceCaption).toBe("Bukti servis motor");
    expect(Buffer.from(await bucketVault.fileBytes(legacy.id))).toEqual(Buffer.from("lama"));
    expect(Buffer.from(await bucketVault.fileBytes(remote.id))).toEqual(Buffer.from("bucket"));
    const localWriteVault = new VaultService(setup.database, vault.storagePath, storage, "local");
    const newLocal = await localWriteVault.saveFileObject({
      name: "lokal-lagi.txt",
      bytes: Buffer.from("lokal"),
    });
    expect(newLocal.storageBackend).toBe("local");
    expect(Buffer.from(await localWriteVault.fileBytes(remote.id))).toEqual(Buffer.from("bucket"));
    await expect(localWriteVault.deleteStored(remote.id)).resolves.toBe(1);
    expect(objects.size).toBe(0);
  });

  it("journals failed S3 cleanup and retries it during startup reconciliation", async () => {
    const objects = new Map<string, Uint8Array>();
    let failDelete = true;
    const storage: VaultObjectStorage = {
      backend: "s3",
      async put(key, bytes) { objects.set(key, Uint8Array.from(bytes)); },
      async get(key) { return objects.get(key) ?? new Uint8Array(); },
      async delete(key) {
        if (failDelete) throw new Error("temporary S3 failure");
        objects.delete(key);
      },
    };
    const bucketVault = new VaultService(setup.database, vault.storagePath, storage);
    const item = await bucketVault.saveFileObject({
      name: "bukti.mp4",
      bytes: Buffer.from("video"),
    });

    await expect(bucketVault.deleteStored(item.id)).resolves.toBe(1);
    expect(objects.size).toBe(1);
    expect(
      (setup.database.prepare("SELECT count(*) AS count FROM vault_object_operations").get() as { count: number }).count,
    ).toBe(1);

    failDelete = false;
    await bucketVault.reconcileObjectStorageOperations();
    expect(objects.size).toBe(0);
    expect(
      (setup.database.prepare("SELECT count(*) AS count FROM vault_object_operations").get() as { count: number }).count,
    ).toBe(0);
  });

  it("removes staging and metadata when a file insert fails", () => {
    setup.database.exec(`
      CREATE TRIGGER fail_vault_file_insert
      BEFORE INSERT ON vault_items WHEN NEW.kind = 'file'
      BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END;
    `);

    expect(() => vault.saveFile({ name: "gagal.txt", bytes: Buffer.from("gagal") })).toThrow(
      "simulated insert failure",
    );

    setup.database.exec("DROP TRIGGER fail_vault_file_insert");
    expect(vault.stats().files).toBe(0);
    expect(fs.readdirSync(path.join(vault.storagePath, ".tmp"))).toEqual([]);
    expect(
      (setup.database.prepare("SELECT count(*) AS count FROM vault_fs_operations").get() as {
        count: number;
      }).count,
    ).toBe(0);
  });

  it("searches note content and prevents folder cycles", () => {
    const parent = vault.ensureFolderPath("Proyek")!;
    const child = vault.ensureFolderPath("Proyek/Rahasia")!;
    vault.saveNote("Reminder", "Rapat dengan Budi hari Jumat", child.id);
    expect(vault.search("Budi")[0]?.name).toBe("Reminder");
    expect(vault.relevant("kapan rapat Budi", 5)[0]?.content).toContain("Jumat");
    expect(() => vault.move(parent.id, child.id)).toThrow(InvalidVaultOperationError);
  });

  it("appends and replaces note content idempotently", () => {
    const note = vault.saveNote("Dashboard", "username: admin");
    const addition = "URL: https://example.test/dashboard\nStatus: production";
    expect(vault.updateNote(note.id, addition, "append").content).toBe(
      `username: admin\n${addition}`,
    );
    expect(vault.updateNote(note.id, addition, "append").content).toBe(
      `username: admin\n${addition}`,
    );
    expect(vault.updateNote(note.id, "catatan pengganti", "replace").content).toBe(
      "catatan pengganti",
    );
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

  it("restores trashed bytes when metadata deletion fails", () => {
    const file = vault.saveFile({ name: "tetap.txt", bytes: Buffer.from("tetap") });
    const storedPath = vault.filePath(file.id);
    setup.database.exec(`
      CREATE TRIGGER fail_vault_delete
      BEFORE DELETE ON vault_items
      BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END;
    `);

    expect(() => vault.delete(file.id)).toThrow("simulated delete failure");

    setup.database.exec("DROP TRIGGER fail_vault_delete");
    expect(vault.get(file.id)).not.toBeNull();
    expect(fs.readFileSync(storedPath, "utf8")).toBe("tetap");
    expect(fs.readdirSync(path.join(vault.storagePath, ".trash"))).toEqual([]);
    expect(
      (setup.database.prepare("SELECT count(*) AS count FROM vault_fs_operations").get() as {
        count: number;
      }).count,
    ).toBe(0);
  });

  it("reconciles interrupted save and delete operations on startup", () => {
    const saveStorageKey = randomUUID();
    const saveOperationId = randomUUID();
    fs.writeFileSync(
      path.join(vault.storagePath, ".tmp", saveOperationId),
      Buffer.from("dipulihkan"),
    );
    const saveItemId = Number(
      setup.database
        .prepare(
          `INSERT INTO vault_items(kind, name, mime_type, size_bytes, storage_key, sha256)
           VALUES ('file', 'pulih.txt', 'text/plain', 10, ?, ?)`,
        )
        .run(saveStorageKey, "0".repeat(64)).lastInsertRowid,
    );
    setup.database
      .prepare(
        "INSERT INTO vault_fs_operations(id, operation, storage_key) VALUES (?, 'save', ?)",
      )
      .run(saveOperationId, saveStorageKey);

    const deleteItem = vault.saveFile({ name: "batal-hapus.txt", bytes: Buffer.from("aman") });
    const deleteStorageKey = deleteItem.storageKey!;
    const deleteOperationId = randomUUID();
    const deleteFinalPath = vault.filePath(deleteItem.id);
    setup.database
      .prepare(
        "INSERT INTO vault_fs_operations(id, operation, storage_key) VALUES (?, 'delete', ?)",
      )
      .run(deleteOperationId, deleteStorageKey);
    fs.renameSync(
      deleteFinalPath,
      path.join(vault.storagePath, ".trash", deleteOperationId),
    );

    const recovered = new VaultService(setup.database, vault.storagePath);

    expect(fs.readFileSync(recovered.filePath(saveItemId), "utf8")).toBe("dipulihkan");
    expect(fs.readFileSync(recovered.filePath(deleteItem.id), "utf8")).toBe("aman");
    expect(
      (setup.database.prepare("SELECT count(*) AS count FROM vault_fs_operations").get() as {
        count: number;
      }).count,
    ).toBe(0);
  });

  it("purges trash after metadata deletion committed before cleanup", () => {
    const file = vault.saveFile({ name: "hapus.txt", bytes: Buffer.from("hapus") });
    const operationId = randomUUID();
    const trashPath = path.join(vault.storagePath, ".trash", operationId);
    setup.database
      .prepare(
        "INSERT INTO vault_fs_operations(id, operation, storage_key) VALUES (?, 'delete', ?)",
      )
      .run(operationId, file.storageKey);
    fs.renameSync(vault.filePath(file.id), trashPath);
    setup.database.prepare("DELETE FROM vault_items WHERE id = ?").run(file.id);

    new VaultService(setup.database, vault.storagePath);

    expect(fs.existsSync(trashPath)).toBe(false);
    expect(
      (setup.database.prepare("SELECT count(*) AS count FROM vault_fs_operations").get() as {
        count: number;
      }).count,
    ).toBe(0);
  });
});
