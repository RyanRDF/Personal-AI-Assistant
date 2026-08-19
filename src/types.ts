export type ChatRole = "user" | "assistant";

export interface StoredMessage {
  id: number;
  chatId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export type MemoryKind = "preference" | "fact" | "commitment" | "other";

export interface MemoryItem {
  id: number;
  kind: MemoryKind;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailRule {
  id: number;
  description: string;
  gmailQuery: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
}

export interface EmailMatchResult {
  match: boolean;
  confidence: number;
  reason: string;
  summary: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}
