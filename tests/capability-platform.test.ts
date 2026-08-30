import { describe, expect, it, vi } from "vitest";
import {
  CapabilityExecutor,
  CapabilityRegistry,
  StaticCapabilityAdapter,
  type CapabilityDefinition,
} from "../src/agent/capability.js";
import { PolicyEngine, type ToolAuthorization } from "../src/agent/policy.js";

function capability(
  overrides: Partial<CapabilityDefinition> = {},
): CapabilityDefinition {
  return {
    id: "local:search",
    modelName: "search",
    label: "Mencari",
    description: "Cari data",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
    source: "local",
    riskClass: "read",
    approval: "explicit-intent",
    egress: false,
    ...overrides,
  };
}

function authorization(allowedTools: string[] = ["search"]): ToolAuthorization {
  return {
    allowedTools: new Set(allowedTools),
    sensitiveVaultRead: false,
    vaultWriteMode: "none",
    memoryCreateContent: null,
  };
}

describe("capability platform", () => {
  it("keeps healthy adapters available when another adapter is degraded", async () => {
    const errors: string[] = [];
    const local = new StaticCapabilityAdapter("local", [capability()], async () => "ok");
    const degraded = {
      sourceId: "mcp:down",
      async list() { throw new Error("offline"); },
      async invoke() { return "never"; },
      async health() { return { sourceId: "mcp:down", status: "degraded" as const }; },
    };
    const registry = new CapabilityRegistry([local, degraded], {
      onAdapterError: (sourceId) => errors.push(sourceId),
    });

    await expect(registry.list()).resolves.toEqual([expect.objectContaining({ modelName: "search" })]);
    expect(errors).toEqual(["mcp:down"]);
  });

  it("executes only an explicitly authorized invocation", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ ok: true }));
    const registry = new CapabilityRegistry([
      new StaticCapabilityAdapter("local", [capability()], invoke),
    ]);
    const executor = new CapabilityExecutor(registry);

    await expect(
      executor.invoke({
        modelName: "search",
        rawArguments: "{}",
        authorized: true,
        context: { chatId: "owner" },
      }),
    ).resolves.toContain('"ok":true');
    expect(invoke).toHaveBeenCalledWith("local:search", "{}", { chatId: "owner" });
  });

  it("denies unapproved MCP, tool-disabled input, and sensitive egress", () => {
    const policy = new PolicyEngine();
    const localEgress = capability({ egress: true });
    const mcp = capability({
      id: "drive:search",
      modelName: "mcp_drive_search",
      source: "mcp",
      approval: "always",
      egress: true,
    });

    expect(
      policy.authorize(mcp, { authorization: authorization(), toolsDisabled: false }).outcome,
    ).toBe("require-approval");
    expect(
      policy.authorize(localEgress, {
        authorization: { ...authorization(), sensitiveVaultRead: true },
        toolsDisabled: false,
      }).outcome,
    ).toBe("deny");
    expect(
      policy.authorize(localEgress, { authorization: authorization(), toolsDisabled: true }).outcome,
    ).toBe("deny");
  });

  it("binds memory payloads and create-only vault constraints before execution", () => {
    const policy = new PolicyEngine();
    const memory = capability({ modelName: "remember", id: "local:remember" });
    const vault = capability({ modelName: "write_vault_note", id: "local:write_vault_note" });
    const context = {
      authorization: {
        ...authorization(["remember", "write_vault_note"]),
        memoryCreateContent: "payload milik owner",
        vaultWriteMode: "create-only" as const,
      },
      toolsDisabled: false,
    };

    expect(policy.canonicalArguments(memory, '{"content":"pilihan model"}', context)).toBe(
      '{"content":"payload milik owner"}',
    );
    expect(
      policy.authorizeInvocation(vault, '{"operation":"append"}', context).outcome,
    ).toBe("deny");
    expect(
      policy.authorizeInvocation(vault, '{"operation":"create"}', context).outcome,
    ).toBe("allow");
  });
});
