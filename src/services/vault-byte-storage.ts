import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { VaultObjectStorage } from "./object-storage.js";

export type VaultStorageBackend = "local" | "s3";

export interface StoredBytesRef {
  backend: VaultStorageBackend;
  key: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface VaultByteWriteInput {
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
}

export interface StagedVaultWrite {
  ref: StoredBytesRef;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface StagedVaultDelete {
  commit(signal?: AbortSignal): Promise<void>;
  rollback(): Promise<void>;
}

export interface VaultByteStorageAdapter {
  readonly backend: VaultStorageBackend;
  stageWrite(input: VaultByteWriteInput, signal?: AbortSignal): Promise<StagedVaultWrite>;
  read(ref: StoredBytesRef, signal?: AbortSignal): Promise<Uint8Array | null>;
  stageDelete(ref: StoredBytesRef, signal?: AbortSignal): Promise<StagedVaultDelete>;
  recover(metadataExists: (storageKey: string) => boolean, signal?: AbortSignal): Promise<void>;
}

interface FilesystemOperationRow {
  id: string;
  operation: "save" | "delete";
  storage_key: string;
}

interface ObjectOperationRow {
  id: string;
  operation: "put" | "delete";
  storage_key: string;
}

type VaultOperationJournalTable = "vault_fs_operations" | "vault_object_operations";

class VaultOperationJournal<TOperation extends string> {
  constructor(
    private readonly database: Database.Database,
    private readonly table: VaultOperationJournalTable,
  ) {}

  record(id: string, operation: TOperation, key: string): void {
    this.database
      .prepare(`INSERT INTO ${this.table}(id, operation, storage_key) VALUES (?, ?, ?)`)
      .run(id, operation, key);
  }

  forget(id: string): void {
    try {
      this.database.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
    } catch {
      // Recovery is idempotent, so a completed journal row can safely remain.
    }
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[0-9a-f-]{36}$/iu.test(value)) throw new Error(`${label} tidak valid.`);
}

export class LocalVaultByteStorage implements VaultByteStorageAdapter {
  readonly backend = "local" as const;
  private readonly storagePath: string;
  private readonly temporaryPath: string;
  private readonly trashPath: string;
  private readonly journal: VaultOperationJournal<FilesystemOperationRow["operation"]>;

  constructor(private readonly database: Database.Database, storagePath: string) {
    this.journal = new VaultOperationJournal(database, "vault_fs_operations");
    this.storagePath = path.resolve(storagePath);
    this.temporaryPath = path.join(this.storagePath, ".tmp");
    this.trashPath = path.join(this.storagePath, ".trash");
    fs.mkdirSync(this.storagePath, { recursive: true });
    fs.mkdirSync(this.temporaryPath, { recursive: true });
    fs.mkdirSync(this.trashPath, { recursive: true });
  }

  async stageWrite(
    input: VaultByteWriteInput,
    signal?: AbortSignal,
  ): Promise<StagedVaultWrite> {
    signal?.throwIfAborted();
    const key = randomUUID();
    const operationId = randomUUID();
    const finalPath = this.filePath(key);
    const temporaryPath = this.operationPath("save", operationId);
    fs.writeFileSync(temporaryPath, input.bytes, { flag: "wx" });
    try {
      this.journal.record(operationId, "save", key);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // The orphan temp file is untracked and will be removed during startup recovery.
      }
      throw error;
    }
    return {
      ref: {
        backend: this.backend,
        key,
        sizeBytes: input.bytes.byteLength,
        sha256: input.sha256,
      },
      commit: async () => {
        fs.renameSync(temporaryPath, finalPath);
        this.journal.forget(operationId);
      },
      rollback: async () => {
        fs.rmSync(temporaryPath, { force: true });
        fs.rmSync(finalPath, { force: true });
        this.journal.forget(operationId);
      },
    };
  }

  async read(ref: StoredBytesRef, signal?: AbortSignal): Promise<Uint8Array | null> {
    signal?.throwIfAborted();
    const filePath = this.filePath(ref.key);
    if (!fs.existsSync(filePath)) return null;
    return new Uint8Array(await fs.promises.readFile(filePath));
  }

  async stageDelete(ref: StoredBytesRef, signal?: AbortSignal): Promise<StagedVaultDelete> {
    signal?.throwIfAborted();
    const finalPath = this.filePath(ref.key);
    if (!fs.existsSync(finalPath)) {
      return { commit: async () => undefined, rollback: async () => undefined };
    }
    const operationId = randomUUID();
    this.journal.record(operationId, "delete", ref.key);
    return {
      commit: async () => {
        fs.rmSync(finalPath, { force: true });
        this.journal.forget(operationId);
      },
      rollback: async () => this.journal.forget(operationId),
    };
  }

