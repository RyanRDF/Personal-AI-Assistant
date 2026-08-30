import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { CapabilityDefinition, CapabilityHealth } from "../agent/capability.js";
import type { McpConnectionConfig } from "./config.js";

export interface McpCatalogRecorder {
  recordHealth(connectionId: string, health: CapabilityHealth): void;
  recordDiscovery(
    connection: McpConnectionConfig,
    definitions: CapabilityDefinition[],
  ): void;
}

export class McpCatalogStore implements McpCatalogRecorder {
  constructor(private readonly database: Database.Database) {}

  syncConnections(connections: McpConnectionConfig[]): void {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare("UPDATE mcp_connections SET status = 'disabled', updated_at = ?")
        .run(now);
      for (const connection of connections) {
        this.database
          .prepare(
            `INSERT INTO mcp_connections(
               id, label, server_url, auth_ref, status, allowed_tools_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               label = excluded.label,
               server_url = excluded.server_url,
               auth_ref = excluded.auth_ref,
               status = excluded.status,
               allowed_tools_json = excluded.allowed_tools_json,
               updated_at = excluded.updated_at`,
          )
          .run(
            connection.id,
            connection.label,
            connection.serverUrl,
            connection.authorizationEnv ?? null,
            connection.enabled ? "validating" : "disabled",
            JSON.stringify(connection.allowedTools),
            now,
            now,
          );
      }
    });
    transaction();
  }

  recordHealth(connectionId: string, health: CapabilityHealth): void {
    const status = health.status === "ready" ? "ready" : health.status === "disabled" ? "disabled" : "degraded";
    this.database
      .prepare("UPDATE mcp_connections SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), connectionId);
  }

  recordDiscovery(
    connection: McpConnectionConfig,
    definitions: CapabilityDefinition[],
  ): void {
    const discoveredAt = new Date();
    const expiresAt = new Date(discoveredAt.getTime() + connection.cacheTtlMs);
    const transaction = this.database.transaction(() => {
      this.database
        .prepare("UPDATE mcp_capabilities SET enabled = 0 WHERE connection_id = ?")
        .run(connection.id);
      for (const definition of definitions) {
        const remoteName = definition.id.slice(definition.id.indexOf(":") + 1);
        this.database
          .prepare(
            `INSERT INTO mcp_capabilities(
               connection_id, name, model_name, schema_hash, risk_class, approval,
               enabled, discovered_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(connection_id, name) DO UPDATE SET
               model_name = excluded.model_name,
               schema_hash = excluded.schema_hash,
               risk_class = excluded.risk_class,
               approval = excluded.approval,
               enabled = 1,
               discovered_at = excluded.discovered_at,
               expires_at = excluded.expires_at`,
          )
          .run(
            connection.id,
            remoteName,
            definition.modelName,
            createHash("sha256").update(JSON.stringify(definition.inputSchema)).digest("hex"),
            definition.riskClass,
            definition.approval,
            discoveredAt.toISOString(),
            expiresAt.toISOString(),
          );
      }
      this.database
        .prepare("UPDATE mcp_connections SET status = 'ready', updated_at = ? WHERE id = ?")
        .run(discoveredAt.toISOString(), connection.id);
    });
    transaction();
  }
}
