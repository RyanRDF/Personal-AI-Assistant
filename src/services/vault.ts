import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  VaultItem,
  VaultItemKind,
  VaultStats,
} from "../types.js";
import type { VaultObjectStorage } from "./object-storage.js";
import {
  LocalVaultByteStorage,
  S3VaultByteStorage,
  type StagedVaultDelete,
  type StoredBytesRef,
  type VaultByteStorageAdapter,
  type VaultStorageBackend,
} from "./vault-byte-storage.js";

interface VaultRow {
  id: number;
  parent_id: number | null;
  kind: VaultItemKind;
  name: string;
  mime_type: string | null;
  size_bytes: number;
  storage_key: string | null;
  storage_backend: VaultStorageBackend;
  detected_mime_type: string | null;
  media_kind: string | null;
  source_file_unique_id: string | null;
  source_caption: string | null;
  content: string | null;
  sha256: string | null;
  source_chat_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
}

interface StoredVaultItem extends VaultItem {
  storageKey: string | null;
  storageBackend: VaultStorageBackend;
  sha256: string | null;
}

interface VaultDeleteSnapshotRow {
  id: number;
  storage_key: string | null;
  storage_backend: VaultStorageBackend;
  size_bytes: number;
  sha256: string | null;
}

interface VaultDeleteSnapshot {
  rows: VaultDeleteSnapshotRow[];
  refs: StoredBytesRef[];
}

class VaultDeleteSnapshotChangedError extends Error {}

const VAULT_DELETE_MAX_ATTEMPTS = 3;

export interface VaultSource {
  chatId?: string;
  messageId?: string;
}

export interface SaveVaultFileInput extends VaultSource {
  parentId?: number | null;
  name: string;
  mimeType?: string | null;
  detectedMimeType?: string | null;
  mediaKind?: string | null;
  fileUniqueId?: string | null;
  sourceCaption?: string | null;
  bytes: Uint8Array;
}

export type VaultFile = Omit<VaultItem, "kind"> & {
  kind: "file";
  path: string;
};

export type VaultFileContent = VaultFile & {
  bytes: Uint8Array;
};

export interface VaultFileLifecycle {
  saveFile(input: SaveVaultFileInput, signal?: AbortSignal): Promise<VaultFile>;
  readFile(id: number, signal?: AbortSignal): Promise<VaultFileContent>;
  delete(id: number, signal?: AbortSignal): Promise<number>;
}

export interface Vault extends VaultFileLifecycle {
  get(id: number): VaultItem | null;
  list(parentId?: number | null): VaultItem[];
  findDuplicateName(name: string, parentId: number | null, exceptId?: number): VaultItem | null;
  createFolder(name: string, parentId?: number | null): VaultItem;
  ensureFolderPath(folderPath: string): VaultItem | null;
  resolveFolderPath(folderPath: string): VaultItem | null;
  saveNote(
    name: string,
    content: string,
    parentId?: number | null,
    source?: VaultSource,
  ): VaultItem;
  updateNote(id: number, content: string, mode: "append" | "replace"): VaultItem;
  rename(id: number, name: string): VaultItem;
  move(id: number, parentId: number | null): VaultItem;
  search(query: string, limit?: number): VaultItem[];
  relevant(query: string, limit: number): VaultItem[];
  stats(): VaultStats;
  pathFor(id: number): string;
}

export class DuplicateVaultItemError extends Error {
  constructor(public readonly existing: VaultItem) {
    super(`Nama \"${existing.name}\" sudah dipakai di folder ini.`);
    this.name = "DuplicateVaultItemError";
  }
}

export class InvalidVaultOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVaultOperationError";
  }
}

