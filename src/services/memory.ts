import type Database from "better-sqlite3";
import type { MemoryItem, MemoryKind } from "../types.js";

interface MemoryRow {
  id: number;
  kind: MemoryKind;
  content: string;
  created_at: string;
  updated_at: string;
}

const STOP_TERMS = new Set([
  "ada",
  "akan",
  "atau",
  "bahwa",
  "dan",
  "dari",
  "dengan",
  "ini",
  "itu",
  "kami",
  "kamu",
  "karena",
  "mereka",
  "saya",
  "sebagai",
  "sudah",
  "untuk",
  "yang",
]);

function mapRow(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function terms(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase("id-ID")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 3 && !STOP_TERMS.has(term)),
  );
}

export function memoryRelevance(query: string, memory: string): number {
  const queryTerms = terms(query);
  if (queryTerms.size === 0) return 0;
  const memoryTerms = terms(memory);
  let overlap = 0;
  for (const term of queryTerms) {
    if (memoryTerms.has(term)) overlap += 1;
  }
  return overlap / queryTerms.size;
}

export class MemoryService {
  constructor(private readonly database: Database.Database) {}

  save(kind: MemoryKind, content: string): MemoryItem {
    const normalized = content.trim();
    const existing = this.database
      .prepare("SELECT * FROM memories WHERE lower(content) = lower(?) LIMIT 1")
      .get(normalized) as MemoryRow | undefined;
    if (existing) return mapRow(existing);

    const result = this.database
      .prepare("INSERT INTO memories(kind, content) VALUES (?, ?)")
      .run(kind, normalized);
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): MemoryItem | null {
    const row = this.database.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  list(limit = 100): MemoryItem[] {
    const rows = this.database
      .prepare("SELECT * FROM memories ORDER BY updated_at DESC, id DESC LIMIT ?")
      .all(limit) as MemoryRow[];
    return rows.map(mapRow);
  }

  relevant(query: string, limit: number): MemoryItem[] {
    const ranked = this.list(Math.max(limit * 5, 50)).map((item, index) => ({
      item,
      score: memoryRelevance(query, item.content),
      recency: index,
    }));
    const alwaysOnPreferences = ranked.filter(({ item }) => item.kind === "preference");
    const relevantContext = ranked
      .filter(({ item, score }) => item.kind !== "preference" && score > 0)
      .sort((a, b) => b.score - a.score || a.recency - b.recency);
    return [...alwaysOnPreferences, ...relevantContext]
      .sort((a, b) => b.score - a.score || a.recency - b.recency)
      .slice(0, limit)
      .map(({ item }) => item);
  }

  update(id: number, kind: MemoryKind, content: string): MemoryItem | null {
    const result = this.database
      .prepare(
        `UPDATE memories SET kind = ?, content = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(kind, content.trim(), id);
    return result.changes > 0 ? this.get(id) : null;
  }

  delete(id: number): boolean {
    return this.database.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  }

  clear(): number {
    return this.database.prepare("DELETE FROM memories").run().changes;
  }
}
