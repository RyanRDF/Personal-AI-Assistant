import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";

const PERIOD_DAYS = new Set([1, 7, 30, 90]);

interface OverviewRow {
  requests: number;
  completed: number;
  failed: number;
  timed_out: number;
  cancelled: number;
  running: number;
  input_tokens: number;
  output_tokens: number;
  average_latency_ms: number | null;
  unique_chats: number;
}

interface DailyRow {
  date: string;
  requests: number;
  completed: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  average_latency_ms: number | null;
}

interface TraceRow {
  request_id: string;
  chat_id: string;
  model: string;
  input_kind: "text" | "image";
  status: "running" | "completed" | "cancelled" | "timeout" | "failed";
  tools_json: string;
  input_tokens: number;
  output_tokens: number;
  started_at: string;
  elapsed_ms: number | null;
  error_message: string | null;
}

interface CountRow {
  label: string;
  count: number;
}

interface ChatRow {
  chat_id: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  last_active_at: string;
}

interface UsageRow {
  purpose: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

interface ModelRow {
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  average_latency_ms: number | null;
}

function number(value: number | null | undefined): number {
  return value ?? 0;
}

function rounded(value: number | null | undefined): number {
  return Math.round(number(value));
}

function chatLabel(chatId: string, pseudonymKey: string): string {
  const digest = createHmac("sha256", pseudonymKey)
    .update(chatId)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `Chat ${digest}`;
}

function safeStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function dailySeries(rows: DailyRow[], days: number, now: Date) {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  if (days === 1) {
    return Array.from({ length: 24 }, (_, index) => {
      const date = new Date(now);
      date.setUTCMinutes(0, 0, 0);
      date.setUTCHours(date.getUTCHours() - (23 - index));
      const key = date.toISOString().slice(0, 13) + ":00:00Z";
      const row = byDate.get(key);
      return {
        date: key,
        requests: row?.requests ?? 0,
        completed: row?.completed ?? 0,
        failed: row?.failed ?? 0,
        inputTokens: row?.input_tokens ?? 0,
        outputTokens: row?.output_tokens ?? 0,
        averageLatencyMs: rounded(row?.average_latency_ms),
      };
    });
  }
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - (days - index - 1));
    const key = date.toISOString().slice(0, 10);
    const row = byDate.get(key);
    return {
      date: key,
      requests: row?.requests ?? 0,
      completed: row?.completed ?? 0,
      failed: row?.failed ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      averageLatencyMs: rounded(row?.average_latency_ms),
    };
  });
}

export function parseObservabilityPeriod(value: string | null): number {
  const parsed = Number(value ?? 7);
  return PERIOD_DAYS.has(parsed) ? parsed : 7;
}

