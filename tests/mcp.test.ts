import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { parseMcpConnections } from "../src/mcp/config.js";
import { McpHttpCapabilityAdapter } from "../src/mcp/http-adapter.js";
import { testConfig } from "./helpers.js";

function connection(overrides: Record<string, unknown> = {}) {
  return parseMcpConnections(
    JSON.stringify([
      {
        id: "drive",
        label: "Drive resmi",
        serverUrl: "https://mcp.example.test/mcp",
        allowedTools: [{ name: "search", riskClass: "read", approval: "never" }],
        ...overrides,
      },
    ]),
  )[0]!;
}

describe("MCP configuration and adapter", () => {
  it("rejects insecure remote URLs and write tools without approval", () => {
    expect(() => connection({ serverUrl: "http://example.test/mcp" })).toThrow("HTTPS");
    expect(() =>
      connection({
        allowedTools: [{ name: "delete", riskClass: "write-sensitive", approval: "never" }],
      }),
    ).toThrow("read-only");
  });

  it("only exposes allowlisted tools and labels their output untrusted", async () => {
    const callTool = vi.fn(async (): Promise<CallToolResult> => ({
      content: [{ type: "text", text: "Dokumen ditemukan" }],
      structuredContent: { count: 1 },
    }));
    const close = vi.fn(async () => undefined);
    const adapter = new McpHttpCapabilityAdapter(
      connection(),
      createLogger(testConfig()),
      {},
      async () => ({
        async listTools() {
          return {
            tools: [
              {
                name: "search",
                description: "Cari file",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
              {
                name: "delete",
                description: "Hapus file",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          };
        },
        callTool,
        close,
      }),
    );

    const definitions = await adapter.list();
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toEqual(
      expect.objectContaining({
        id: "drive:search",
        modelName: "mcp_drive_search",
        source: "mcp",
        strict: false,
      }),
    );
    const result = await adapter.invoke(
      "drive:search",
      '{"query":"laporan"}',
      { chatId: "owner" },
    );
    expect(result).toContain("untrusted-external-result");
    expect(result).toContain("Dokumen ditemukan");
    expect(callTool).toHaveBeenCalledWith("search", { query: "laporan" }, undefined);
    await adapter.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("caches discovery during the configured TTL", async () => {
    const listTools = vi.fn(async () => ({
      tools: [
        {
          name: "search",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    }));
    const adapter = new McpHttpCapabilityAdapter(
      connection({ cacheTtlMs: 60_000 }),
      createLogger(testConfig()),
      {},
      async () => ({
        listTools,
        async callTool() { return { content: [] }; },
        async close() {},
      }),
    );

    await adapter.list();
    await adapter.list();

    expect(listTools).toHaveBeenCalledOnce();
  });

  it("fails closed when a capability still requires approval", async () => {
    const adapter = new McpHttpCapabilityAdapter(
      connection({ allowedTools: [{ name: "search", riskClass: "read", approval: "always" }] }),
      createLogger(testConfig()),
      {},
      async () => ({
        async listTools() { return { tools: [] }; },
        async callTool() { return { content: [] }; },
        async close() {},
      }),
    );
    await expect(adapter.invoke("drive:search", "{}", { chatId: "owner" })).rejects.toThrow(
      "membutuhkan Approval",
    );
  });
});