  async recover(
    metadataExists: (storageKey: string) => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const operations = this.database
      .prepare("SELECT id, operation, storage_key FROM vault_fs_operations ORDER BY created_at, id")
      .all() as FilesystemOperationRow[];
    for (const operation of operations) {
      signal?.throwIfAborted();
      try {
        const finalPath = this.filePath(operation.storage_key);
        const operationPath = this.operationPath(operation.operation, operation.id);
        const hasMetadata = metadataExists(operation.storage_key);
        if (operation.operation === "save") {
          if (hasMetadata) {
            if (!fs.existsSync(finalPath) && fs.existsSync(operationPath)) {
              fs.renameSync(operationPath, finalPath);
            } else if (fs.existsSync(finalPath) && fs.existsSync(operationPath)) {
              fs.rmSync(operationPath, { force: true });
            }
            if (fs.existsSync(finalPath)) this.journal.forget(operation.id);
            else if (!fs.existsSync(operationPath)) {
              this.database
                .prepare("DELETE FROM vault_items WHERE storage_key = ?")
                .run(operation.storage_key);
              this.journal.forget(operation.id);
            }
          } else {
            fs.rmSync(operationPath, { force: true });
            fs.rmSync(finalPath, { force: true });
            this.journal.forget(operation.id);
          }
          continue;
        }

        if (hasMetadata) {
          if (!fs.existsSync(finalPath) && fs.existsSync(operationPath)) {
            fs.renameSync(operationPath, finalPath);
          } else if (fs.existsSync(finalPath) && fs.existsSync(operationPath)) {
            fs.rmSync(operationPath, { force: true });
          }
          if (fs.existsSync(finalPath)) this.journal.forget(operation.id);
        } else {
          fs.rmSync(operationPath, { force: true });
          fs.rmSync(finalPath, { force: true });
          this.journal.forget(operation.id);
        }
      } catch {
        // Keep the journal row and retry after a transient filesystem condition clears.
      }
    }
    this.removeUntrackedOperationFiles(operations);
  }

  private operationPath(operation: FilesystemOperationRow["operation"], id: string): string {
    assertIdentifier(id, "ID operasi filesystem vault");
    return path.join(operation === "save" ? this.temporaryPath : this.trashPath, id);
  }

  private filePath(key: string): string {
    assertIdentifier(key, "Storage key");
    return path.join(this.storagePath, key);
  }

  private removeUntrackedOperationFiles(operations: FilesystemOperationRow[]): void {
    const trackedTemporary = new Set(
      operations.filter(({ operation }) => operation === "save").map(({ id }) => id),
    );
    const trackedTrash = new Set(
      operations.filter(({ operation }) => operation === "delete").map(({ id }) => id),
    );
    for (const [directory, tracked] of [
      [this.temporaryPath, trackedTemporary],
      [this.trashPath, trackedTrash],
    ] as const) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || tracked.has(entry.name)) continue;
        try {
          fs.rmSync(path.join(directory, entry.name), { force: true });
        } catch {
          // A later startup will retry orphan cleanup.
        }
      }
    }
    for (const entry of fs.readdirSync(this.storagePath, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.tmp$/iu.test(entry.name)) continue;
      try {
        fs.rmSync(path.join(this.storagePath, entry.name), { force: true });
      } catch {
        // Retry legacy orphan cleanup on a later startup.
      }
    }
  }
}

export class S3VaultByteStorage implements VaultByteStorageAdapter {
  readonly backend = "s3" as const;
  private readonly journal: VaultOperationJournal<ObjectOperationRow["operation"]>;

  constructor(
    private readonly database: Database.Database,
    private readonly objectStorage: VaultObjectStorage,
  ) {
    this.journal = new VaultOperationJournal(database, "vault_object_operations");
  }

  async stageWrite(
    input: VaultByteWriteInput,
    signal?: AbortSignal,
  ): Promise<StagedVaultWrite> {
    signal?.throwIfAborted();
    const key = randomUUID();
    const operationId = randomUUID();
    this.journal.record(operationId, "put", key);
    try {
      await this.objectStorage.put(key, input.bytes, input.contentType, signal);
    } catch (error) {
      await this.objectStorage
        .delete(key, signal)
        .then(() => this.journal.forget(operationId))
        .catch(() => undefined);
      throw error;
    }
    return {
      ref: {
        backend: this.backend,
        key,
        sizeBytes: input.bytes.byteLength,
        sha256: input.sha256,
      },
      commit: async () => this.journal.forget(operationId),
      rollback: async () => {
        await this.objectStorage.delete(key, signal);
        this.journal.forget(operationId);
      },
    };
  }

  async read(ref: StoredBytesRef, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    return this.objectStorage.get(ref.key, signal);
  }

  async stageDelete(ref: StoredBytesRef, signal?: AbortSignal): Promise<StagedVaultDelete> {
    signal?.throwIfAborted();
    const operationId = randomUUID();
    this.journal.record(operationId, "delete", ref.key);
    return {
      commit: async (commitSignal) => {
        await this.objectStorage.delete(ref.key, commitSignal);
        this.journal.forget(operationId);
      },
      rollback: async () => this.journal.forget(operationId),
    };
  }

  async recover(
    metadataExists: (storageKey: string) => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const operations = this.database
      .prepare("SELECT id, operation, storage_key FROM vault_object_operations ORDER BY created_at, id")
      .all() as ObjectOperationRow[];
    for (const operation of operations) {
      signal?.throwIfAborted();
      if (metadataExists(operation.storage_key)) {
        this.journal.forget(operation.id);
        continue;
      }
      try {
        await this.objectStorage.delete(operation.storage_key, signal);
        this.journal.forget(operation.id);
      } catch {
        // Keep private orphan cleanup in the journal for the next startup.
      }
    }
  }
}