export function observabilitySnapshot(
  database: Database.Database,
  requestedDays: number,
  pseudonymKey: string,
  now = new Date(),
) {
  const days = PERIOD_DAYS.has(requestedDays) ? requestedDays : 7;
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const to = now.toISOString();
  const since = "started_at >= ?";
  const usageFrom = from.replace("T", " ").slice(0, 19);
  const overview = database
    .prepare(
      `SELECT
         count(*) AS requests,
         coalesce(sum(status = 'completed'), 0) AS completed,
         coalesce(sum(status = 'failed'), 0) AS failed,
         coalesce(sum(status = 'timeout'), 0) AS timed_out,
         coalesce(sum(status = 'cancelled'), 0) AS cancelled,
         coalesce(sum(status = 'running'), 0) AS running,
         coalesce(sum(input_tokens), 0) AS input_tokens,
         coalesce(sum(output_tokens), 0) AS output_tokens,
         avg(CASE WHEN elapsed_ms IS NOT NULL THEN elapsed_ms END) AS average_latency_ms,
         count(DISTINCT chat_id) AS unique_chats
       FROM request_traces WHERE ${since}`,
    )
    .get(from) as OverviewRow;

  const latencies = database
    .prepare(
      `SELECT elapsed_ms FROM request_traces
       WHERE ${since} AND elapsed_ms IS NOT NULL ORDER BY elapsed_ms`,
    )
    .all(from) as Array<{ elapsed_ms: number }>;
  const timeBucket =
    days === 1 ? "strftime('%Y-%m-%dT%H:00:00Z', started_at)" : "date(started_at)";
  const dailyRows = database
    .prepare(
      `SELECT
         ${timeBucket} AS date,
         count(*) AS requests,
         sum(status = 'completed') AS completed,
         sum(status IN ('failed', 'timeout')) AS failed,
         coalesce(sum(input_tokens), 0) AS input_tokens,
         coalesce(sum(output_tokens), 0) AS output_tokens,
         avg(CASE WHEN elapsed_ms IS NOT NULL THEN elapsed_ms END) AS average_latency_ms
       FROM request_traces WHERE ${since}
       GROUP BY ${timeBucket} ORDER BY ${timeBucket}`,
    )
    .all(from) as DailyRow[];
  const statusRows = database
    .prepare(
      `SELECT status AS label, count(*) AS count FROM request_traces
       WHERE ${since} GROUP BY status ORDER BY count DESC`,
    )
    .all(from) as CountRow[];
  const modelRows = database
    .prepare(
      `SELECT
         model,
         count(*) AS requests,
         coalesce(sum(input_tokens), 0) AS input_tokens,
         coalesce(sum(output_tokens), 0) AS output_tokens,
         avg(CASE WHEN elapsed_ms IS NOT NULL THEN elapsed_ms END) AS average_latency_ms
       FROM request_traces WHERE ${since}
       GROUP BY model ORDER BY requests DESC, model LIMIT 12`,
    )
    .all(from) as ModelRow[];
  const chatRows = database
    .prepare(
      `SELECT
         chat_id,
         count(*) AS requests,
         coalesce(sum(input_tokens), 0) AS input_tokens,
         coalesce(sum(output_tokens), 0) AS output_tokens,
         max(started_at) AS last_active_at
       FROM request_traces WHERE ${since}
       GROUP BY chat_id ORDER BY requests DESC, last_active_at DESC LIMIT 20`,
    )
    .all(from) as ChatRow[];
  const usageRows = database
    .prepare(
      `SELECT
         purpose,
         model,
         count(*) AS calls,
         coalesce(sum(input_tokens), 0) AS input_tokens,
         coalesce(sum(output_tokens), 0) AS output_tokens
       FROM usage_events WHERE created_at >= ?
       GROUP BY purpose, model ORDER BY calls DESC, purpose, model LIMIT 20`,
    )
    .all(usageFrom) as UsageRow[];
  const traceRows = database
    .prepare(
      `SELECT request_id, chat_id, model, input_kind, status, tools_json,
              input_tokens, output_tokens, started_at, elapsed_ms, error_message
       FROM request_traces WHERE ${since}
       ORDER BY started_at DESC LIMIT 50`,
    )
    .all(from) as TraceRow[];
  const toolTraceRows = database
    .prepare(`SELECT tools_json FROM request_traces WHERE ${since}`)
    .all(from) as Array<{ tools_json: string }>;

  const tools = new Map<string, number>();
  for (const trace of toolTraceRows) {
    for (const tool of safeStringArray(trace.tools_json)) {
      tools.set(tool, (tools.get(tool) ?? 0) + 1);
    }
  }

  const terminalRequests = overview.completed + overview.failed + overview.timed_out;
  const resourceCounts = database
    .prepare(
      `SELECT
         (SELECT count(*) FROM messages) AS messages,
         (SELECT count(*) FROM memories) AS memories,
         (SELECT count(*) FROM vault_items) AS vault_items,
         (SELECT count(*) FROM email_rules WHERE enabled = 1) AS active_email_rules,
         (SELECT count(*) FROM email_notifications WHERE status = 'pending') AS pending_email_notifications,
         (SELECT count(*) FROM email_notifications WHERE status = 'dead_letter') AS dead_letter_emails,
         (SELECT count(*) FROM email_processing_failures WHERE terminal = 1) AS terminal_email_failures`,
    )
    .get() as {
    messages: number;
    memories: number;
    vault_items: number;
    active_email_rules: number;
    pending_email_notifications: number;
    dead_letter_emails: number;
    terminal_email_failures: number;
  };
  const memory = process.memoryUsage();
  const pageCount = database.pragma("page_count", { simple: true }) as number;
  const pageSize = database.pragma("page_size", { simple: true }) as number;

  return {
    generatedAt: to,
    window: { days, from, to },
    health: {
      ok: true,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      runtime: process.version,
      residentMemoryBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      databaseBytes: pageCount * pageSize,
    },
    overview: {
      requests: overview.requests,
      completed: overview.completed,
      failed: overview.failed,
      timedOut: overview.timed_out,
      cancelled: overview.cancelled,
      running: overview.running,
      successRate: terminalRequests === 0 ? 0 : (overview.completed / terminalRequests) * 100,
      ratedRequests: terminalRequests,
      inputTokens: overview.input_tokens,
      outputTokens: overview.output_tokens,
      totalTokens: overview.input_tokens + overview.output_tokens,
      averageLatencyMs: rounded(overview.average_latency_ms),
      p95LatencyMs: percentile95(latencies.map((row) => row.elapsed_ms)),
      uniqueChats: overview.unique_chats,
    },
    resources: {
      conversationMessages: resourceCounts.messages,
      memories: resourceCounts.memories,
      vaultItems: resourceCounts.vault_items,
      activeEmailRules: resourceCounts.active_email_rules,
      pendingEmailNotifications: resourceCounts.pending_email_notifications,
      deadLetterEmails: resourceCounts.dead_letter_emails,
      terminalEmailFailures: resourceCounts.terminal_email_failures,
    },
    series: dailySeries(dailyRows, days, now),
    statuses: statusRows.map((row) => ({ status: row.label, count: row.count })),
    models: modelRows.map((row) => ({
      model: row.model,
      requests: row.requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      averageLatencyMs: rounded(row.average_latency_ms),
    })),
    chats: chatRows.map((row) => ({
      chat: chatLabel(row.chat_id, pseudonymKey),
      requests: row.requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      lastActiveAt: row.last_active_at,
    })),
    usage: usageRows.map((row) => ({
      purpose: row.purpose,
      model: row.model,
      calls: row.calls,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    })),
    tools: [...tools.entries()]
      .map(([tool, calls]) => ({ tool, calls }))
      .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool)),
    recent: traceRows.map((row) => ({
      requestId: row.request_id.slice(0, 8).toUpperCase(),
      chat: chatLabel(row.chat_id, pseudonymKey),
      model: row.model,
      inputKind: row.input_kind,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.input_tokens + row.output_tokens,
      startedAt: row.started_at,
      elapsedMs: row.elapsed_ms,
      tools: safeStringArray(row.tools_json),
      errorMessage: row.error_message,
    })),
  };
}
