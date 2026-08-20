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

  constructor(
    private readonly database: Database.Database,
    storagePath: string,
  ) {
    this.storagePath = path.resolve(storagePath);
    fs.mkdirSync(this.storagePath, { recursive: true });
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
    let parentId: number | null = null;
    let current: VaultItem | null = null;
    for (const part of parts) {
      const normalized = normalizeVaultName(part);
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

  saveFile(input: SaveVaultFileInput): VaultItem {
    const parentId = input.parentId ?? null;
    this.assertFolder(parentId);
    const name = normalizeVaultName(input.name);
    const duplicate = this.findDuplicateName(name, parentId);
    if (duplicate) throw new DuplicateVaultItemError(duplicate);

    const storageKey = randomUUID();
    const finalPath = this.storageFilePath(storageKey);
    const temporaryPath = `${finalPath}.tmp`;
    const bytes = Buffer.from(input.bytes);
    fs.writeFileSync(temporaryPath, bytes, { flag: "wx" });
    fs.renameSync(temporaryPath, finalPath);
    try {
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
      return this.get(Number(result.lastInsertRowid))!;
    } catch (error) {
      fs.rmSync(finalPath, { force: true });
      throw error;
    }
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
    this.database.prepare("DELETE FROM vault_items WHERE id = ?").run(id);
    for (const row of fileRows) fs.rmSync(this.storageFilePath(row.storage_key), { force: true });
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
