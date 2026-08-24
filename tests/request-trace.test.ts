import { describe, expect, it } from "vitest";
import { pruneUsageOlderThan, recordUsage } from "../src/db.js";
import {
  formatRequestTrace,
  RequestTraceService,
} from "../src/services/request-trace.js";
import { temporaryDatabase } from "./helpers.js";

describe("request tracing", () => {
  it("stores operational stages, tools, usage, and per-chat live preference", () => {
    const { database, cleanup } = temporaryDatabase();
    try {
      const traces = new RequestTraceService(database, false);
      expect(traces.isLiveEnabled("owner")).toBe(false);
      traces.setLiveEnabled("owner", true);
      expect(traces.isLiveEnabled("owner")).toBe(true);

      const started = traces.start("owner", "gpt-5-mini", "image");
      traces.addStage(started.requestId, "image_ready", "Gambar siap dianalisis");
      traces.addTool(started.requestId, "search_web");
      traces.addUsage(started.requestId, 120, 30);
      const completed = traces.finish(started.requestId, "completed");

      expect(completed).toMatchObject({
        chatId: "owner",
        model: "gpt-5-mini",
        inputKind: "image",
        status: "completed",
        tools: ["search_web"],
        inputTokens: 120,
        outputTokens: 30,
      });
      if (!completed) throw new Error("Trace should have completed");
      expect(formatRequestTrace(completed)).toContain("Gambar siap dianalisis");
      expect(traces.last("owner")?.requestId).toBe(started.requestId);
    } finally {
      cleanup();
    }
  });

  it("prunes usage events using the configured retention window", () => {
    const { database, cleanup } = temporaryDatabase();
    try {
      recordUsage(database, "chat", "gpt-test", 100, 20);
      database
        .prepare(
          `INSERT INTO usage_events(purpose, model, input_tokens, output_tokens, created_at)
           VALUES ('chat', 'gpt-test', 10, 2, datetime('now', '-91 days'))`,
        )
        .run();

      expect(pruneUsageOlderThan(database, 90)).toBe(1);
      expect(
        (database.prepare("SELECT count(*) AS count FROM usage_events").get() as { count: number })
          .count,
      ).toBe(1);
    } finally {
      cleanup();
    }
  });
});
