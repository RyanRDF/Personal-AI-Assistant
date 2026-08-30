import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DuplicateVaultItemError,
  InvalidVaultOperationError,
  openVault,
  type Vault,
} from "../src/services/vault.js";
import { temporaryDatabase } from "./helpers.js";
import type { VaultObjectStorage } from "../src/services/object-storage.js";

function createFakeObjectStorage(
  remove: (key: string, objects: Map<string, Uint8Array>) => void | Promise<void> = (
    key,
    objects,
  ) => {
    objects.delete(key);
  },
): { objects: Map<string, Uint8Array>; storage: VaultObjectStorage } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    storage: {
      backend: "s3",
      async put(key, bytes) {
        objects.set(key, Uint8Array.from(bytes));
      },
      async get(key) {
        return objects.get(key) ?? new Uint8Array();
      },
      async delete(key) {
        await remove(key, objects);
      },
    },
  };
}

describe("vault storage", () => {
  let setup: ReturnType<typeof temporaryDatabase>;
  let vault: Vault;
  let storagePath: string;

  beforeEach(async () => {
    setup = temporaryDatabase();
    storagePath = path.join(setup.directory, "vault");
    vault = await openVault(setup.database, storagePath);
  });

  afterEach(() => setup.cleanup());

  function storageKeyFor(id: number): string {
    return (
      setup.database
        .prepare("SELECT storage_key FROM vault_items WHERE id = ?")
        .get(id) as { storage_key: string }
    ).storage_key;
  }

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

  it("stores and reads verified file content without exposing storage details", async () => {
    const file = await vault.saveFile({
      name: "invoice.pdf",
      mimeType: "application/pdf",
      bytes: Uint8Array.from([1, 2, 3, 4]),
    });
    const stored = await vault.readFile(file.id);

    expect(stored).not.toHaveProperty("storageBackend");
    expect(stored).not.toHaveProperty("storageKey");
    expect(stored).not.toHaveProperty("sha256");
    expect(stored).toMatchObject({
      id: file.id,
      name: "invoice.pdf",
      path: "/invoice.pdf",
      bytes: Uint8Array.from([1, 2, 3, 4]),
    });
    expect(vault.get(file.id)).not.toHaveProperty("storageBackend");
    expect(vault.list()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ storageKey: expect.anything() })]),
    );
    expect(vault.search("invoice")[0]).not.toHaveProperty("sha256");
    expect(vault.relevant("invoice", 5)[0]).not.toHaveProperty("storageBackend");
    expect(vault.stats()).toEqual({ folders: 0, files: 1, notes: 0, totalBytes: 4 });
  });

  it("stores new bytes in S3 while legacy local files remain readable", async () => {
    const { objects, storage } = createFakeObjectStorage();
    const legacy = await vault.saveFile({ name: "legacy.txt", bytes: Buffer.from("lama") });
    const bucketVault = await openVault(setup.database, storagePath, storage);
    const remote = await bucketVault.saveFile({
      name: "video.mp4",
      mimeType: "video/mp4",
      detectedMimeType: "video/mp4",
      mediaKind: "video",
      fileUniqueId: "telegram-unique",
      sourceCaption: "Bukti servis motor",
      bytes: Buffer.from("bucket"),
    });

    expect(remote).not.toHaveProperty("storageBackend");
    expect(remote).not.toHaveProperty("storageKey");
    expect(remote).not.toHaveProperty("sha256");
    expect(objects.size).toBe(1);
    expect(remote.sourceCaption).toBe("Bukti servis motor");
    expect(Buffer.from((await bucketVault.readFile(legacy.id)).bytes)).toEqual(Buffer.from("lama"));
    expect(Buffer.from((await bucketVault.readFile(remote.id)).bytes)).toEqual(Buffer.from("bucket"));
    const localWriteVault = await openVault(setup.database, storagePath, storage, "local");
    const newLocal = await localWriteVault.saveFile({
      name: "lokal-lagi.txt",
      bytes: Buffer.from("lokal"),
    });
    expect(newLocal).not.toHaveProperty("storageBackend");
    expect(objects.size).toBe(1);
    expect(Buffer.from((await localWriteVault.readFile(remote.id)).bytes)).toEqual(Buffer.from("bucket"));
    await expect(localWriteVault.delete(remote.id)).resolves.toBe(1);
    expect(objects.size).toBe(0);
  });

  it("deletes a mixed local and S3 subtree through one lifecycle", async () => {
    const { objects, storage } = createFakeObjectStorage();
    const folder = vault.createFolder("Campuran");
    const local = await vault.saveFile({
      parentId: folder.id,
      name: "lokal.txt",
      bytes: Buffer.from("lokal"),
    });
    const bucketVault = await openVault(setup.database, storagePath, storage);
    const remote = await bucketVault.saveFile({
      parentId: folder.id,
      name: "remote.txt",
      bytes: Buffer.from("remote"),
    });

    await expect(bucketVault.delete(folder.id)).resolves.toBe(3);
    expect(bucketVault.get(local.id)).toBeNull();
    expect(bucketVault.get(remote.id)).toBeNull();
    expect(objects.size).toBe(0);
  });

  it("does not delete bytes for a file moved out while folder deletion is staged", async () => {
    const folder = vault.createFolder("Sedang Dihapus");
    const file = await vault.saveFile({
      parentId: folder.id,
      name: "dipindahkan.txt",
      bytes: Buffer.from("tetap aman"),
    });

    const deletion = vault.delete(folder.id);
    vault.move(file.id, null);

    await expect(deletion).resolves.toBe(1);
    expect(vault.get(folder.id)).toBeNull();
    expect(vault.get(file.id)?.parentId).toBeNull();
    expect(Buffer.from((await vault.readFile(file.id)).bytes).toString("utf8")).toBe("tetap aman");
  });

  it("includes a file moved into a folder while deletion is staged", async () => {
    const folder = vault.createFolder("Target Hapus");
    await vault.saveFile({
      parentId: folder.id,
      name: "pemicu-staging.txt",
      bytes: Buffer.from("pemicu"),
    });
    const moved = await vault.saveFile({
      name: "masuk-saat-hapus.txt",
      bytes: Buffer.from("ikut dihapus"),
    });

    const deletion = vault.delete(folder.id);
    vault.move(moved.id, folder.id);

    await expect(deletion).resolves.toBe(3);
    expect(vault.get(folder.id)).toBeNull();
    expect(vault.get(moved.id)).toBeNull();
  });

  it("keeps a remote item intact when its adapter is unavailable", async () => {
    const { objects, storage } = createFakeObjectStorage();
    const bucketVault = await openVault(setup.database, storagePath, storage);
    const remote = await bucketVault.saveFile({ name: "tetap-remote.txt", bytes: Buffer.from("aman") });
    const localOnlyVault = await openVault(setup.database, storagePath);

    await expect(localOnlyVault.delete(remote.id)).rejects.toThrow("Backend S3");
    expect(localOnlyVault.get(remote.id)).not.toBeNull();
    expect(objects.size).toBe(1);
  });

  it("journals failed S3 cleanup and retries it during startup reconciliation", async () => {
    let failDelete = true;
    const { objects, storage } = createFakeObjectStorage((key, storedObjects) => {
      if (failDelete) throw new Error("temporary S3 failure");
      storedObjects.delete(key);
    });
    const bucketVault = await openVault(setup.database, storagePath, storage);
    const item = await bucketVault.saveFile({
      name: "bukti.mp4",
      bytes: Buffer.from("video"),
    });

    await expect(bucketVault.delete(item.id)).resolves.toBe(1);
    expect(objects.size).toBe(1);
    expect(
      (
        setup.database.prepare("SELECT count(*) AS count FROM vault_object_operations").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);

    failDelete = false;
    await openVault(setup.database, storagePath, storage);
    expect(objects.size).toBe(0);
    expect(
      (
        setup.database.prepare("SELECT count(*) AS count FROM vault_object_operations").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("removes staging and metadata when a file insert fails", async () => {
    setup.database.exec(`
      CREATE TRIGGER fail_vault_file_insert
      BEFORE INSERT ON vault_items WHEN NEW.kind = 'file'
      BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END;
    `);

    await expect(vault.saveFile({ name: "gagal.txt", bytes: Buffer.from("gagal") })).rejects.toThrow(
      "simulated insert failure",
    );

    setup.database.exec("DROP TRIGGER fail_vault_file_insert");
    expect(vault.stats().files).toBe(0);
    expect(fs.readdirSync(path.join(storagePath, ".tmp"))).toEqual([]);
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

  it("deletes nested metadata and stored file bytes", async () => {
    const folder = vault.ensureFolderPath("Arsip")!;
    const file = await vault.saveFile({
      parentId: folder.id,
      name: "lama.txt",
      bytes: Buffer.from("lama"),
    });
    await expect(vault.delete(folder.id)).resolves.toBe(2);
    expect(vault.get(file.id)).toBeNull();
    await expect(vault.readFile(file.id)).rejects.toThrow("tidak ditemukan");
  });

  it("keeps local bytes when metadata deletion fails", async () => {
    const file = await vault.saveFile({ name: "tetap.txt", bytes: Buffer.from("tetap") });
    const storedPath = path.join(storagePath, storageKeyFor(file.id));
    setup.database.exec(`
      CREATE TRIGGER fail_vault_delete
      BEFORE DELETE ON vault_items
      BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END;
    `);

    await expect(vault.delete(file.id)).rejects.toThrow("simulated delete failure");

    setup.database.exec("DROP TRIGGER fail_vault_delete");
    expect(vault.get(file.id)).not.toBeNull();
    expect(fs.readFileSync(storedPath, "utf8")).toBe("tetap");
    expect(fs.readdirSync(path.join(storagePath, ".trash"))).toEqual([]);
    expect(
      (setup.database.prepare("SELECT count(*) AS count FROM vault_fs_operations").get() as {
        count: number;
      }).count,
    ).toBe(0);
  });

  it("reconciles interrupted save and delete operations on startup", async () => {
    const saveStorageKey = randomUUID();
    const saveOperationId = randomUUID();
    const recoveredBytes = Buffer.from("dipulihkan");
    fs.writeFileSync(
      path.join(storagePath, ".tmp", saveOperationId),
      recoveredBytes,
    );
    const saveItemId = Number(
      setup.database
        .prepare(
          `INSERT INTO vault_items(kind, name, mime_type, size_bytes, storage_key, sha256)
           VALUES ('file', 'pulih.txt', 'text/plain', 10, ?, ?)`,
        )
        .run(saveStorageKey, createHash("sha256").update(recoveredBytes).digest("hex"))
        .lastInsertRowid,
    );
    setup.database
      .prepare(
        "INSERT INTO vault_fs_operations(id, operation, storage_key) VALUES (?, 'save', ?)",
      )
      .run(saveOperationId, saveStorageKey);

    const deleteItem = await vault.saveFile({ name: "batal-hapus.txt", bytes: Buffer.from("aman") });
    const deleteStorageKey = storageKeyFor(deleteItem.id);
    const deleteOperationId = randomUUID();
    const deleteFinalPath = path.join(storagePath, deleteStorageKey);
    setup.database
      .prepare(
        "INSERT INTO vault_fs_operations(id, operation, storage_key) VALUES (?, 'delete', ?)",
      )
      .run(deleteOperationId, deleteStorageKey);
    fs.renameSync(
      deleteFinalPath,
      path.join(storagePath, ".trash", deleteOperationId),
    );

    const recovered = await openVault(setup.database, storagePath);

    expect(Buffer.from((await recovered.readFile(saveItemId)).bytes).toString("utf8")).toBe("dipulihkan");
    expect(Buffer.from((await recovered.readFile(deleteItem.id)).bytes).toString("utf8")).toBe("aman");
    expect(
      (setup.database.prepare("SELECT count(*) AS count FROM vault_fs_operations").get() as {
        count: number;
      }).count,
    ).toBe(0);
  });

  it("purges trash after metadata deletion committed before cleanup", async () => {
    const file = await vault.saveFile({ name: "hapus.txt", bytes: Buffer.from("hapus") });
    const operationId = randomUUID();
    const trashPath = path.join(storagePath, ".trash", operationId);
    const storageKey = storageKeyFor(file.id);
    setup.database
      .prepare(
        "INSERT INTO vault_fs_operations(id, operation, storage_key) VALUES (?, 'delete', ?)",
      )
      .run(operationId, storageKey);
    fs.renameSync(path.join(storagePath, storageKey), trashPath);
    setup.database.prepare("DELETE FROM vault_items WHERE id = ?").run(file.id);

    await openVault(setup.database, storagePath);

    expect(fs.existsSync(trashPath)).toBe(false);
    expect(
      (setup.database.prepare("SELECT count(*) AS count FROM vault_fs_operations").get() as {
        count: number;
      }).count,
    ).toBe(0);
  });
});
