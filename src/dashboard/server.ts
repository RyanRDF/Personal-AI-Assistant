import { timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { safeErrorMessage, type AppLogger } from "../logger.js";
import {
  DuplicateVaultItemError,
  InvalidVaultOperationError,
  type Vault,
} from "../services/vault.js";
import { validateAttachment } from "../services/attachments.js";
import { observabilitySnapshot, parseObservabilityPeriod } from "./observability.js";
import { dashboardPage } from "./page.js";

interface DashboardDependencies {
  database: Database.Database;
  vault: Vault;
  logger: AppLogger;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  try {
    const credentials = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = credentials.indexOf(":");
    return separator >= 0 && safeEqual(credentials.slice(separator + 1), token);
  } catch {
    return false;
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new InvalidVaultOperationError("Ukuran request melebihi batas.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBody(request, 1_000_000);
  const parsed: unknown = JSON.parse(bytes.toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidVaultOperationError("Body JSON tidak valid.");
  }
  return parsed as Record<string, unknown>;
}

function nullableId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new InvalidVaultOperationError("ID folder tidak valid.");
  return id;
}

function publicItem(
  vault: Vault,
  item: NonNullable<ReturnType<Vault["get"]>> & { path?: string },
) {
  return {
    id: item.id,
    parentId: item.parentId,
    kind: item.kind,
    name: item.name,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    content: item.content,
    path: item.path ?? vault.pathFor(item.id),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function statusSnapshot(database: Database.Database, vault: Vault) {
  const counts = database
    .prepare(
      `SELECT
         (SELECT count(*) FROM memories) AS memories,
         (SELECT count(*) FROM messages) AS messages,
         (SELECT count(*) FROM email_rules WHERE enabled = 1) AS active_email_rules,
         (SELECT count(*) FROM request_traces WHERE status IN ('failed', 'timeout')) AS failed_requests`,
    )
    .get() as {
      memories: number;
      messages: number;
      active_email_rules: number;
      failed_requests: number;
    };
  return {
    ok: true,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    vault: vault.stats(),
    memories: counts.memories,
    conversationMessages: counts.messages,
    activeEmailRules: counts.active_email_rules,
    failedRequests: counts.failed_requests,
  };
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  config: AppConfig,
  dependencies: DashboardDependencies,
): Promise<boolean> {
  const { vault, database } = dependencies;
  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, statusSnapshot(database, vault));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/observability") {
    sendJson(
      response,
      200,
      observabilitySnapshot(
        database,
        parseObservabilityPeriod(url.searchParams.get("days")),
        config.DASHBOARD_TOKEN ?? config.TELEGRAM_BOT_TOKEN,
      ),
    );
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/items") {
    const parentId = nullableId(url.searchParams.get("parentId"));
    sendJson(response, 200, { items: vault.list(parentId).map((item) => publicItem(vault, item)) });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/search") {
    const query = url.searchParams.get("q")?.trim() ?? "";
    sendJson(response, 200, { items: vault.search(query, 50).map((item) => publicItem(vault, item)) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/folders") {
    const body = await readJson(request);
    const parentId = nullableId(body.parentId);
    const requestedPath = String(body.path ?? "").trim();
    if (!requestedPath) throw new InvalidVaultOperationError("Path folder wajib diisi.");
    const parentPath = parentId === null ? "" : vault.pathFor(parentId).slice(1);
    const folder = vault.ensureFolderPath([parentPath, requestedPath].filter(Boolean).join("/"));
    sendJson(response, 201, { item: folder ? publicItem(vault, folder) : null });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/notes") {
    const body = await readJson(request);
    const item = vault.saveNote(
      String(body.name ?? ""),
      String(body.content ?? ""),
      nullableId(body.parentId),
    );
    sendJson(response, 201, { item: publicItem(vault, item) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/files") {
    const encodedName = request.headers["x-file-name"];
    if (typeof encodedName !== "string") throw new InvalidVaultOperationError("Nama file wajib diisi.");
    const bytes = await readBody(request, config.VAULT_MAX_FILE_BYTES);
    const fileName = decodeURIComponent(encodedName);
    const claimedMimeType = request.headers["content-type"] ?? "application/octet-stream";
    const validated = await validateAttachment(
      {
        kind: "document",
        fileId: "dashboard-upload",
        fileUniqueId: "dashboard-upload",
        fileName,
        claimedMimeType,
      },
      bytes,
    );
    const item = await vault.saveFile({
      name: fileName,
      mimeType: validated.detectedMimeType,
      detectedMimeType: validated.detectedMimeType,
      mediaKind: "dashboard_upload",
      bytes: validated.bytes,
      parentId: nullableId(request.headers["x-parent-id"]),
    });
    sendJson(response, 201, { item: publicItem(vault, item) });
    return true;
  }

  const itemMatch = url.pathname.match(/^\/api\/items\/(\d+)(\/download)?$/u);
  if (!itemMatch?.[1]) return false;
  const id = Number(itemMatch[1]);
  const item = vault.get(id);
  if (!item) throw new InvalidVaultOperationError(`Item vault ${id} tidak ditemukan.`);
  if (request.method === "GET" && itemMatch[2] === "/download") {
    if (item.kind !== "file") throw new InvalidVaultOperationError("Item bukan file.");
    const file = await vault.readFile(id);
    response.writeHead(200, {
      "content-type": file.mimeType ?? "application/octet-stream",
      "content-length": file.sizeBytes,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
    });
    response.end(file.bytes);
    return true;
  }
  if (request.method === "PATCH" && !itemMatch[2]) {
    const body = await readJson(request);
    let updated = item;
    if (typeof body.name === "string") updated = vault.rename(id, body.name);
    if (body.folderPath !== undefined) {
      const folderPath = String(body.folderPath).trim();
      const parent = folderPath === "/" ? null : vault.resolveFolderPath(folderPath);
      if (folderPath !== "/" && !parent) {
        throw new InvalidVaultOperationError(`Folder ${folderPath} tidak ditemukan.`);
      }
      updated = vault.move(id, parent?.id ?? null);
    } else if (body.parentId !== undefined) {
      updated = vault.move(id, nullableId(body.parentId));
    }
    sendJson(response, 200, { item: publicItem(vault, updated) });
    return true;
  }
  if (request.method === "DELETE" && !itemMatch[2]) {
    sendJson(response, 200, { deleted: await vault.delete(id) });
    return true;
  }
  return false;
}

export async function startDashboard(
  config: AppConfig,
  dependencies: DashboardDependencies,
): Promise<http.Server | null> {
  if (!config.DASHBOARD_ENABLED) return null;
  const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(config.DASHBOARD_HOST);
  if (!isLoopback && !config.DASHBOARD_TOKEN) {
    throw new Error("DASHBOARD_TOKEN wajib diisi ketika dashboard dapat diakses dari jaringan.");
  }
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (!authorized(request, config.DASHBOARD_TOKEN)) {
        response.writeHead(401, {
          "www-authenticate": 'Basic realm="Personal AI Vault", charset="UTF-8"',
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("Autentikasi diperlukan.");
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(dashboardPage());
        return;
      }
      if (await handleApi(request, response, url, config, dependencies)) return;
      sendJson(response, 404, { error: "Endpoint tidak ditemukan." });
    })().catch((error: unknown) => {
      const message = safeErrorMessage(error);
      dependencies.logger.warn({ errorMessage: message }, "Dashboard request failed");
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status =
        error instanceof DuplicateVaultItemError ? 409 : error instanceof InvalidVaultOperationError ? 400 : 500;
      sendJson(response, status, { error: status === 500 ? "Terjadi kesalahan internal." : message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.PORT, config.DASHBOARD_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  dependencies.logger.info(
    { host: config.DASHBOARD_HOST, port: config.PORT, protected: Boolean(config.DASHBOARD_TOKEN) },
    "Vault dashboard started",
  );
  return server;
}

export async function stopDashboard(server: http.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
