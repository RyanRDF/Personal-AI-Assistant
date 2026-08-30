import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  DurableAgentRuntime,
  type AssistantReplyPort,
} from "../src/agent/runtime.js";
import type {
  AgentRun,
  AgentRunEvent,
  AgentRunRepository,
  AgentRunStatus,
} from "../src/agent/run-store.js";

class MemoryRunRepository implements AgentRunRepository {
  readonly runs = new Map<string, AgentRun>();
  readonly recordedEvents: AgentRunEvent[] = [];

  create(input: {
    id: string;
    ownerChatId: string;
    inputKind: "text" | "image";
    model: string;
    policyVersion: string;
  }): AgentRun {
    const now = new Date().toISOString();
    const run: AgentRun = {
      ...input,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      errorCode: null,
    };
    this.runs.set(run.id, run);
    return run;
  }

  transition(
    runId: string,
    status: AgentRunStatus,
    options: { errorCode?: string; event?: string; payload?: Record<string, unknown> } = {},
  ): AgentRun {
    const current = this.runs.get(runId)!;
    const run = {
      ...current,
      status,
      updatedAt: new Date().toISOString(),
      completedAt: ["completed", "failed", "cancelled"].includes(status)
        ? new Date().toISOString()
        : null,
      errorCode: options.errorCode ?? null,
    };
    this.runs.set(runId, run);
    this.append(runId, options.event ?? `run.${status}`, options.payload ?? {});
    return run;
  }

  append(runId: string, type: string, payload: Record<string, unknown> = {}): AgentRunEvent {
    const event = {
      runId,
      sequence: this.recordedEvents.filter((item) => item.runId === runId).length + 1,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.recordedEvents.push(event);
    return event;
  }

  get(runId: string): AgentRun | null {
    return this.runs.get(runId) ?? null;
  }
}

describe("DurableAgentRuntime", () => {
  it("records lifecycle and sanitized assistant events", async () => {
    const repository = new MemoryRunRepository();
    const assistant: AssistantReplyPort = {
      openaiClient: {} as OpenAI,
      async reply(_chatId, _input, options) {
        options?.onEvent?.({ type: "stage", name: "model", label: "Memanggil model" });
        options?.onEvent?.({ type: "partial", text: "isi rahasia tidak boleh dipersist" });
        options?.onEvent?.({ type: "tool", name: "search_web", label: "Mencari web" });
        options?.onEvent?.({ type: "usage", inputTokens: 10, outputTokens: 4 });
        options?.onEvent?.({ type: "file", itemId: 7 });
        return "Selesai";
      },
    };
    const runtime = new DurableAgentRuntime(assistant, repository, "test-model");

    await expect(
      runtime.reply("owner", "Cari", { runId: "run-1", inputKind: "text" }),
    ).resolves.toBe("Selesai");
    expect(runtime.get("run-1")?.status).toBe("completed");
    expect(repository.recordedEvents.map(({ type }) => type)).toEqual([
      "run.running",
      "assistant.stage",
      "capability.requested",
      "model.usage",
      "artifact.file",
      "run.completed",
    ]);
    expect(JSON.stringify(repository.recordedEvents)).not.toContain("isi rahasia");
  });

  it("cancels the active model call and records a terminal state", async () => {
    const repository = new MemoryRunRepository();
    const assistant: AssistantReplyPort = {
      openaiClient: {} as OpenAI,
      async reply(_chatId, _input, options) {
        return await new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    };
    const runtime = new DurableAgentRuntime(assistant, repository, "test-model");
    const pending = runtime.reply("owner", "Tunggu", { runId: "run-2" });
    await Promise.resolve();
    runtime.cancel("run-2");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.get("run-2")).toEqual(
      expect.objectContaining({ status: "cancelled", errorCode: "cancelled" }),
    );
  });
});
