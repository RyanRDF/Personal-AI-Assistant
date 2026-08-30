import type OpenAI from "openai";

export type CapabilitySource = "local" | "mcp";
export type CapabilityRiskClass =
  | "read"
  | "write-reversible"
  | "write-sensitive"
  | "forbidden";
export type CapabilityApproval = "never" | "explicit-intent" | "always";

export interface CapabilityDefinition {
  id: string;
  modelName: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict: boolean;
  source: CapabilitySource;
  riskClass: CapabilityRiskClass;
  approval: CapabilityApproval;
  egress: boolean;
}

export interface CapabilityHealth {
  sourceId: string;
  status: "ready" | "degraded" | "disabled";
  message?: string;
}

export interface CapabilityInvocationContext {
  chatId: string;
  signal?: AbortSignal;
  onArtifact?: (artifact: { kind: "file"; itemId: number }) => void;
}

export interface CapabilityAdapter {
  readonly sourceId: string;
  list(signal?: AbortSignal): Promise<CapabilityDefinition[]>;
  invoke(
    capabilityId: string,
    rawArguments: string,
    context: CapabilityInvocationContext,
  ): Promise<string>;
  health(): Promise<CapabilityHealth>;
  close?(): Promise<void>;
}

interface RegisteredCapability {
  definition: CapabilityDefinition;
  adapter: CapabilityAdapter;
}

export interface CapabilityRegistryOptions {
  onAdapterError?: (sourceId: string, error: unknown) => void;
}

export class CapabilityRegistry {
  private readonly byModelName = new Map<string, RegisteredCapability>();

  constructor(
    private readonly adapters: CapabilityAdapter[],
    private readonly options: CapabilityRegistryOptions = {},
  ) {}

  async list(signal?: AbortSignal): Promise<CapabilityDefinition[]> {
    signal?.throwIfAborted();
    const settled = await Promise.allSettled(
      this.adapters.map(async (adapter) => ({ adapter, definitions: await adapter.list(signal) })),
    );
    const registered = new Map<string, RegisteredCapability>();
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!;
      const adapter = this.adapters[index]!;
      if (result.status === "rejected") {
        this.options.onAdapterError?.(adapter.sourceId, result.reason);
        continue;
      }
      for (const definition of result.value.definitions) {
        validateDefinition(definition);
        if (registered.has(definition.modelName)) {
          this.options.onAdapterError?.(
            adapter.sourceId,
            new Error(`Nama capability model duplikat: ${definition.modelName}`),
          );
          continue;
        }
        registered.set(definition.modelName, { definition, adapter: result.value.adapter });
      }
    }
    this.byModelName.clear();
    for (const [name, capability] of registered) this.byModelName.set(name, capability);
    return [...registered.values()].map(({ definition }) => definition);
  }

  async resolve(modelName: string, signal?: AbortSignal): Promise<RegisteredCapability | null> {
    await this.list(signal);
    return this.byModelName.get(modelName) ?? null;
  }

  async health(): Promise<CapabilityHealth[]> {
    return await Promise.all(
      this.adapters.map(async (adapter) => {
        try {
          return await adapter.health();
        } catch (error) {
          this.options.onAdapterError?.(adapter.sourceId, error);
          return {
            sourceId: adapter.sourceId,
            status: "degraded" as const,
            message: error instanceof Error ? error.message : "Capability adapter gagal.",
          };
        }
      }),
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.adapters.map(async (adapter) => await adapter.close?.()));
  }
}

export interface AuthorizedCapabilityInvocation {
  modelName: string;
  rawArguments: string;
  authorized: true;
  context: CapabilityInvocationContext;
}

export class CapabilityExecutor {
  constructor(private readonly registry: CapabilityRegistry) {}

  async invoke(invocation: AuthorizedCapabilityInvocation): Promise<string> {
    invocation.context.signal?.throwIfAborted();
    if (invocation.rawArguments.length > 100_000) {
      throw new Error("Argumen capability melewati batas 100.000 karakter.");
    }
    const registered = await this.registry.resolve(
      invocation.modelName,
      invocation.context.signal,
    );
    if (!registered) throw new Error(`Capability tidak dikenal: ${invocation.modelName}`);
    return await registered.adapter.invoke(
      registered.definition.id,
      invocation.rawArguments,
      invocation.context,
    );
  }
}

export class StaticCapabilityAdapter implements CapabilityAdapter {
  constructor(
    readonly sourceId: string,
    private readonly definitions: CapabilityDefinition[],
    private readonly handler: (
      capabilityId: string,
      rawArguments: string,
      context: CapabilityInvocationContext,
    ) => Promise<string>,
  ) {}

  async list(signal?: AbortSignal): Promise<CapabilityDefinition[]> {
    signal?.throwIfAborted();
    return this.definitions;
  }

  async invoke(
    capabilityId: string,
    rawArguments: string,
    context: CapabilityInvocationContext,
  ): Promise<string> {
    return await this.handler(capabilityId, rawArguments, context);
  }

  async health(): Promise<CapabilityHealth> {
    return { sourceId: this.sourceId, status: "ready" };
  }
}

export function asChatCompletionTool(
  definition: CapabilityDefinition,
): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: definition.modelName,
      description: definition.description,
      strict: definition.strict,
      parameters: definition.inputSchema,
    },
  };
}

function validateDefinition(definition: CapabilityDefinition): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(definition.modelName)) {
    throw new Error(`Nama capability model tidak valid: ${definition.modelName}`);
  }
  if (!definition.id.trim() || !definition.description.trim()) {
    throw new Error("Capability membutuhkan id dan description.");
  }
  if (definition.inputSchema.type !== "object") {
    throw new Error(`Input schema ${definition.modelName} harus berupa object.`);
  }
}
