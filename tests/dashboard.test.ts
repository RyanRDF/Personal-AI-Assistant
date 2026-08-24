import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDashboard, stopDashboard } from "../src/dashboard/server.js";
import { recordUsage } from "../src/db.js";
import { createLogger } from "../src/logger.js";
import { RequestTraceService } from "../src/services/request-trace.js";
import { VaultService } from "../src/services/vault.js";
import { temporaryDatabase, testConfig } from "./helpers.js";

describe("vault dashboard", () => {
  let setup: ReturnType<typeof temporaryDatabase>;
  let server: Awaited<ReturnType<typeof startDashboard>>;
  let baseUrl: string;
  const authorization = `Basic ${Buffer.from("owner:dashboard-secret").toString("base64")}`;

  beforeEach(async () => {
    setup = temporaryDatabase();
    const config = {
      ...testConfig({ DASHBOARD_TOKEN: "dashboard-secret" }),
      PORT: 0,
    };
    server = await startDashboard(config, {
      database: setup.database,
      vault: new VaultService(setup.database, `${setup.directory}/vault`),
      logger: createLogger(config),
    });
    const port = (server!.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await stopDashboard(server);
    setup.cleanup();
  });

  it("keeps health public but protects vault data", async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect((await fetch(`${baseUrl}/api/items`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/observability`)).status).toBe(401);
    expect(
      (await fetch(`${baseUrl}/api/items`, { headers: { authorization } })).status,
    ).toBe(200);
  });

  it("creates folders, uploads files, and reports duplicate names", async () => {
    const folderResponse = await fetch(`${baseUrl}/api/folders`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ path: "Kerja/Invoice" }),
    });
    const folderBody = (await folderResponse.json()) as { item: { id: number } };
    expect(folderResponse.status).toBe(201);

    const upload = () =>
      fetch(`${baseUrl}/api/files`, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "text/plain",
          "x-file-name": encodeURIComponent("tagihan.txt"),
          "x-parent-id": String(folderBody.item.id),
        },
        body: "jatuh tempo tanggal 25",
      });
    expect((await upload()).status).toBe(201);
    expect((await upload()).status).toBe(409);

    const status = (await (
      await fetch(`${baseUrl}/api/status`, { headers: { authorization } })
    ).json()) as { vault: { files: number; folders: number } };
    expect(status.vault).toMatchObject({ files: 1, folders: 2 });
  });

  it("reports token, reliability, latency, and pseudonymous chat observability", async () => {
    const traces = new RequestTraceService(setup.database);
    const completed = traces.start("private-telegram-chat", "gpt-test", "text");
    traces.addTool(completed.requestId, "search_web");
    traces.addUsage(completed.requestId, 120, 30);
    traces.finish(completed.requestId, "completed");
    const failed = traces.start("private-telegram-chat", "gpt-test", "image");
    traces.addUsage(failed.requestId, 50, 0);
    traces.finish(failed.requestId, "failed", "upstream unavailable");
    recordUsage(setup.database, "chat", "gpt-test", 170, 30);

    const response = await fetch(`${baseUrl}/api/observability?days=7`, {
      headers: { authorization },
    });
    const body = (await response.json()) as {
      overview: {
        requests: number;
        completed: number;
        failed: number;
        inputTokens: number;
        outputTokens: number;
        successRate: number;
      };
      series: unknown[];
      chats: Array<{ chat: string }>;
      usage: Array<{ purpose: string; inputTokens: number }>;
      tools: Array<{ tool: string; calls: number }>;
      recent: Array<{ requestId: string; errorMessage: string | null }>;
    };

    expect(response.status).toBe(200);
    expect(body.overview).toMatchObject({
      requests: 2,
      completed: 1,
      failed: 1,
      inputTokens: 170,
      outputTokens: 30,
      successRate: 50,
    });
    expect(body.series).toHaveLength(7);
    expect(body.chats[0]?.chat).toMatch(/^Chat [A-F0-9]{8}$/u);
    expect(JSON.stringify(body.chats)).not.toContain("private-telegram-chat");
    expect(body.usage).toContainEqual(
      expect.objectContaining({ purpose: "chat", inputTokens: 170 }),
    );
    expect(body.tools).toContainEqual({ tool: "search_web", calls: 1 });
    expect(body.recent).toContainEqual(
      expect.objectContaining({ errorMessage: "upstream unavailable" }),
    );
  });

  it("serves the dedicated status view and hourly 24-hour series", async () => {
    const page = await fetch(baseUrl, { headers: { authorization } });
    expect(await page.text()).toContain('id="observabilityView"');

    const response = await fetch(`${baseUrl}/api/observability?days=1`, {
      headers: { authorization },
    });
    const body = (await response.json()) as {
      window: { days: number };
      overview: { requests: number; completed: number; failed: number; ratedRequests: number };
      series: unknown[];
    };
    expect(body.window.days).toBe(1);
    expect(body.overview).toMatchObject({
      requests: 0,
      completed: 0,
      failed: 0,
      ratedRequests: 0,
    });
    expect(body.series).toHaveLength(24);
  });
});
