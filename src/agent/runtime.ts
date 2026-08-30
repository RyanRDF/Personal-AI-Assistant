import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type {
  AssistantEvent,
  AssistantInput,
  AssistantReplyOptions,
} from "../ai/assistant.js";
import type { AgentRun, AgentRunRepository } from "./run-store.js";

export interface AssistantReplyPort {
  readonly openaiClient: OpenAI;
  reply(
    chatId: string,
    input: string | AssistantInput,
    options?: AssistantReplyOptions,
  ): Promise<string>;
}

export interface AgentRuntimeReplyOptions extends AssistantReplyOptions {
  runId?: string;
  inputKind?: "text" | "image";
}

export interface AgentRuntime {
  readonly openaiClient: OpenAI;
  reply(
    chatId: string,
    input: string | AssistantInput,
    options?: AgentRuntimeReplyOptions,
  ): Promise<string>;
  cancel(runId: string): AgentRun | null;
  get(runId: string): AgentRun | null;
}

export class DurableAgentRuntime implements AgentRuntime {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly assistant: AssistantReplyPort,
    private readonly runs: AgentRunRepository,
    private readonly model: string,
    private readonly policyVersion = "1",
  ) {}

  get openaiClient(): OpenAI {
    return this.assistant.openaiClient;
  }

  async reply(
    chatId: string,
    input: string | AssistantInput,
    options: AgentRuntimeReplyOptions = {},
  ): Promise<string> {
    const runId = options.runId ?? randomUUID();
    const inputKind = options.inputKind ?? inferInputKind(input);
    this.runs.create({
      id: runId,
      ownerChatId: chatId,
      inputKind,
      model: this.model,
      policyVersion: this.policyVersion,
    });
    this.runs.transition(runId, "running");
    const controller = new AbortController();
    this.active.set(runId, controller);
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const onEvent = (event: AssistantEvent) => {
      try {
        this.recordAssistantEvent(runId, event);
      } finally {
        options.onEvent?.(event);
      }
    };
    try {
      const answer = await this.assistant.reply(chatId, input, {
        signal,
        onEvent,
        ...(options.isolated !== undefined ? { isolated: options.isolated } : {}),
      });
      this.runs.transition(runId, "completed", {
        payload: { answerCharacters: answer.length },
      });
      return answer;
    } catch (error) {
      const cancelled = signal.aborted;
      this.runs.transition(runId, cancelled ? "cancelled" : "failed", {
        errorCode: classifyError(error, cancelled),
      });
      throw error;
    } finally {
      this.active.delete(runId);
    }
  }

  cancel(runId: string): AgentRun | null {
    this.active.get(runId)?.abort(new DOMException("Dibatalkan oleh Owner", "AbortError"));
    return this.runs.get(runId);
  }

  get(runId: string): AgentRun | null {
    return this.runs.get(runId);
  }

  private recordAssistantEvent(runId: string, event: AssistantEvent): void {
    switch (event.type) {
      case "partial":
        return;
      case "stage":
        this.runs.append(runId, "assistant.stage", {
          name: event.name.slice(0, 100),
          label: event.label.slice(0, 200),
        });
        return;
      case "tool":
        this.runs.append(runId, "capability.requested", {
          name: event.name.slice(0, 100),
          label: event.label.slice(0, 200),
        });
        return;
      case "usage":
        this.runs.append(runId, "model.usage", {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        });
        return;
      case "file":
        this.runs.append(runId, "artifact.file", { itemId: event.itemId });
    }
  }
}

function inferInputKind(input: string | AssistantInput): "text" | "image" {
  if (typeof input === "string") return "text";
  return input.images?.length || input.attachmentContext ? "image" : "text";
}

function classifyError(error: unknown, cancelled: boolean): string {
  if (cancelled) {
    const message = (error instanceof Error ? error.message : "").toLowerCase();
    return message.includes("timed out") ? "timeout" : "cancelled";
  }
  return error instanceof Error ? error.name.slice(0, 120) : "unknown_error";
}
