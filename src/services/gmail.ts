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

function extractText(part?: gmail_v1.Schema$MessagePart): string {
  if (!part) return "";
  const mimeType = part.mimeType ?? "";
  if (mimeType === "text/plain") return decodeBody(part.body?.data);
  if (mimeType === "text/html") return stripHtml(decodeBody(part.body?.data));

  const children = part.parts ?? [];
  const plain = children.find((child) => child.mimeType === "text/plain");
  if (plain) return decodeBody(plain.body?.data);
  const nested = children.map(extractText).filter(Boolean);
  return nested.join("\n\n");
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

  async getCurrentHistoryId(): Promise<string> {
    const profile = await this.client.users.getProfile({ userId: "me" });
    if (!profile.data.historyId) throw new Error("Gmail tidak mengembalikan historyId.");
    return profile.data.historyId;
  }

  async listNewMessageIds(startHistoryId: string): Promise<GmailHistoryBatch> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latestHistoryId = startHistoryId;

    do {
      const response = await this.client.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        maxResults: 100,
        ...(pageToken ? { pageToken } : {}),
      });
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

  async getMessage(id: string): Promise<GmailMessage> {
    const response = await this.client.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
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

  async search(query: string, limit = 10): Promise<GmailMessage[]> {
    const ids = await this.searchMessageIds(query, limit);
    return Promise.all(ids.map((id) => this.getMessage(id)));
  }

  async searchMessageIds(query: string, limit = 100): Promise<string[]> {
    const response = await this.client.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(limit, 100),
    });
    return (response.data.messages ?? []).flatMap((message) =>
      message.id ? [message.id] : [],
    );
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