function mapStoredRow(row: VaultRow): StoredVaultItem {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storageKey: row.storage_key,
    storageBackend: row.storage_backend,
    detectedMimeType: row.detected_mime_type,
    mediaKind: row.media_kind,
    sourceFileUniqueId: row.source_file_unique_id,
    sourceCaption: row.source_caption,
    content: row.content,
    sha256: row.sha256,
    sourceChatId: row.source_chat_id,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVaultItem(item: StoredVaultItem): VaultItem {
  const {
    storageKey: _storageKey,
    storageBackend: _storageBackend,
    sha256: _sha256,
    ...publicItem
  } = item;
  return publicItem;
}

export function normalizeVaultName(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized === "." || normalized === "..") {
    throw new InvalidVaultOperationError("Nama item tidak boleh kosong.");
  }
  if (normalized.length > 180) {
    throw new InvalidVaultOperationError("Nama item maksimal 180 karakter.");
  }
  if (/[\\/\u0000-\u001f]/u.test(normalized)) {
    throw new InvalidVaultOperationError("Nama item tidak boleh berisi slash atau karakter kontrol.");
  }
  return normalized;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function noteTerms(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase("id-ID")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/u)
      .filter((term) => term.length >= 3),
  );
}

function relevance(query: string, item: VaultItem): number {
  const queryTerms = noteTerms(query);
  if (queryTerms.size === 0) return 0;
  const itemTerms = noteTerms(`${item.name} ${item.content ?? ""} ${item.sourceCaption ?? ""}`);
  let overlap = 0;
  for (const term of queryTerms) if (itemTerms.has(term)) overlap += 1;
  return overlap / queryTerms.size;
}

class VaultService implements Vault {
  private readonly storageAdapters = new Map<VaultStorageBackend, VaultByteStorageAdapter>();

  private constructor(
    private readonly database: Database.Database,
    storagePath: string,
    objectStorage: VaultObjectStorage | null,
    private readonly writeBackend: VaultStorageBackend,
  ) {
    if (writeBackend === "s3" && !objectStorage) {
      throw new InvalidVaultOperationError("Backend penulisan S3 dipilih tanpa konfigurasi object storage.");
    }
    const localStorage = new LocalVaultByteStorage(database, storagePath);
    this.storageAdapters.set(localStorage.backend, localStorage);
    if (objectStorage) {
      const s3Storage = new S3VaultByteStorage(database, objectStorage);
      this.storageAdapters.set(s3Storage.backend, s3Storage);
    }
  }

  static async open(
    database: Database.Database,
    storagePath: string,
    objectStorage: VaultObjectStorage | null = null,
    writeBackend: VaultStorageBackend = objectStorage ? "s3" : "local",
    signal?: AbortSignal,
  ): Promise<VaultService> {
    signal?.throwIfAborted();
    const vault = new VaultService(database, storagePath, objectStorage, writeBackend);
    await vault.recoverStorageOperations(signal);
    return vault;
  }

  get(id: number): VaultItem | null {
    const item = this.getStored(id);
    return item ? toVaultItem(item) : null;
  }

  private getStored(id: number): StoredVaultItem | null {
    const row = this.database.prepare("SELECT * FROM vault_items WHERE id = ?").get(id) as
      | VaultRow
      | undefined;
    return row ? mapStoredRow(row) : null;
  }

  list(parentId: number | null = null): VaultItem[] {
    const rows = (parentId === null
      ? this.database
          .prepare(
            `SELECT * FROM vault_items WHERE parent_id IS NULL
             ORDER BY CASE kind WHEN 'folder' THEN 0 WHEN 'note' THEN 1 ELSE 2 END, lower(name)`,
          )
          .all()
      : this.database
          .prepare(
            `SELECT * FROM vault_items WHERE parent_id = ?
             ORDER BY CASE kind WHEN 'folder' THEN 0 WHEN 'note' THEN 1 ELSE 2 END, lower(name)`,
          )
          .all(parentId)) as VaultRow[];
    return rows.map((row) => toVaultItem(mapStoredRow(row)));
  }

  findDuplicateName(name: string, parentId: number | null, exceptId?: number): VaultItem | null {
    const normalized = normalizeVaultName(name);
    const row = this.database
      .prepare(
        `SELECT * FROM vault_items
         WHERE lower(name) = lower(?)
           AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)
           AND (? IS NULL OR id != ?)
         LIMIT 1`,
      )
      .get(normalized, parentId, parentId, exceptId ?? null, exceptId ?? null) as
      | VaultRow
      | undefined;
    return row ? toVaultItem(mapStoredRow(row)) : null;
  }

  createFolder(name: string, parentId: number | null = null): VaultItem {
    this.assertFolder(parentId);
    const normalized = normalizeVaultName(name);
    const duplicate = this.findDuplicateName(normalized, parentId);
    if (duplicate) throw new DuplicateVaultItemError(duplicate);
    const result = this.database
      .prepare("INSERT INTO vault_items(parent_id, kind, name) VALUES (?, 'folder', ?)")
      .run(parentId, normalized);
    return this.get(Number(result.lastInsertRowid))!;
  }

