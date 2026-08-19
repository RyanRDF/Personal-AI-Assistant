import { describe, expect, it } from "vitest";
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
});
