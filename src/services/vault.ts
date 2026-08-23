import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { VaultItem, VaultItemKind, VaultStats } from "../types.js";

interface VaultRow {
  id: number;
  parent_id: number | null;
  kind: VaultItemKind;
  name: string;
  mime_type: string | null;
  size_bytes: number;
  storage_key: string | null;
  content: string | null;
  sha256: string | null;
  source_chat_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
}

interface VaultFsOperationRow {
  id: string;
  operation: "save" | "delete";
  storage_key: string;
}

interface VaultDeleteMove {
  operationId: string;
  storageKey: string;
  finalPath: string;
  trashPath: string;
}

export interface VaultSource {
  chatId?: string;
  messageId?: string;
}

export interface SaveVaultFileInput extends VaultSource {
  parentId?: number | null;
  name: string;
  mimeType?: string | null;
  bytes: Uint8Array;
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

function mapRow(row: VaultRow): VaultItem {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storageKey: row.storage_key,
    content: row.content,
    sha256: row.sha256,
    sourceChatId: row.source_chat_id,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  const itemTerms = noteTerms(`${item.name} ${item.content ?? ""}`);
  let overlap = 0;
  for (const term of queryTerms) if (itemTerms.has(term)) overlap += 1;
  return overlap / queryTerms.size;
}

export class VaultService {
  readonly storagePath: string;
  private readonly temporaryPath: string;
  private readonly trashPath: string;

  constructor(
    private readonly database: Database.Database,
    storagePath: string,
  ) {
    this.storagePath = path.resolve(storagePath);
    this.temporaryPath = path.join(this.storagePath, ".tmp");
    this.trashPath = path.join(this.storagePath, ".trash");
    fs.mkdirSync(this.storagePath, { recursive: true });
    fs.mkdirSync(this.temporaryPath, { recursive: true });
    fs.mkdirSync(this.trashPath, { recursive: true });
    this.reconcileFilesystemOperations();
  }

  get(id: number): VaultItem | null {
    const row = this.database.prepare("SELECT * FROM vault_items WHERE id = ?").get(id) as
      | VaultRow
      | undefined;
    return row ? mapRow(row) : null;
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
    return rows.map(mapRow);
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
    return row ? mapRow(row) : null;
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

  saveFile(input: SaveVaultFileInput): VaultItem {
    const parentId = input.parentId ?? null;
    this.assertFolder(parentId);
    const name = normalizeVaultName(input.name);
    const duplicate = this.findDuplicateName(name, parentId);
    if (duplicate) throw new DuplicateVaultItemError(duplicate);

    const storageKey = randomUUID();
    const operationId = randomUUID();
    const finalPath = this.storageFilePath(storageKey);
    const temporaryPath = this.operationFilePath("save", operationId);
    const bytes = Buffer.from(input.bytes);
    fs.writeFileSync(temporaryPath, bytes, { flag: "wx" });
    let itemId: number | null = null;
    try {
      this.recordFilesystemOperation(operationId, "save", storageKey);
      const result = this.database
        .prepare(
          `INSERT INTO vault_items(
             parent_id, kind, name, mime_type, size_bytes, storage_key, sha256,
             source_chat_id, source_message_id
           ) VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parentId,
          name,
          input.mimeType ?? "application/octet-stream",
          bytes.byteLength,
          storageKey,
          createHash("sha256").update(bytes).digest("hex"),
          input.chatId ?? null,
          input.messageId ?? null,
        );
      itemId = Number(result.lastInsertRowid);
      fs.renameSync(temporaryPath, finalPath);
    } catch (error) {
      this.compensateFailedSave(operationId, storageKey, temporaryPath, itemId);
      throw error;
    }
    this.forgetFilesystemOperation(operationId);
    return this.requireItem(itemId);
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

  delete(id: number): number {
    const item = this.requireItem(id);
    const fileRows = (item.kind === "folder"
      ? this.database
          .prepare(
            `WITH RECURSIVE descendants(id) AS (
               SELECT id FROM vault_items WHERE id = ?
               UNION ALL
               SELECT child.id FROM vault_items child JOIN descendants parent ON child.parent_id = parent.id
             )
             SELECT storage_key FROM vault_items WHERE id IN descendants AND storage_key IS NOT NULL`,
          )
          .all(id)
      : item.storageKey
        ? [{ storage_key: item.storageKey }]
        : []) as Array<{ storage_key: string }>;
    const count =
      item.kind === "folder"
        ? (this.database
            .prepare(
              `WITH RECURSIVE descendants(id) AS (
                 SELECT id FROM vault_items WHERE id = ?
                 UNION ALL
                 SELECT child.id FROM vault_items child JOIN descendants parent ON child.parent_id = parent.id
               ) SELECT count(*) AS count FROM descendants`,
            )
            .get(id) as { count: number }).count
        : 1;
    const moves: VaultDeleteMove[] = [];
    try {
      for (const row of fileRows) {
        const finalPath = this.storageFilePath(row.storage_key);
        if (!fs.existsSync(finalPath)) continue;
        const operationId = randomUUID();
        const trashPath = this.operationFilePath("delete", operationId);
        this.recordFilesystemOperation(operationId, "delete", row.storage_key);
        const move = { operationId, storageKey: row.storage_key, finalPath, trashPath };
        moves.push(move);
        fs.renameSync(finalPath, trashPath);
      }
      this.database.transaction(() => {
        this.database.prepare("DELETE FROM vault_items WHERE id = ?").run(id);
      })();
    } catch (error) {
      this.restoreDeleteMoves(moves);
      throw error;
    }
    for (const move of moves) this.finalizeDeleteMove(move);
    return count;
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
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(pattern, pattern, limit) as VaultRow[];
    return rows.map(mapRow);
  }

  relevant(query: string, limit: number): VaultItem[] {
    const candidates = this.database
      .prepare(
        `SELECT * FROM vault_items WHERE kind IN ('note', 'file')
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(Math.max(limit * 10, 100)) as VaultRow[];
    return candidates
      .map((row, index) => ({ item: mapRow(row), score: relevance(query, mapRow(row)), index }))
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

  filePath(id: number): string {
    const item = this.requireItem(id);
    if (item.kind !== "file" || !item.storageKey) {
      throw new InvalidVaultOperationError("Item bukan file.");
    }
    const filePath = this.storageFilePath(item.storageKey);
    if (!fs.existsSync(filePath)) throw new InvalidVaultOperationError("Byte file tidak ditemukan.");
    return filePath;
  }

  private recordFilesystemOperation(
    id: string,
    operation: VaultFsOperationRow["operation"],
    storageKey: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO vault_fs_operations(id, operation, storage_key) VALUES (?, ?, ?)",
      )
      .run(id, operation, storageKey);
  }

  private forgetFilesystemOperation(id: string): void {
    try {
      this.database.prepare("DELETE FROM vault_fs_operations WHERE id = ?").run(id);
    } catch {
      // The completed operation is safe; a leftover journal row is idempotently
      // reconciled the next time VaultService starts.
    }
  }

  private operationFilePath(operation: VaultFsOperationRow["operation"], id: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(id)) {
      throw new InvalidVaultOperationError("ID operasi filesystem vault tidak valid.");
    }
    return path.join(operation === "save" ? this.temporaryPath : this.trashPath, id);
  }

  private hasStorageMetadata(storageKey: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM vault_items WHERE storage_key = ? LIMIT 1")
        .get(storageKey),
    );
  }

  private compensateFailedSave(
    operationId: string,
    storageKey: string,
    temporaryPath: string,
    itemId: number | null,
  ): void {
    if (itemId !== null) {
      try {
        this.database.prepare("DELETE FROM vault_items WHERE id = ?").run(itemId);
      } catch {
        // Keep the journal so startup reconciliation can complete or compensate.
      }
    }
    let metadataExists = true;
    try {
      metadataExists = this.hasStorageMetadata(storageKey);
    } catch {
      return;
    }
    if (metadataExists) return;
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      return;
    }
    this.forgetFilesystemOperation(operationId);
  }

