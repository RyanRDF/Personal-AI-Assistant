import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDashboard, stopDashboard } from "../src/dashboard/server.js";
import { createLogger } from "../src/logger.js";
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
});