  ensureFolderPath(folderPath: string): VaultItem | null {
    const parts = folderPath
      .split(/[\\/]+/u)
      .map((part) => part.trim())
      .filter(Boolean);
    const normalizedParts = parts.map(normalizeVaultName);
    return this.database.transaction(() => {
      let parentId: number | null = null;
      let current: VaultItem | null = null;
      for (const normalized of normalizedParts) {
        const existing = this.findDuplicateName(normalized, parentId);
        if (existing && existing.kind !== "folder") {
          throw new InvalidVaultOperationError(
            `\"${normalized}\" sudah dipakai oleh ${existing.kind}, bukan folder.`,
          );
        }
        current = existing ?? this.createFolder(normalized, parentId);
        parentId = current.id;
      }
      return current;
    })();
  }

  resolveFolderPath(folderPath: string): VaultItem | null {
    const parts = folderPath
      .split(/[\\/]+/u)
      .map((part) => part.trim())
      .filter(Boolean);
    let parentId: number | null = null;
    let current: VaultItem | null = null;
    for (const part of parts) {
      const item = this.findDuplicateName(part, parentId);
      if (!item || item.kind !== "folder") return null;
      current = item;
      parentId = item.id;
    }
    return current;
  }

  saveNote(
    name: string,
    content: string,
    parentId: number | null = null,
    source: VaultSource = {},
  ): VaultItem {
    this.assertFolder(parentId);
    const normalizedName = normalizeVaultName(name);
    const normalizedContent = content.trim();
    if (!normalizedContent) throw new InvalidVaultOperationError("Isi catatan tidak boleh kosong.");
    if (normalizedContent.length > 10_000) {
      throw new InvalidVaultOperationError("Isi catatan maksimal 10.000 karakter.");
    }
    const duplicate = this.findDuplicateName(normalizedName, parentId);
    if (duplicate) throw new DuplicateVaultItemError(duplicate);
    const result = this.database
      .prepare(
        `INSERT INTO vault_items(
           parent_id, kind, name, content, size_bytes, source_chat_id, source_message_id
         ) VALUES (?, 'note', ?, ?, ?, ?, ?)`,
      )
      .run(
        parentId,
        normalizedName,
        normalizedContent,
        Buffer.byteLength(normalizedContent, "utf8"),
        source.chatId ?? null,
        source.messageId ?? null,
      );
    return this.get(Number(result.lastInsertRowid))!;
  }

