import { google, type gmail_v1 } from "googleapis";
import type { AppConfig } from "../config.js";
import type { GmailMessage } from "../types.js";

function decodeBody(data?: string | null): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isAttachment(part: gmail_v1.Schema$MessagePart): boolean {
  if (part.filename?.trim()) return true;
  const disposition = header(part.headers, "Content-Disposition");
  return /^\s*attachment(?:\s*;|\s*$)/i.test(disposition);
}

function collectTextParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: "text/plain" | "text/html",
): string[] {
  if (!part || isAttachment(part)) return [];

  const currentMimeType = part.mimeType?.toLowerCase();
  if (currentMimeType === mimeType) {
    const decoded = decodeBody(part.body?.data);
    const text = mimeType === "text/html" ? stripHtml(decoded) : decoded.trim();
    return text ? [text] : [];
  }

  return (part.parts ?? []).flatMap((child) => collectTextParts(child, mimeType));
}

export function extractText(part?: gmail_v1.Schema$MessagePart): string {
  const plain = collectTextParts(part, "text/plain");
  if (plain.length > 0) return plain.join("\n\n");
  return collectTextParts(part, "text/html").join("\n\n");
}

function header(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export interface GmailHistoryBatch {
  messageIds: string[];
  latestHistoryId: string;
}

export interface GmailRequestOptions {
  signal?: AbortSignal;
}

function requestOptions(options?: GmailRequestOptions): { signal: AbortSignal } | undefined {
  return options?.signal ? { signal: options.signal } : undefined;
}

export class GmailService {
  private readonly client: gmail_v1.Gmail;

  constructor(private readonly config: AppConfig) {
    if (!config.GMAIL_CLIENT_ID || !config.GMAIL_CLIENT_SECRET || !config.GMAIL_REFRESH_TOKEN) {
      throw new Error("Gmail belum dikonfigurasi lengkap.");
    }
    const auth = new google.auth.OAuth2(
      config.GMAIL_CLIENT_ID,
      config.GMAIL_CLIENT_SECRET,
      config.GMAIL_REDIRECT_URI,
    );
    auth.setCredentials({ refresh_token: config.GMAIL_REFRESH_TOKEN });
    this.client = google.gmail({ version: "v1", auth });
  }

  async getCurrentHistoryId(options?: GmailRequestOptions): Promise<string> {
    const profile = await this.client.users.getProfile(
      { userId: "me" },
      requestOptions(options),
    );
    if (!profile.data.historyId) throw new Error("Gmail tidak mengembalikan historyId.");
    return profile.data.historyId;
  }

  async listNewMessageIds(
    startHistoryId: string,
    options?: GmailRequestOptions,
  ): Promise<GmailHistoryBatch> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latestHistoryId = startHistoryId;

    do {
      const response = await this.client.users.history.list(
        {
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded"],
          maxResults: 100,
          ...(pageToken ? { pageToken } : {}),
        },
        requestOptions(options),
      );
      latestHistoryId = response.data.historyId ?? latestHistoryId;
      for (const history of response.data.history ?? []) {
        for (const added of history.messagesAdded ?? []) {
          const id = added.message?.id;
          const labels = added.message?.labelIds ?? [];
          if (id && !labels.includes("SENT") && !labels.includes("DRAFT")) ids.add(id);
        }
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return { messageIds: [...ids], latestHistoryId };
  }

  async getMessage(id: string, options?: GmailRequestOptions): Promise<GmailMessage> {
    const response = await this.client.users.messages.get(
      {
        userId: "me",
        id,
        format: "full",
      },
      requestOptions(options),
    );
    const message = response.data;
    const headers = message.payload?.headers;
    const body = extractText(message.payload).slice(0, this.config.GMAIL_MAX_BODY_CHARS);
    return {
      id: message.id ?? id,
      threadId: message.threadId ?? id,
      from: header(headers, "From"),
      to: header(headers, "To"),
      subject: header(headers, "Subject") || "(Tanpa subjek)",
      date: header(headers, "Date"),
      snippet: message.snippet ?? "",
      body,
    };
  }

  async search(
    query: string,
    limit = 10,
    options?: GmailRequestOptions,
  ): Promise<GmailMessage[]> {
    const ids = await this.searchMessageIds(query, limit, options);
    return Promise.all(ids.map((id) => this.getMessage(id, options)));
  }

  async searchMessageIds(
    query: string,
    limit = 100,
    options?: GmailRequestOptions,
  ): Promise<string[]> {
    if (!Number.isFinite(limit) && limit !== Number.POSITIVE_INFINITY) return [];
    if (limit <= 0) return [];

    const ids = new Set<string>();
    let pageToken: string | undefined;
    do {
      const remaining = Number.isFinite(limit) ? limit - ids.size : 100;
      const response = await this.client.users.messages.list(
        {
          userId: "me",
          q: query,
          maxResults: Math.min(Math.max(remaining, 1), 100),
          ...(pageToken ? { pageToken } : {}),
        },
        requestOptions(options),
      );
      for (const message of response.data.messages ?? []) {
        if (message.id) ids.add(message.id);
        if (ids.size >= limit) break;
      }
      pageToken = ids.size < limit ? response.data.nextPageToken ?? undefined : undefined;
    } while (pageToken);

    return [...ids];
  }
}

export function gmailMessageForModel(message: GmailMessage): string {
  return [
    "<untrusted_email>",
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Date: ${message.date}`,
    `Subject: ${message.subject}`,
    `Snippet: ${message.snippet}`,
    "Body:",
    message.body,
    "</untrusted_email>",
  ].join("\n");
}