  private restoreDeleteMoves(moves: VaultDeleteMove[]): void {
    for (const move of [...moves].reverse()) {
      try {
        if (fs.existsSync(move.trashPath)) {
          if (fs.existsSync(move.finalPath)) {
            fs.rmSync(move.trashPath, { force: true });
          } else {
            fs.renameSync(move.trashPath, move.finalPath);
          }
        }
        if (fs.existsSync(move.finalPath) && !fs.existsSync(move.trashPath)) {
          this.forgetFilesystemOperation(move.operationId);
        }
      } catch {
        // Do not overwrite a destination on Windows. The journal retains enough
        // identity to retry this compensation safely on the next startup.
      }
    }
  }

  private finalizeDeleteMove(move: VaultDeleteMove): void {
    try {
      fs.rmSync(move.trashPath, { force: true });
    } catch {
      return;
    }
    this.forgetFilesystemOperation(move.operationId);
  }

  private reconcileFilesystemOperations(): void {
    const operations = this.database
      .prepare("SELECT id, operation, storage_key FROM vault_fs_operations ORDER BY created_at, id")
      .all() as VaultFsOperationRow[];
    for (const operation of operations) {
      try {
        const finalPath = this.storageFilePath(operation.storage_key);
        const operationPath = this.operationFilePath(operation.operation, operation.id);
        const metadataExists = this.hasStorageMetadata(operation.storage_key);
        if (operation.operation === "save") {
          if (metadataExists) {
            if (!fs.existsSync(finalPath) && fs.existsSync(operationPath)) {
              fs.renameSync(operationPath, finalPath);
            } else if (fs.existsSync(finalPath) && fs.existsSync(operationPath)) {
              fs.rmSync(operationPath, { force: true });
            }
            if (fs.existsSync(finalPath)) {
              this.forgetFilesystemOperation(operation.id);
            } else if (!fs.existsSync(operationPath)) {
              this.database
                .prepare("DELETE FROM vault_items WHERE storage_key = ?")
                .run(operation.storage_key);
              this.forgetFilesystemOperation(operation.id);
            }
          } else {
            fs.rmSync(operationPath, { force: true });
            fs.rmSync(finalPath, { force: true });
            this.forgetFilesystemOperation(operation.id);
          }
          continue;
        }

        if (metadataExists) {
          if (!fs.existsSync(finalPath) && fs.existsSync(operationPath)) {
            fs.renameSync(operationPath, finalPath);
          } else if (fs.existsSync(finalPath) && fs.existsSync(operationPath)) {
            fs.rmSync(operationPath, { force: true });
          }
          if (fs.existsSync(finalPath)) this.forgetFilesystemOperation(operation.id);
        } else {
          fs.rmSync(operationPath, { force: true });
          fs.rmSync(finalPath, { force: true });
          this.forgetFilesystemOperation(operation.id);
        }
      } catch {
        // Keep the journal row and retry after the transient filesystem condition
        // (for example, a Windows file handle) has cleared.
      }
    }
    this.removeUntrackedOperationFiles(operations);
  }

  private removeUntrackedOperationFiles(operations: VaultFsOperationRow[]): void {
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

  private storageFilePath(storageKey: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(storageKey)) {
      throw new InvalidVaultOperationError("Storage key tidak valid.");
    }
    return path.join(this.storagePath, storageKey);
  }

  private requireItem(id: number): VaultItem {
    const item = this.get(id);
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
