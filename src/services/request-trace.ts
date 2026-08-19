import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getState, setState } from "../db.js";

export type TraceInputKind = "text" | "image";
export type TraceStatus = "running" | "completed" | "cancelled" | "timeout" | "failed";

export interface TraceStage {
  name: string;
  label: string;
  elapsedMs: number;
}

export interface RequestTrace {
  requestId: string;
  chatId: string;
  model: string;
  inputKind: TraceInputKind;
  status: TraceStatus;
  stages: TraceStage[];
  tools: string[];
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
  errorMessage: string | null;
}

interface TraceRow {
  request_id: string;
  chat_id: string;
  model: string;
  input_kind: TraceInputKind;
  status: TraceStatus;
  stages_json: string;
  tools_json: string;
  input_tokens: number;
  output_tokens: number;
  started_at: string;
  completed_at: string | null;
  elapsed_ms: number | null;
  error_message: string | null;
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseStages(value: string): TraceStage[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is TraceStage =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as TraceStage).name === "string" &&
      typeof (item as TraceStage).label === "string" &&
      typeof (item as TraceStage).elapsedMs === "number",
  );
}

function mapRow(row: TraceRow): RequestTrace {
  return {
    requestId: row.request_id,
    chatId: row.chat_id,
    model: row.model,
    inputKind: row.input_kind,
    status: row.status,
    stages: parseStages(row.stages_json),
    tools: parseStringArray(row.tools_json),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    elapsedMs: row.elapsed_ms,
    errorMessage: row.error_message,
  };
}

function liveTraceStateKey(chatId: string): string {
  return `trace_live:${chatId}`;
}

export class RequestTraceService {
  constructor(
    private readonly database: Database.Database,
    private readonly defaultLiveEnabled = false,
  ) {}

  isLiveEnabled(chatId: string): boolean {
    const stored = getState(this.database, liveTraceStateKey(chatId));
    return stored === null ? this.defaultLiveEnabled : stored === "true";
  }

  setLiveEnabled(chatId: string, enabled: boolean): void {
    setState(this.database, liveTraceStateKey(chatId), String(enabled));
  }

  start(chatId: string, model: string, inputKind: TraceInputKind): RequestTrace {
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO request_traces(
           request_id, chat_id, model, input_kind, status, started_at
         ) VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(requestId, chatId, model, inputKind, startedAt);
    return this.get(requestId)!;
  }

  addStage(requestId: string, name: string, label: string): RequestTrace | null {
    const trace = this.get(requestId);
    if (!trace || trace.status !== "running") return trace;
    const stages = [
      ...trace.stages,
      { name, label, elapsedMs: Math.max(0, Date.now() - Date.parse(trace.startedAt)) },
    ];
    this.database
      .prepare("UPDATE request_traces SET stages_json = ? WHERE request_id = ?")
      .run(JSON.stringify(stages), requestId);
    return this.get(requestId);
  }

  addTool(requestId: string, toolName: string): RequestTrace | null {
    const trace = this.get(requestId);
    if (!trace || trace.status !== "running") return trace;
    this.database
      .prepare("UPDATE request_traces SET tools_json = ? WHERE request_id = ?")
      .run(JSON.stringify([...trace.tools, toolName]), requestId);
    return this.get(requestId);
  }

  addUsage(requestId: string, inputTokens: number, outputTokens: number): RequestTrace | null {
    this.database
      .prepare(
        `UPDATE request_traces
         SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?
         WHERE request_id = ?`,
      )
      .run(inputTokens, outputTokens, requestId);
    return this.get(requestId);
  }

  finish(
    requestId: string,
    status: Exclude<TraceStatus, "running">,
    errorMessage: string | null = null,
  ): RequestTrace | null {
    const trace = this.get(requestId);
    if (!trace) return null;
    const completedAt = new Date().toISOString();
    const elapsedMs = Math.max(0, Date.parse(completedAt) - Date.parse(trace.startedAt));
    this.database
      .prepare(
        `UPDATE request_traces
         SET status = ?, completed_at = ?, elapsed_ms = ?, error_message = ?
         WHERE request_id = ?`,
      )
      .run(status, completedAt, elapsedMs, errorMessage?.slice(0, 500) ?? null, requestId);
    return this.get(requestId);
  }

  get(requestId: string): RequestTrace | null {
    const row = this.database
      .prepare("SELECT * FROM request_traces WHERE request_id = ?")
      .get(requestId) as TraceRow | undefined;
    return row ? mapRow(row) : null;
  }

  last(chatId: string): RequestTrace | null {
    const row = this.database
      .prepare(
        "SELECT * FROM request_traces WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(chatId) as TraceRow | undefined;
    return row ? mapRow(row) : null;
  }

  pruneOlderThan(days: number): number {
    return this.database
      .prepare("DELETE FROM request_traces WHERE started_at < datetime('now', ?)")
      .run(`-${days} days`).changes;
  }
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "masih berjalan";
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} dtk`;
}

export function formatRequestTrace(trace: RequestTrace): string {
  const statusLabels: Record<TraceStatus, string> = {
    running: "berjalan",
    completed: "selesai",
    cancelled: "dibatalkan",
    timeout: "timeout",
    failed: "gagal",
  };
  const lines = [
    `Trace #${trace.requestId.slice(0, 8).toUpperCase()}`,
    `• Status: ${statusLabels[trace.status]}`,
    `• Model: ${trace.model}`,
    `• Input: ${trace.inputKind === "image" ? "teks + gambar" : "teks"}`,
    `• Durasi: ${formatDuration(trace.elapsedMs)}`,
    `• Token: ${trace.inputTokens} input / ${trace.outputTokens} output`,
  ];
  if (trace.tools.length > 0) lines.push(`• Tool: ${trace.tools.join(", ")}`);
  if (trace.stages.length > 0) {
    lines.push(
      "• Tahapan:",
      ...trace.stages.map((stage) => `  - ${stage.label} (${formatDuration(stage.elapsedMs)})`),
    );
  }
  if (trace.errorMessage) lines.push(`• Error: ${trace.errorMessage}`);
  return lines.join("\n");
}
