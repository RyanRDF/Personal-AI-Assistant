import type Database from "better-sqlite3";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export interface AgentRun {
  id: string;
  ownerChatId: string;
  inputKind: "text" | "image";
  model: string;
  policyVersion: string;
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

export interface AgentRunEvent {
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentRunRepository {
  create(input: {
    id: string;
    ownerChatId: string;
    inputKind: "text" | "image";
    model: string;
    policyVersion: string;
  }): AgentRun;
  transition(
    runId: string,
    status: AgentRunStatus,
    options?: { errorCode?: string; event?: string; payload?: Record<string, unknown> },
  ): AgentRun;
  append(runId: string, type: string, payload?: Record<string, unknown>): AgentRunEvent;
  get(runId: string): AgentRun | null;
}

interface AgentRunRow {
  id: string;
  owner_chat_id: string;
  input_kind: "text" | "image";
  model: string;
  policy_version: string;
  status: AgentRunStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error_code: string | null;
}

interface AgentRunEventRow {
  run_id: string;
  sequence: number;
  type: string;
  payload_json: string;
  created_at: string;
}

const TERMINAL_STATUSES = new Set<AgentRunStatus>(["completed", "failed", "cancelled"]);
const ALLOWED_TRANSITIONS: Record<AgentRunStatus, ReadonlySet<AgentRunStatus>> = {
  queued: new Set(["running", "failed", "cancelled"]),
  running: new Set(["waiting_approval", "completed", "failed", "cancelled", "outcome_unknown"]),
  waiting_approval: new Set(["running", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  outcome_unknown: new Set(["running", "failed", "cancelled"]),
};

export class AgentRunStore implements AgentRunRepository {
  constructor(private readonly database: Database.Database) {}

  create(input: {
    id: string;
    ownerChatId: string;
    inputKind: "text" | "image";
    model: string;
    policyVersion: string;
  }): AgentRun {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO agent_runs(
             id, owner_chat_id, input_kind, model, policy_version, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          input.id,
          input.ownerChatId,
          input.inputKind,
          input.model,
          input.policyVersion,
          now,
          now,
        );
      this.insertEvent(input.id, "run.queued", {}, now);
    });
    transaction();
    return this.get(input.id)!;
  }

  transition(
    runId: string,
    status: AgentRunStatus,
    options: { errorCode?: string; event?: string; payload?: Record<string, unknown> } = {},
  ): AgentRun {
    const current = this.get(runId);
    if (!current) throw new Error(`Agent Run tidak ditemukan: ${runId}`);
    if (current.status === status) return current;
    if (!ALLOWED_TRANSITIONS[current.status].has(status)) {
      throw new Error(`Transisi Agent Run tidak valid: ${current.status} -> ${status}`);
    }
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE agent_runs
           SET status = ?, updated_at = ?, completed_at = ?, error_code = ?
           WHERE id = ?`,
        )
        .run(
          status,
          now,
          TERMINAL_STATUSES.has(status) ? now : null,
          options.errorCode?.slice(0, 120) ?? null,
          runId,
        );
      this.insertEvent(runId, options.event ?? `run.${status}`, options.payload ?? {}, now);
    });
    transaction();
    return this.get(runId)!;
  }

  append(runId: string, type: string, payload: Record<string, unknown> = {}): AgentRunEvent {
    if (!this.get(runId)) throw new Error(`Agent Run tidak ditemukan: ${runId}`);
    const now = new Date().toISOString();
    let sequence = 0;
    const transaction = this.database.transaction(() => {
      sequence = this.insertEvent(runId, type, payload, now);
      this.database.prepare("UPDATE agent_runs SET updated_at = ? WHERE id = ?").run(now, runId);
    });
    transaction();
    return { runId, sequence, type, payload, createdAt: now };
  }

  get(runId: string): AgentRun | null {
    const row = this.database
      .prepare("SELECT * FROM agent_runs WHERE id = ?")
      .get(runId) as AgentRunRow | undefined;
    return row ? mapRun(row) : null;
  }

  events(runId: string): AgentRunEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM agent_run_events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as AgentRunEventRow[];
    return rows.map(mapEvent);
  }

  recoverInterrupted(): string[] {
    const rows = this.database
      .prepare("SELECT id FROM agent_runs WHERE status IN ('queued', 'running') ORDER BY created_at")
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      for (const row of rows) {
        this.database
          .prepare(
            `UPDATE agent_runs
             SET status = 'failed', updated_at = ?, completed_at = ?, error_code = 'process_restarted'
             WHERE id = ?`,
          )
          .run(now, now, row.id);
        this.insertEvent(row.id, "run.recovered_as_failed", { reason: "process_restarted" }, now);
      }
    });
    transaction();
    return rows.map(({ id }) => id);
  }

  private insertEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_run_events WHERE run_id = ?")
      .get(runId) as { sequence: number };
    this.database
      .prepare(
        `INSERT INTO agent_run_events(run_id, sequence, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, row.sequence, type.slice(0, 100), JSON.stringify(payload), createdAt);
    return row.sequence;
  }
}

function mapRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    ownerChatId: row.owner_chat_id,
    inputKind: row.input_kind,
    model: row.model,
    policyVersion: row.policy_version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
  };
}

function mapEvent(row: AgentRunEventRow): AgentRunEvent {
  const parsed: unknown = JSON.parse(row.payload_json);
  return {
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    payload:
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    createdAt: row.created_at,
  };
}