  updateNote(id: number, content: string, mode: "append" | "replace"): VaultItem {
    const item = this.requireItem(id);
    if (item.kind !== "note") {
      throw new InvalidVaultOperationError(`Item vault ${id} bukan note.`);
    }
    const normalizedContent = content.trim();
    if (!normalizedContent) throw new InvalidVaultOperationError("Isi catatan tidak boleh kosong.");
    const currentContent = item.content ?? "";
    const alreadyPresent =
      currentContent === normalizedContent ||
      currentContent.startsWith(`${normalizedContent}\n`) ||
      currentContent.endsWith(`\n${normalizedContent}`) ||
      currentContent.includes(`\n${normalizedContent}\n`);
    if (mode === "append" && alreadyPresent) return item;
    const updatedContent =
      mode === "replace"
        ? normalizedContent
        : currentContent
          ? `${currentContent}\n${normalizedContent}`
          : normalizedContent;
    if (updatedContent.length > 10_000) {
      throw new InvalidVaultOperationError("Isi catatan maksimal 10.000 karakter.");
    }
    if (updatedContent === currentContent) return item;
    this.database
      .prepare(
        `UPDATE vault_items
         SET content = ?, size_bytes = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(updatedContent, Buffer.byteLength(updatedContent, "utf8"), id);
    return this.get(id)!;
  }

  private async saveStoredFile(
    input: SaveVaultFileInput,
    signal?: AbortSignal,
  ): Promise<StoredVaultItem> {
    signal?.throwIfAborted();
    const parentId = input.parentId ?? null;
    this.assertFolder(parentId);
    const name = normalizeVaultName(input.name);
    const duplicate = this.findDuplicateName(name, parentId);
    if (duplicate) throw new DuplicateVaultItemError(duplicate);
    const bytes = Buffer.from(input.bytes);
    const mimeType = input.mimeType ?? "application/octet-stream";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const staged = await this.storageAdapter(this.writeBackend).stageWrite(
      { bytes, contentType: mimeType, sha256 },
      signal,
    );
    let itemId: number | null = null;
    try {
      signal?.throwIfAborted();
      const result = this.database
        .prepare(
          `INSERT INTO vault_items(
             parent_id, kind, name, mime_type, size_bytes, storage_key, storage_backend,
             detected_mime_type, media_kind, source_file_unique_id, source_caption, sha256,
             source_chat_id, source_message_id
           ) VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parentId,
          name,
          mimeType,
          staged.ref.sizeBytes,
          staged.ref.key,
          staged.ref.backend,
          input.detectedMimeType ?? null,
          input.mediaKind ?? null,
          input.fileUniqueId ?? null,
          input.sourceCaption?.trim().slice(0, 2_000) ?? null,
          staged.ref.sha256,
          input.chatId ?? null,
          input.messageId ?? null,
        );
      itemId = Number(result.lastInsertRowid);
      await staged.commit();
      return this.requireStoredItem(itemId);
    } catch (error) {
      if (itemId !== null) {
        try {
          this.database.prepare("DELETE FROM vault_items WHERE id = ?").run(itemId);
        } catch {
          // Preserve staged bytes and journal if metadata compensation cannot complete.
        }
      }
      try {
        if (!this.hasStorageMetadata(staged.ref.key)) await staged.rollback();
      } catch {
        // Recovery completes or compensates any remaining staged operation.
      }
      throw error;
    }
  }

  async saveFile(input: SaveVaultFileInput, signal?: AbortSignal): Promise<VaultFile> {
    signal?.throwIfAborted();
    if (input.bytes.byteLength === 0) {
      throw new InvalidVaultOperationError("File kosong tidak dapat disimpan.");
    }
    const item = await this.saveStoredFile({ ...input, bytes: Uint8Array.from(input.bytes) }, signal);
    return this.toVaultFile(item);
  }

  rename(id: number, name: string): VaultItem {
    const item = this.requireItem(id);
    const normalized = normalizeVaultName(name);
    const duplicate = this.findDuplicateName(normalized, item.parentId, item.id);
    if (duplicate) throw new DuplicateVaultItemError(duplicate);
    this.database
      .prepare("UPDATE vault_items SET name = ?, updated_at = datetime('now') WHERE id = ?")
      .run(normalized, id);
    return this.requireItem(id);
  }

  move(id: number, parentId: number | null): VaultItem {
    const item = this.requireItem(id);
    this.assertFolder(parentId);
    if (item.id === parentId) {
      throw new InvalidVaultOperationError("Folder tidak dapat dipindahkan ke dirinya sendiri.");
    }
    if (item.kind === "folder" && parentId !== null && this.isDescendant(parentId, item.id)) {
      throw new InvalidVaultOperationError("Folder tidak dapat dipindahkan ke dalam turunannya.");
    }
    const duplicate = this.findDuplicateName(item.name, parentId, item.id);
    if (duplicate) throw new DuplicateVaultItemError(duplicate);
    this.database
      .prepare("UPDATE vault_items SET parent_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(parentId, id);
    return this.requireItem(id);
  }

  async delete(id: number, signal?: AbortSignal): Promise<number> {
    for (let attempt = 1; attempt <= VAULT_DELETE_MAX_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      const snapshot = this.deleteSnapshot(id);
      for (const ref of snapshot.refs) {
        if (!this.storageAdapters.has(ref.backend)) {
          throw new InvalidVaultOperationError("Backend S3 belum dikonfigurasi; item tidak dihapus.");
        }
      }

      const staged: StagedVaultDelete[] = [];
      try {
        for (const ref of snapshot.refs) {
          staged.push(await this.storageAdapter(ref.backend).stageDelete(ref, signal));
        }
        this.database.transaction(() => {
          const currentSnapshot = this.deleteSnapshot(id);
          if (!this.sameDeleteSnapshot(snapshot, currentSnapshot)) {
            throw new VaultDeleteSnapshotChangedError(
              "Isi folder berubah ketika penghapusan sedang disiapkan.",
            );
          }
          this.database.prepare("DELETE FROM vault_items WHERE id = ?").run(id);
        })();
      } catch (error) {
        let rollbackFailed = false;
        for (const operation of [...staged].reverse()) {
          try {
            await operation.rollback();
          } catch {
            rollbackFailed = true;
            // The adapter journal retains enough state for startup recovery.
          }
        }
        if (error instanceof VaultDeleteSnapshotChangedError && !rollbackFailed) {
          if (attempt < VAULT_DELETE_MAX_ATTEMPTS) continue;
          throw new InvalidVaultOperationError(
            "Isi folder terus berubah; penghapusan belum dilakukan. Silakan coba lagi.",
          );
        }
        throw error;
      }
      await Promise.allSettled(staged.map((operation) => operation.commit(signal)));
      return snapshot.rows.length;
    }
    throw new InvalidVaultOperationError("Penghapusan vault tidak dapat diselesaikan.");
  }

  search(query: string, limit = 30): VaultItem[] {
    const normalized = query.trim();
    if (!normalized) return [];
    const pattern = `%${escapeLike(normalized)}%`;
    const rows = this.database
      .prepare(
        `SELECT * FROM vault_items
          WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE
             OR content LIKE ? ESCAPE '\\' COLLATE NOCASE
             OR source_caption LIKE ? ESCAPE '\\' COLLATE NOCASE
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(pattern, pattern, pattern, limit) as VaultRow[];
    return rows.map((row) => toVaultItem(mapStoredRow(row)));
  }

  relevant(query: string, limit: number): VaultItem[] {
    const candidates = this.database
      .prepare(
        `SELECT * FROM vault_items WHERE kind IN ('note', 'file')
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(Math.max(limit * 10, 100)) as VaultRow[];
    return candidates
      .map((row, index) => {
        const item = toVaultItem(mapStoredRow(row));
        return { item, score: relevance(query, item), index };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, limit)
      .map(({ item }) => item);
  }

  stats(): VaultStats {
    const row = this.database
      .prepare(
        `SELECT
           sum(CASE WHEN kind = 'folder' THEN 1 ELSE 0 END) AS folders,
           sum(CASE WHEN kind = 'file' THEN 1 ELSE 0 END) AS files,
           sum(CASE WHEN kind = 'note' THEN 1 ELSE 0 END) AS notes,
           sum(CASE WHEN kind = 'file' THEN size_bytes ELSE 0 END) AS total_bytes
         FROM vault_items`,
      )
      .get() as { folders: number | null; files: number | null; notes: number | null; total_bytes: number | null };
    return {
      folders: row.folders ?? 0,
      files: row.files ?? 0,
      notes: row.notes ?? 0,
      totalBytes: row.total_bytes ?? 0,
    };
  }

  pathFor(id: number): string {
    const names: string[] = [];
    let item: VaultItem | null = this.requireItem(id);
    const visited = new Set<number>();
    while (item) {
      if (visited.has(item.id)) throw new InvalidVaultOperationError("Struktur folder tidak valid.");
      visited.add(item.id);
      names.unshift(item.name);
      item = item.parentId === null ? null : this.get(item.parentId);
    }
    return `/${names.join("/")}`;
  }

  async readFile(id: number, signal?: AbortSignal): Promise<VaultFileContent> {
    signal?.throwIfAborted();
    const item = this.requireStoredItem(id);
    if (item.kind !== "file" || !item.storageKey) {
      throw new InvalidVaultOperationError(`Item vault ${id} bukan file.`);
    }
    const ref: StoredBytesRef = {
      backend: item.storageBackend,
      key: item.storageKey,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
    };
    const storedBytes = await this.storageAdapter(ref.backend).read(ref, signal);
    if (!storedBytes) throw new InvalidVaultOperationError("Byte file tidak ditemukan.");
    const bytes = Uint8Array.from(storedBytes);
    if (bytes.byteLength !== item.sizeBytes) {
      throw new InvalidVaultOperationError("Ukuran byte file tidak cocok dengan metadata vault.");
    }
    if (item.sha256) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== item.sha256) {
        throw new InvalidVaultOperationError("Checksum file tidak cocok dengan metadata vault.");
      }
    }
    return { ...this.toVaultFile(item), bytes };
  }

  private toVaultFile(item: StoredVaultItem): VaultFile {
    if (item.kind !== "file") {
      throw new InvalidVaultOperationError(`Item vault ${item.id} bukan file.`);
    }
    return { ...toVaultItem(item), kind: "file", path: this.pathFor(item.id) };
  }

  private hasStorageMetadata(storageKey: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM vault_items WHERE storage_key = ? LIMIT 1")
        .get(storageKey),
    );
  }

  private deleteSnapshot(id: number): VaultDeleteSnapshot {
    const item = this.requireStoredItem(id);
    const rows = (item.kind === "folder"
      ? this.database
          .prepare(
            `WITH RECURSIVE descendants(id) AS (
               SELECT id FROM vault_items WHERE id = ?
               UNION ALL
               SELECT child.id FROM vault_items child JOIN descendants parent ON child.parent_id = parent.id
             )
             SELECT id, storage_key, storage_backend, size_bytes, sha256
             FROM vault_items WHERE id IN descendants ORDER BY id`,
          )
          .all(id)
      : [
          {
            id: item.id,
            storage_key: item.storageKey,
            storage_backend: item.storageBackend,
            size_bytes: item.sizeBytes,
            sha256: item.sha256,
          },
        ]) as VaultDeleteSnapshotRow[];
    const refs = rows.flatMap<StoredBytesRef>((row) =>
      row.storage_key
        ? [
            {
              backend: row.storage_backend,
              key: row.storage_key,
              sizeBytes: row.size_bytes,
              sha256: row.sha256,
            },
          ]
        : [],
    );
    return { rows, refs };
  }

  private sameDeleteSnapshot(left: VaultDeleteSnapshot, right: VaultDeleteSnapshot): boolean {
    return (
      left.rows.length === right.rows.length &&
      left.rows.every((row, index) => {
        const candidate = right.rows[index];
        return (
          candidate !== undefined &&
          row.id === candidate.id &&
          row.storage_key === candidate.storage_key &&
          row.storage_backend === candidate.storage_backend &&
          row.size_bytes === candidate.size_bytes &&
          row.sha256 === candidate.sha256
        );
      })
    );
  }

  private storageAdapter(backend: VaultStorageBackend): VaultByteStorageAdapter {
    const adapter = this.storageAdapters.get(backend);
    if (!adapter) {
      throw new InvalidVaultOperationError("Backend S3 untuk file ini belum dikonfigurasi.");
    }
    return adapter;
  }

  private async recoverStorageOperations(signal?: AbortSignal): Promise<void> {
    for (const adapter of this.storageAdapters.values()) {
      signal?.throwIfAborted();
      await adapter.recover((storageKey) => this.hasStorageMetadata(storageKey), signal);
    }
  }

  private requireItem(id: number): VaultItem {
    const item = this.get(id);
    if (!item) throw new InvalidVaultOperationError(`Item vault ${id} tidak ditemukan.`);
    return item;
  }

  private requireStoredItem(id: number): StoredVaultItem {
    const item = this.getStored(id);
    if (!item) throw new InvalidVaultOperationError(`Item vault ${id} tidak ditemukan.`);
    return item;
  }

  private assertFolder(parentId: number | null): void {
    if (parentId === null) return;
    const parent = this.requireItem(parentId);
    if (parent.kind !== "folder") {
      throw new InvalidVaultOperationError(`Item ${parentId} bukan folder.`);
    }
  }

  private isDescendant(candidateId: number, ancestorId: number): boolean {
    let current: VaultItem | null = this.get(candidateId);
    const visited = new Set<number>();
    while (current) {
      if (current.id === ancestorId) return true;
      if (visited.has(current.id)) return true;
      visited.add(current.id);
      current = current.parentId === null ? null : this.get(current.parentId);
    }
    return false;
  }
}

export async function openVault(
  database: Database.Database,
  storagePath: string,
  objectStorage: VaultObjectStorage | null = null,
  writeBackend: VaultStorageBackend = objectStorage ? "s3" : "local",
  signal?: AbortSignal,
): Promise<Vault> {
  return VaultService.open(database, storagePath, objectStorage, writeBackend, signal);
}
