import { z } from "zod";
import type { CapabilityApproval, CapabilityRiskClass } from "../agent/capability.js";

const allowedToolSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    riskClass: z
      .enum(["read", "write-reversible", "write-sensitive", "forbidden"])
      .default("read"),
    approval: z.enum(["never", "always"]).default("always"),
  })
  .strict()
  .superRefine((tool, context) => {
    if (tool.approval === "never" && tool.riskClass !== "read") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval"],
        message: "Hanya MCP read-only yang boleh dikonfigurasi tanpa approval.",
      });
    }
  });

const connectionSchema = z
  .object({
    id: z.string().trim().regex(/^[a-z][a-z0-9-]{0,31}$/u),
    label: z.string().trim().min(1).max(80),
    serverUrl: z.string().url(),
    enabled: z.boolean().default(true),
    authorizationEnv: z
      .string()
      .trim()
      .regex(/^[A-Z_][A-Z0-9_]*$/u)
      .optional(),
    allowedTools: z.array(allowedToolSchema).min(1).max(50),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(20_000),
    maxOutputChars: z.number().int().min(1_000).max(100_000).default(20_000),
    cacheTtlMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  })
  .strict()
  .superRefine((connection, context) => {
    const url = new URL(connection.serverUrl);
    const localHttp =
      url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !localHttp) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serverUrl"],
        message: "MCP remote wajib HTTPS; HTTP hanya diizinkan untuk loopback lokal.",
      });
    }
    if (url.username || url.password || url.hash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serverUrl"],
        message: "URL MCP tidak boleh membawa credential atau fragment.",
      });
    }
    const names = new Set<string>();
    for (const [index, tool] of connection.allowedTools.entries()) {
      if (names.has(tool.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedTools", index, "name"],
          message: `Tool MCP duplikat: ${tool.name}`,
        });
      }
      names.add(tool.name);
    }
  });

const connectionsSchema = z.array(connectionSchema).max(20).superRefine((connections, context) => {
  const ids = new Set<string>();
  for (const [index, connection] of connections.entries()) {
    if (ids.has(connection.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "id"],
        message: `ID MCP Connection duplikat: ${connection.id}`,
      });
    }
    ids.add(connection.id);
  }
});

interface ParsedAllowedTool {
  name: string;
  riskClass: CapabilityRiskClass;
  approval: Extract<CapabilityApproval, "never" | "always">;
}

export interface McpConnectionConfig {
  id: string;
  label: string;
  serverUrl: string;
  enabled: boolean;
  authorizationEnv?: string;
  allowedTools: ParsedAllowedTool[];
  timeoutMs: number;
  maxOutputChars: number;
  cacheTtlMs: number;
}

export function parseMcpConnections(raw: string): McpConnectionConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MCP_CONNECTIONS_JSON harus berupa JSON array yang valid.");
  }
  const result = connectionsSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "connections"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Konfigurasi MCP tidak valid:\n${detail}`);
  }
  return result.data.map((connection) => ({
    id: connection.id,
    label: connection.label,
    serverUrl: connection.serverUrl,
    enabled: connection.enabled,
    ...(connection.authorizationEnv
      ? { authorizationEnv: connection.authorizationEnv }
      : {}),
    allowedTools: connection.allowedTools,
    timeoutMs: connection.timeoutMs,
    maxOutputChars: connection.maxOutputChars,
    cacheTtlMs: connection.cacheTtlMs,
  }));
}
