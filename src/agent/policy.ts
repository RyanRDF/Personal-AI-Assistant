import type { CapabilityDefinition } from "./capability.js";

export interface ToolAuthorization {
  allowedTools: Set<string>;
  sensitiveVaultRead: boolean;
  vaultWriteMode: "none" | "create-only" | "full";
  memoryCreateContent: string | null;
}

export type PolicyDecision =
  | { outcome: "allow"; reason: string }
  | { outcome: "require-approval"; reason: string }
  | { outcome: "deny"; reason: string };

export interface CapabilityPolicyContext {
  authorization: ToolAuthorization;
  toolsDisabled: boolean;
}

export class PolicyEngine {
  visibleCapabilities(
    context: CapabilityPolicyContext,
    capabilities: CapabilityDefinition[],
  ): CapabilityDefinition[] {
    return capabilities.filter(
      (capability) => this.authorize(capability, context).outcome === "allow",
    );
  }

  authorize(
    capability: CapabilityDefinition,
    context: CapabilityPolicyContext,
  ): PolicyDecision {
    if (context.toolsDisabled) {
      return { outcome: "deny", reason: "tools-disabled-for-untrusted-or-isolated-input" };
    }
    if (capability.riskClass === "forbidden") {
      return { outcome: "deny", reason: "capability-forbidden" };
    }
    if (context.authorization.sensitiveVaultRead && capability.egress) {
      return { outcome: "deny", reason: "sensitive-data-egress-blocked" };
    }
    if (capability.source === "local") {
      if (!context.authorization.allowedTools.has(capability.modelName)) {
        return { outcome: "deny", reason: "owner-intent-did-not-authorize-capability" };
      }
      return { outcome: "allow", reason: "local-capability-authorized-by-owner-intent" };
    }
    if (capability.riskClass !== "read" || capability.approval === "always") {
      return { outcome: "require-approval", reason: "mcp-capability-requires-owner-approval" };
    }
    return { outcome: "allow", reason: "operator-approved-read-only-mcp-capability" };
  }

  authorizeInvocation(
    capability: CapabilityDefinition,
    rawArguments: string,
    context: CapabilityPolicyContext,
  ): PolicyDecision {
    const decision = this.authorize(capability, context);
    if (decision.outcome !== "allow") return decision;
    if (
      capability.modelName === "write_vault_note" &&
      context.authorization.vaultWriteMode === "create-only"
    ) {
      const parsed = parseArguments(rawArguments);
      if (parsed?.operation !== "create") {
        return { outcome: "deny", reason: "untrusted-payload-only-allows-new-vault-note" };
      }
    }
    return decision;
  }

  canonicalArguments(
    capability: CapabilityDefinition,
    rawArguments: string,
    context: CapabilityPolicyContext,
  ): string {
    if (
      capability.modelName !== "remember" ||
      context.authorization.memoryCreateContent === null
    ) {
      return rawArguments;
    }
    const parsed = parseArguments(rawArguments);
    if (!parsed) throw new Error("Argumen capability harus berupa object JSON.");
    return JSON.stringify({ ...parsed, content: context.authorization.memoryCreateContent });
  }
}

function parseArguments(rawArguments: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
